// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Parser and validator for `*.theme.md` -- user theme files (theming Phase
//! 5, `docs/theming/README.md` / `docs/theming/decisions.md` S7). A theme
//! file starts from a built-in theme (`extends`) and may override its
//! colours (the same eighteen hex-only [`BrandPalette`] keys `brand.md`
//! sets) and a handful of structural, enum-only choices.
//!
//! ## Why this reuses `brand.rs` rather than duplicating it
//!
//! S7 is explicit: user themes get "the same security guarantees as
//! `brand.md`; no new attack surface class." That is only true if the two
//! formats share the actual code that enforces those guarantees, not two
//! independently-written approximations of it that can drift apart. This
//! module therefore reuses, unchanged, `crate::brand`'s:
//! - [`crate::brand::split_frontmatter`] -- the `+++` TOML frontmatter
//!   split, BOM/CRLF tolerant.
//! - [`crate::brand::find_unquoted_hex_hint`] -- the "you forgot to quote a
//!   hex colour" scan, which has to run before the TOML parser ever sees the
//!   text (see that function's own doc comment for why).
//! - [`crate::brand::classify_toml_error`] -- turns a generic "missing
//!   field" `toml` error into the same unquoted-hex hint, keyed off the
//!   eighteen palette field names.
//! - [`crate::brand::is_valid_hex_color`] / [`crate::brand::palette_fields`]
//!   -- the hex grammar itself and the ordered list of the eighteen keys.
//! - [`crate::brand::Severity`] / [`crate::brand::BrandIssue`] -- issues are
//!   reported in the exact same (field, message, severity) shape brand.md
//!   uses, so a caller handling one already knows how to handle the other.
//!
//! What is genuinely different for a user theme, and lives only here:
//! - A byte-size cap ([`MAX_USER_THEME_BYTES`]) -- `brand.md` has no such
//!   cap because it is authored once, deliberately, through Settings or a
//!   picked file; a `themes` folder is scanned unattended on every launch,
//!   so one adversarial or corrupted entry must not be able to make the app
//!   read an unbounded amount of text before it even reaches the TOML
//!   parser.
//! - `extends`, `name`, `description` -- fields `brand.md` has no
//!   equivalent of.
//! - Structure (`UserThemeStructure`) -- a closed set of enums the renderer
//!   maps to token values; there is no equivalent in `brand.md` at all.
//! - Alpha (`#rrggbbaa`) hex values are rejected outright, not merely
//!   accepted like `brand.md` does. See [`validate`] for why.
//! - A frontmatter `notes` key is rejected: notes come only from the
//!   Markdown body, exactly as they do for `brand.md`, but `brand.md`'s
//!   `Frontmatter` mirror type never had a `notes` field in the first place,
//!   so nothing there ever exercised that mistake. Here it is exercised (an
//!   author might reasonably expect the frontmatter to mirror the exported
//!   type, which does have a `notes` field), so the frontmatter mirror type
//!   below is deliberately narrower than [`UserTheme`] to reject it with a
//!   clear "unknown field" message rather than silently accepting a
//!   frontmatter value that would never be read back.
//!
//! ## No IO here
//!
//! Like [`crate::brand::parse`], [`parse_user_theme`] takes a `&str` and
//! returns a value -- reading `<id>.theme.md` off disk, deciding which
//! files in a directory even look like theme files, and turning a parse
//! failure into a listing entry are the desktop crate's job
//! (`apps/desktop/src-tauri/src/user_themes.rs`).

use crate::brand::{self, BrandIssue, Severity};
use crate::schema::{
    BrandPalette, UserTheme, UserThemePalettes, UserThemeStructure, USER_THEME_SCHEMA_VERSION,
};
use serde::Deserialize;
use thiserror::Error;

/// Hard byte cap on a `*.theme.md` source string. Unlike `brand.md` (see the
/// module doc comment), a `themes` directory is scanned unattended on every
/// launch, so this is the boundary that keeps one oversized or adversarial
/// file from making that scan read an unbounded amount of text.
pub const MAX_USER_THEME_BYTES: usize = 32 * 1024;

/// Everything that can go wrong turning a `*.theme.md` source string into a
/// validated [`UserTheme`]. Deliberately its own type rather than
/// [`crate::brand::BrandError`]: the two formats share the machinery that
/// produces these (see the module doc comment) but are different documents
/// with different fields, and folding them into one enum would either force
/// brand.md-only variants onto a theme-file caller or vice versa.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum UserThemeError {
    /// `source` is larger than [`MAX_USER_THEME_BYTES`]. Reported before any
    /// parsing is attempted -- see the module doc comment for why this cap
    /// exists at all.
    #[error("theme file is {size} bytes, over the {max} byte limit for user theme files")]
    TooLarge { size: usize, max: usize },
    /// The file does not open with a `+++` line at all -- there is no
    /// frontmatter to parse.
    #[error(
        "theme file has no +++ frontmatter -- the file must open with a line containing \
         exactly +++"
    )]
    MissingFrontmatter,
    /// The frontmatter delimiters were found but the TOML between them (or
    /// the document structure itself) failed to parse or deserialize.
    /// Carries a message intended to be shown to the author -- the same
    /// unquoted-hex and missing-key hints [`crate::brand`] attaches for
    /// `brand.md`.
    #[error("{0}")]
    Toml(String),
    /// `schemaVersion` is present and well-formed but not one this build
    /// understands. A half-understood theme is worse than none, so this is
    /// a hard error rather than a best-effort apply -- the same stance
    /// [`crate::brand::BrandError::UnsupportedVersion`] takes.
    #[error("theme schemaVersion {found} is not supported by this build (supported: {supported})")]
    UnsupportedVersion { found: u32, supported: u32 },
    /// The file parsed and deserialized but failed [`validate`]. Contains
    /// every issue found, not just the first -- an author fixing problems
    /// one at a time from a single error is a worse experience.
    #[error("theme file failed validation ({} issue(s))", .0.len())]
    Invalid(Vec<BrandIssue>),
}

/// Mirrors the frontmatter keys of a `*.theme.md` file. A separate type from
/// [`UserTheme`] for the same reason `brand.rs`'s private `Frontmatter`
/// mirror is separate from [`crate::schema::BrandConfig`]: `notes` is not a
/// frontmatter key, it comes from the Markdown body, so it is deliberately
/// absent here. `deny_unknown_fields` (inherited from `#[serde(deny_unknown_fields)]`
/// declared here, matching [`UserTheme`]'s own) is what turns a stray
/// `notes = "..."` in the frontmatter -- or any other typo'd key -- into a
/// clear "unknown field" error instead of silently accepting a value that
/// [`UserTheme`] would never actually read back.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Frontmatter {
    schema_version: u32,
    name: String,
    #[serde(default)]
    description: Option<String>,
    extends: String,
    #[serde(default)]
    palette: Option<UserThemePalettes>,
    #[serde(default)]
    structure: Option<UserThemeStructure>,
}

/// Parse a `*.theme.md` source string: reject it outright if it is over
/// [`MAX_USER_THEME_BYTES`], split the `+++` frontmatter from the Markdown
/// body (the body becomes [`UserTheme::notes`]), deserialize the frontmatter
/// as TOML, reject an unsupported `schemaVersion`, then run [`validate`].
///
/// Unlike [`crate::brand::parse`], there is no warnings tier: a user theme
/// file either names a valid, applicable theme or it does not, and the
/// desktop-crate loader (`apps/desktop/src-tauri/src/user_themes.rs`) turns
/// any `Err` here into a listing entry with `theme: None, error: Some(..)`
/// rather than losing the file.
pub fn parse_user_theme(source: &str) -> Result<UserTheme, UserThemeError> {
    if source.len() > MAX_USER_THEME_BYTES {
        return Err(UserThemeError::TooLarge {
            size: source.len(),
            max: MAX_USER_THEME_BYTES,
        });
    }

    let (frontmatter_src, notes) =
        brand::split_frontmatter(source, "theme file").map_err(convert_split_error)?;

    if let Some(hint) = brand::find_unquoted_hex_hint(frontmatter_src, "theme file") {
        return Err(UserThemeError::Toml(hint));
    }

    let frontmatter: Frontmatter = toml::from_str(frontmatter_src)
        .map_err(|err| UserThemeError::Toml(brand::classify_toml_error(err).to_string()))?;

    if frontmatter.schema_version != USER_THEME_SCHEMA_VERSION {
        return Err(UserThemeError::UnsupportedVersion {
            found: frontmatter.schema_version,
            supported: USER_THEME_SCHEMA_VERSION,
        });
    }

    let theme = UserTheme {
        schema_version: frontmatter.schema_version,
        name: frontmatter.name,
        description: frontmatter.description,
        extends: frontmatter.extends,
        palette: frontmatter.palette,
        structure: frontmatter.structure,
        notes,
    };

    let issues = validate(&theme);
    if !issues.is_empty() {
        return Err(UserThemeError::Invalid(issues));
    }

    Ok(theme)
}

/// [`crate::brand::split_frontmatter`] returns [`crate::brand::BrandError`]
/// (it is shared with `brand.rs`'s own callers); this maps that back onto
/// [`UserThemeError`]'s narrower vocabulary. Every variant it can actually
/// return for this call site is handled by name; the wildcard exists only
/// because `BrandError` is `#[non_exhaustive]`-adjacent in spirit (more
/// variants may be added for brand.md's own needs) and a parse helper for
/// theme files should not fail to compile because brand.md grew an unrelated
/// error case.
fn convert_split_error(err: brand::BrandError) -> UserThemeError {
    match err {
        brand::BrandError::MissingFrontmatter => UserThemeError::MissingFrontmatter,
        brand::BrandError::Toml(msg) => UserThemeError::Toml(msg),
        other => UserThemeError::Toml(other.to_string()),
    }
}

/// Display name in the theme picker: 1-48 characters after trimming, no
/// control characters.
const NAME_MAX_LEN: usize = 48;
/// One line under the name: at most 160 characters, no control characters.
const DESCRIPTION_MAX_LEN: usize = 160;
/// `extends` grammar: lowercase alphanumerics and hyphens, 1-40 characters.
/// Hand-rolled (no `regex` crate) -- see [`crate::brand::is_valid_hex_color`]'s
/// doc comment for why a closed, fixed-shape grammar does not need one.
const EXTENDS_MAX_LEN: usize = 40;

/// Validate an already-built [`UserTheme`]. Pure; no IO. Runs every check and
/// returns every finding rather than stopping at the first, the same
/// discipline [`crate::brand::validate`] follows for `brand.md`.
///
/// Every issue returned here is [`Severity::Error`] -- there is no warnings
/// tier for user theme files (see [`parse_user_theme`]'s doc comment).
pub fn validate(theme: &UserTheme) -> Vec<BrandIssue> {
    let mut issues = Vec::new();

    if theme.schema_version != USER_THEME_SCHEMA_VERSION {
        // `parse_user_theme` already turns a version mismatch into a hard
        // `UnsupportedVersion` before this ever runs, but `validate` is also
        // `pub` and may be called directly (e.g. by a future in-app editor
        // that wants live validation of a `UserTheme` it already has in
        // memory), so this is checked again rather than assumed.
        issues.push(BrandIssue {
            field: "schemaVersion".to_string(),
            message: format!(
                "must be {USER_THEME_SCHEMA_VERSION} (this build does not understand any other \
                 version)"
            ),
            severity: Severity::Error,
        });
    }

    validate_name(&theme.name, &mut issues);
    if let Some(description) = &theme.description {
        validate_description(description, &mut issues);
    }
    validate_extends(&theme.extends, &mut issues);

    if let Some(palettes) = &theme.palette {
        validate_palettes(palettes, &mut issues);
    }

    issues
}

fn validate_name(name: &str, issues: &mut Vec<BrandIssue>) {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        issues.push(BrandIssue {
            field: "name".to_string(),
            message: "must not be empty".to_string(),
            severity: Severity::Error,
        });
        return;
    }
    if trimmed.chars().count() > NAME_MAX_LEN {
        issues.push(BrandIssue {
            field: "name".to_string(),
            message: format!("must be at most {NAME_MAX_LEN} characters"),
            severity: Severity::Error,
        });
    }
    if trimmed.chars().any(is_control_char) {
        issues.push(BrandIssue {
            field: "name".to_string(),
            message: "must not contain control characters".to_string(),
            severity: Severity::Error,
        });
    }
}

fn validate_description(description: &str, issues: &mut Vec<BrandIssue>) {
    if description.chars().count() > DESCRIPTION_MAX_LEN {
        issues.push(BrandIssue {
            field: "description".to_string(),
            message: format!("must be at most {DESCRIPTION_MAX_LEN} characters"),
            severity: Severity::Error,
        });
    }
    if description.chars().any(is_control_char) {
        issues.push(BrandIssue {
            field: "description".to_string(),
            message: "must not contain control characters".to_string(),
            severity: Severity::Error,
        });
    }
}

/// `\t`, `\n`, `\r` and the rest of the C0/C1 control ranges. `char::is_control`
/// already covers exactly this (it is not merely ASCII, but every value a
/// hostile or corrupted string could carry here is well within its range).
fn is_control_char(c: char) -> bool {
    c.is_control()
}

/// `^[a-z0-9-]{1,40}$`, hand-rolled for the same reason
/// [`crate::brand::is_valid_hex_color`] is: a fixed, closed grammar gains
/// nothing from a regex engine but a new dependency.
fn validate_extends(extends: &str, issues: &mut Vec<BrandIssue>) {
    let len_ok = !extends.is_empty() && extends.chars().count() <= EXTENDS_MAX_LEN;
    let chars_ok = !extends.is_empty()
        && extends
            .chars()
            .all(|c| matches!(c, 'a'..='z' | '0'..='9' | '-'));
    if !len_ok || !chars_ok {
        issues.push(BrandIssue {
            field: "extends".to_string(),
            message: format!(
                "`{extends}` is not a valid theme id -- must be 1-{EXTENDS_MAX_LEN} characters, \
                 lowercase letters, digits, and hyphens only (e.g. `graphite`, \
                 `amber-terminal`)"
            ),
            severity: Severity::Error,
        });
    }
}

/// At least one of `dark`/`light` must be present when `[palette]` appears
/// at all -- an empty `[palette]` table overrides nothing and is either a
/// mistake or dead weight, exactly like an author writing `[logo]` with no
/// `file` key. Each present mode's colours are then validated exactly like a
/// `brand.md` palette (hex-only, all eighteen keys), plus one restriction
/// `brand.md` does not have: see [`validate_no_alpha`].
fn validate_palettes(palettes: &UserThemePalettes, issues: &mut Vec<BrandIssue>) {
    if palettes.dark.is_none() && palettes.light.is_none() {
        issues.push(BrandIssue {
            field: "palette".to_string(),
            message: "must specify at least one of [palette.dark] or [palette.light] -- an \
                      empty palette table overrides nothing"
                .to_string(),
            severity: Severity::Error,
        });
        return;
    }

    if let Some(dark) = &palettes.dark {
        validate_palette_mode("palette.dark", dark, issues);
    }
    if let Some(light) = &palettes.light {
        validate_palette_mode("palette.light", light, issues);
    }
}

fn validate_palette_mode(prefix: &str, palette: &BrandPalette, issues: &mut Vec<BrandIssue>) {
    for (name, value) in brand::palette_fields(palette) {
        if !brand::is_valid_hex_color(value) {
            issues.push(BrandIssue {
                field: format!("{prefix}.{name}"),
                message: format!(
                    "`{value}` is not a hex colour (#rgb or #rrggbb are the only accepted \
                     forms for a user theme -- no url(...), var(...), rgb(...), named colours, \
                     or 8-digit alpha hex). If this value is empty, `#` starting a comment in \
                     TOML is the likely cause -- did you forget to quote the hex value?"
                ),
                severity: Severity::Error,
            });
            continue;
        }
        validate_no_alpha(prefix, name, value, issues);
    }
}

/// Rejects an otherwise-valid 8-digit `#rrggbbaa` hex value.
///
/// `brand.md` accepts alpha (see [`BrandPalette`]'s own doc comment: "hex
/// only (`#rgb`, `#rrggbb`, `#rrggbbaa`)") because a brand's palette *is*
/// the app's full colour system for every surface it touches -- there is
/// nothing behind it for a translucent value to composite against that the
/// brand itself doesn't already control. A user theme's palette overrides
/// sit on top of a base theme (`extends`) it does not otherwise change, so a
/// translucent `bg`/`card`/`ink` would composite against whatever the base
/// theme's structure put underneath it -- unpredictable per look, and
/// exactly the kind of contrast-math case tokenContrast.test.ts's own
/// history (P3.2, and the "specificity trap" `BrandThemes`' doc comment
/// describes) says is not safe to leave unverified. Keeping user themes
/// opaque-only sidesteps that entirely rather than trying to model it.
fn validate_no_alpha(prefix: &str, name: &str, value: &str, issues: &mut Vec<BrandIssue>) {
    let hex_len = value.trim_start_matches('#').len();
    if hex_len == 8 {
        issues.push(BrandIssue {
            field: format!("{prefix}.{name}"),
            message: format!(
                "`{value}` is an 8-digit (#rrggbbaa) hex colour -- user themes accept only \
                 #rgb or #rrggbb. An alpha surface colour breaks contrast math against a base \
                 theme's structure, so alpha is not allowed here even though brand.md permits it"
            ),
            severity: Severity::Error,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::{ThemeCorners, ThemeFace, ThemeIconStroke};

    const MINIMAL_VALID: &str = r##"+++
schemaVersion = 1
name = "My Theme"
extends = "graphite"
+++
"##;

    const FULL_VALID: &str = r##"+++
schemaVersion = 1
name = "My Theme"
description = "A warm variant of Graphite."
extends = "graphite"

[structure]
corners = "rounded"
uiFont = "sans"
readingFont = "serif"
labels = "uppercase"
shadows = "soft"
motion = "standard"
iconStroke = "regular"

[palette.dark]
bg       = "#0F1115"
bgSide   = "#0B0D11"
card     = "#161A21"
cardHi   = "#1D222B"
line     = "#252B36"
lineSoft = "#1D222B"
lineHi   = "#2E3542"
ink      = "#E8EAED"
ink2     = "#A8AEB8"
ink3     = "#8790A0"
hue      = "#E4572E"
hueText  = "#FF8A61"
hueSolid = "#B8441F"
onHue    = "#FFFFFF"
ok       = "#3FB950"
warn     = "#D29922"
err      = "#F85149"
link     = "#58A6FF"
+++

Some design notes.
"##;

    #[test]
    fn minimal_valid_theme_parses() {
        let theme = parse_user_theme(MINIMAL_VALID).expect("minimal theme should parse");
        assert_eq!(theme.name, "My Theme");
        assert_eq!(theme.extends, "graphite");
        assert!(theme.palette.is_none());
        assert!(theme.structure.is_none());
        assert!(theme.notes.is_none());
    }

    #[test]
    fn full_theme_parses() {
        let theme = parse_user_theme(FULL_VALID).expect("full theme should parse");
        assert_eq!(
            theme.description.as_deref(),
            Some("A warm variant of Graphite.")
        );
        let structure = theme.structure.expect("structure should be present");
        assert_eq!(structure.corners, Some(ThemeCorners::Rounded));
        assert_eq!(structure.ui_font, Some(ThemeFace::Sans));
        assert_eq!(structure.icon_stroke, Some(ThemeIconStroke::Regular));
        let palette = theme.palette.expect("palette should be present");
        assert!(palette.dark.is_some());
        assert!(palette.light.is_none());
        assert_eq!(theme.notes.as_deref(), Some("Some design notes."));
    }

    #[test]
    fn bom_and_crlf_are_tolerated() {
        let bom_source = format!("\u{FEFF}{MINIMAL_VALID}");
        parse_user_theme(&bom_source).expect("BOM-prefixed theme should parse");

        let crlf_source = MINIMAL_VALID.replace('\n', "\r\n");
        parse_user_theme(&crlf_source).expect("CRLF theme should parse");
    }

    #[test]
    fn missing_frontmatter_is_rejected() {
        let err = parse_user_theme("# just markdown, no frontmatter").unwrap_err();
        assert_eq!(err, UserThemeError::MissingFrontmatter);
    }

    #[test]
    fn unterminated_frontmatter_is_rejected() {
        let err = parse_user_theme("+++\nschemaVersion = 1\n").unwrap_err();
        match err {
            UserThemeError::Toml(msg) => assert!(msg.contains("not terminated"), "message: {msg}"),
            other => panic!("expected Toml(..), got {other:?}"),
        }
    }

    #[test]
    fn unknown_top_level_key_is_rejected() {
        let source = MINIMAL_VALID.replace(
            "extends = \"graphite\"",
            "extends = \"graphite\"\nbogusKey = \"x\"",
        );
        let err = parse_user_theme(&source).unwrap_err();
        match err {
            UserThemeError::Toml(msg) => assert!(msg.contains("bogusKey"), "message: {msg}"),
            other => panic!("expected Toml(..), got {other:?}"),
        }
    }

    #[test]
    fn unknown_structure_key_is_rejected() {
        let source = FULL_VALID.replace("corners = \"rounded\"", "cornrs = \"rounded\"");
        let err = parse_user_theme(&source).unwrap_err();
        match err {
            UserThemeError::Toml(msg) => assert!(msg.contains("cornrs"), "message: {msg}"),
            other => panic!("expected Toml(..), got {other:?}"),
        }
    }

    #[test]
    fn bad_enum_value_is_rejected() {
        let source = FULL_VALID.replace("corners = \"rounded\"", "corners = \"round\"");
        let err = parse_user_theme(&source).unwrap_err();
        match err {
            UserThemeError::Toml(msg) => {
                assert!(
                    msg.contains("corners") || msg.contains("round"),
                    "message: {msg}"
                );
            }
            other => panic!("expected Toml(..), got {other:?}"),
        }
    }

    #[test]
    fn bad_hex_is_rejected() {
        let source = FULL_VALID.replace("bg       = \"#0F1115\"", "bg       = \"not-a-colour\"");
        let err = parse_user_theme(&source).unwrap_err();
        match err {
            UserThemeError::Invalid(issues) => {
                assert!(issues
                    .iter()
                    .any(|i| i.field == "palette.dark.bg" && i.severity == Severity::Error));
            }
            other => panic!("expected Invalid(..), got {other:?}"),
        }
    }

    #[test]
    fn eight_digit_alpha_hex_is_rejected() {
        let source = FULL_VALID.replace("bg       = \"#0F1115\"", "bg       = \"#0F1115FF\"");
        let err = parse_user_theme(&source).unwrap_err();
        match err {
            UserThemeError::Invalid(issues) => {
                assert!(issues.iter().any(|i| i.field == "palette.dark.bg"
                    && i.message.contains("alpha")
                    && i.severity == Severity::Error));
            }
            other => panic!("expected Invalid(..), got {other:?}"),
        }
    }

    #[test]
    fn unquoted_hex_gets_a_specific_hint() {
        let source = FULL_VALID.replace("bg       = \"#0F1115\"", "bg       = #0F1115");
        let err = parse_user_theme(&source).unwrap_err();
        match err {
            UserThemeError::Toml(msg) => {
                assert!(msg.contains("quote the hex value"), "message: {msg}");
                assert!(
                    !msg.contains("brand.md"),
                    "message should not say brand.md: {msg}"
                );
            }
            other => panic!("expected Toml(..), got {other:?}"),
        }
    }

    #[test]
    fn empty_palette_table_is_rejected() {
        let source = MINIMAL_VALID.replace(
            "extends = \"graphite\"",
            "extends = \"graphite\"\n\n[palette]\n",
        );
        let err = parse_user_theme(&source).unwrap_err();
        match err {
            UserThemeError::Invalid(issues) => {
                assert!(issues.iter().any(|i| i.field == "palette"));
            }
            other => panic!("expected Invalid(..), got {other:?}"),
        }
    }

    #[test]
    fn version_mismatch_is_rejected() {
        let source = MINIMAL_VALID.replace("schemaVersion = 1", "schemaVersion = 2");
        let err = parse_user_theme(&source).unwrap_err();
        assert_eq!(
            err,
            UserThemeError::UnsupportedVersion {
                found: 2,
                supported: USER_THEME_SCHEMA_VERSION
            }
        );
    }

    #[test]
    fn name_too_long_is_rejected() {
        let source = MINIMAL_VALID.replace("\"My Theme\"", &format!("\"{}\"", "x".repeat(49)));
        let err = parse_user_theme(&source).unwrap_err();
        match err {
            UserThemeError::Invalid(issues) => {
                assert!(issues.iter().any(|i| i.field == "name"));
            }
            other => panic!("expected Invalid(..), got {other:?}"),
        }
    }

    #[test]
    fn name_with_control_chars_is_rejected() {
        let source = MINIMAL_VALID.replace("\"My Theme\"", "\"My\\tTheme\"");
        let err = parse_user_theme(&source).unwrap_err();
        match err {
            UserThemeError::Invalid(issues) => {
                assert!(issues.iter().any(|i| i.field == "name"));
            }
            other => panic!("expected Invalid(..), got {other:?}"),
        }
    }

    #[test]
    fn extends_grammar_rejects_traversal_uppercase_and_empty() {
        for bad in ["../x", "Graphite", ""] {
            let source =
                MINIMAL_VALID.replace("extends = \"graphite\"", &format!("extends = \"{bad}\""));
            let err = parse_user_theme(&source).unwrap_err();
            match err {
                UserThemeError::Invalid(issues) => {
                    assert!(
                        issues.iter().any(|i| i.field == "extends"),
                        "expected an extends issue for {bad:?}, got {issues:?}"
                    );
                }
                other => panic!("expected Invalid(..) for {bad:?}, got {other:?}"),
            }
        }
    }

    #[test]
    fn size_cap_is_enforced() {
        let oversized = format!(
            "+++\nschemaVersion = 1\nname = \"x\"\nextends = \"graphite\"\n# {}\n+++\n",
            "a".repeat(MAX_USER_THEME_BYTES)
        );
        let err = parse_user_theme(&oversized).unwrap_err();
        match err {
            UserThemeError::TooLarge { .. } => {}
            other => panic!("expected TooLarge, got {other:?}"),
        }
    }

    #[test]
    fn notes_body_is_preserved_verbatim() {
        let theme = parse_user_theme(FULL_VALID).unwrap();
        assert_eq!(theme.notes.as_deref(), Some("Some design notes."));
    }

    #[test]
    fn frontmatter_notes_key_is_rejected() {
        let source = MINIMAL_VALID.replace(
            "extends = \"graphite\"",
            "extends = \"graphite\"\nnotes = \"sneaky\"",
        );
        let err = parse_user_theme(&source).unwrap_err();
        match err {
            UserThemeError::Toml(msg) => assert!(msg.contains("notes"), "message: {msg}"),
            other => panic!("expected Toml(..), got {other:?}"),
        }
    }
}
