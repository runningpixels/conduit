// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Parser and validator for `brand.md` -- the shared white-label format
//! described in `docs/private/white-label-plan.md` section 2.
//!
//! ## Why `+++` TOML frontmatter, not `---` YAML
//!
//! `serde_yaml` is archived/unmaintained and this workspace runs `cargo-deny`
//! on advisories in CI, so a YAML dependency would fail the supply-chain gate
//! outright. `toml` is already pulled into `Cargo.lock` transitively (it is
//! Tauri's own config format), so promoting it to a direct dependency here
//! adds nothing new to the dependency graph. `+++` frontmatter is the Hugo
//! convention.
//!
//! ## Why the frontmatter is normative and the body is not
//!
//! A loader (a later phase, in the desktop crate) only ever needs the
//! frontmatter -- it is the sole input to a runtime `applyBrand()`-style
//! consumer. The Markdown body is design rationale for humans, and for an
//! LLM asked to revise the theme later, so it is preserved verbatim in
//! [`BrandConfig::notes`] rather than parsed.
//!
//! ## Why validation lives here rather than purely in the type system
//!
//! `BrandPalette`/`BrandThemes` in `schema.rs` already enforce shape (all 18
//! keys required, both themes required) at the type level -- a config that
//! fails to deserialize never reaches [`validate`]. What [`validate`] adds is
//! the checks Rust's type system cannot express on its own: hex-only
//! *values* (not just `String`-typed fields), a bare-filename grammar for
//! the logo (a path-traversal boundary, since the loader joins it to the
//! brand directory), sane length bounds on free-text identity fields, and
//! WCAG contrast, which is numeric and has no type-level representation at
//! all.
//!
//! ## No IO here
//!
//! [`parse`] takes a `&str`. Reading `brand.md` off disk, resolving
//! `logo.file` against the brand directory, and surfacing warnings in the UI
//! are the desktop crate's job (Mode A) or the `apply_brand` example's job
//! (Mode B, build time). Keeping this module IO-free is what lets both
//! consumers share it without linking against Tauri or `std::fs` specifics.

use crate::schema::{
    BrandBundle, BrandConfig, BrandFonts, BrandIdentity, BrandLogo, BrandPalette, BrandRuntime,
    BrandThemes, BrandUpdater, BRAND_SCHEMA_VERSION,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

// =============================================================================
// Issues
// =============================================================================

/// How serious a [`BrandIssue`] is. Only [`Severity::Error`] blocks [`parse`]
/// from returning a config; [`Severity::Warning`] is surfaced to the caller
/// alongside a valid config.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

/// One validation finding, scoped to a dotted field path (e.g.
/// `"palette.dark.ink"`, `"logo.file"`) so a caller can point a UI at the
/// offending field rather than just showing prose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrandIssue {
    pub field: String,
    pub message: String,
    pub severity: Severity,
}

/// Everything that can go wrong turning `brand.md` source text into a
/// validated [`BrandConfig`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum BrandError {
    /// The file does not open with a `+++` line at all -- there is no
    /// frontmatter to parse.
    #[error(
        "brand.md has no +++ frontmatter -- the file must open with a line containing exactly +++"
    )]
    MissingFrontmatter,
    /// The frontmatter delimiters were found but the TOML between them (or
    /// the document structure itself, e.g. an unterminated frontmatter
    /// block) failed to parse. Carries a message intended to be shown to the
    /// author, not just logged -- see the unquoted-hex and dark/light hints
    /// in [`classify_toml_error`].
    #[error("{0}")]
    Toml(String),
    /// `schemaVersion` is present and well-formed but not one this build
    /// understands. Per the doc comment on [`BRAND_SCHEMA_VERSION`], a
    /// half-understood brand is worse than none, so this is a hard error
    /// rather than a best-effort apply.
    #[error(
        "brand.md schemaVersion {found} is not supported by this build (supported: {supported})"
    )]
    UnsupportedVersion { found: u32, supported: u32 },
    /// The config parsed and deserialized but failed [`validate`]. Contains
    /// only [`Severity::Error`] issues -- warnings never block [`parse`].
    #[error("brand.md failed validation ({} issue(s))", .0.len())]
    Invalid(Vec<BrandIssue>),
}

// =============================================================================
// Frontmatter split
// =============================================================================

/// Byte-offset scan over `source`'s lines rather than a `split('\n')` +
/// rejoin, so the body can be sliced out of the original string verbatim
/// (preserving whatever line endings it already had) instead of being
/// reconstructed from parts that may have been normalized along the way.
fn split_frontmatter(source: &str) -> Result<(&str, Option<String>), BrandError> {
    // A BOM is common on Windows-authored files and is not part of the `+++`
    // delimiter; strip it before anything else so the very first line still
    // matches exactly.
    let source = source.strip_prefix('\u{FEFF}').unwrap_or(source);

    let mut lines = source.split_inclusive('\n');

    let first = lines.next().ok_or(BrandError::MissingFrontmatter)?;
    if !is_delimiter_line(first) {
        return Err(BrandError::MissingFrontmatter);
    }

    // `pos` tracks the byte offset of the start of the line currently being
    // considered, so that once a closing delimiter is found the frontmatter
    // slice can be taken directly out of `source` without rebuilding it.
    let mut pos = first.len();
    let fm_start = pos;

    loop {
        let line = lines.next().ok_or_else(|| {
            BrandError::Toml(
                "brand.md frontmatter is not terminated -- expected a line containing exactly \
                 +++ before the document ends"
                    .to_string(),
            )
        })?;
        if is_delimiter_line(line) {
            let fm_end = pos;
            let body_start = pos + line.len();
            let frontmatter = &source[fm_start..fm_end];
            let body = source[body_start..].trim();
            let notes = if body.is_empty() {
                None
            } else {
                Some(body.to_string())
            };
            return Ok((frontmatter, notes));
        }
        pos += line.len();
    }
}

/// A delimiter line is `+++`, allowing for a trailing `\r` (CRLF) and
/// trailing whitespace before the line terminator -- both are easy for a
/// human editor to introduce without meaning to break the file.
fn is_delimiter_line(line: &str) -> bool {
    line.trim_end_matches(['\n', '\r']).trim_end() == "+++"
}

// =============================================================================
// Surgical frontmatter edits
// =============================================================================
//
// Everything in this section exists because the obvious implementation of
// "change one field of brand.md" -- deserialize into `Frontmatter`, mutate
// the field, `toml::to_string` it back out -- is exactly wrong for this
// format. `toml::from_str` never captures comments, blank-line spacing, or
// key order in the first place, so re-serializing from the parsed struct
// would silently discard whatever the author wrote around every *other*
// value, defeating the entire reason `brand.md` is hand-editable Markdown
// instead of a JSON blob (see the module doc comment).
//
// The primitives below perform byte-level text edits instead: they locate a
// `[section]` table and a `key` within it by scanning lines, and change only
// the minimal span of text a new value requires, leaving every other byte --
// other keys, comments, blank-line spacing, and the entire Markdown body --
// untouched. [`set_logo_reference`]/[`clear_logo_reference`] were the first,
// narrow callers (one hardcoded section, one hardcoded key);
// [`merge_brand_edits`] is what forced them to grow into general (section,
// key) primitives, since applying a whole `BrandConfig` touches `[identity]`,
// `[logo]`, and both palette tables, not just one field.

/// Byte-offset walk over `text`'s lines (each slice includes its own line
/// terminator, if any), paired with the byte offset its first character
/// starts at. [`find_section`] and [`find_key_line`] both work in terms of
/// absolute offsets into the text they were given, rather than re-deriving
/// them by hand, so they share this one line-walking primitive.
fn line_spans(text: &str) -> impl Iterator<Item = (usize, &str)> {
    let mut pos = 0;
    text.split_inclusive('\n').map(move |line| {
        let start = pos;
        pos += line.len();
        (start, line)
    })
}

/// Same delimiter scan as [`split_frontmatter`], but returns the byte range
/// of the frontmatter *within the original, unmodified `source`* (BOM
/// included) instead of a copied slice. [`split_frontmatter`] only ever
/// needs to read the frontmatter; [`set_logo_reference`] needs offsets it
/// can splice a replacement into, which a slice alone cannot provide.
fn frontmatter_span(source: &str) -> Result<std::ops::Range<usize>, BrandError> {
    // `pos`/`fm_start` below are offsets into `source` itself, so the BOM's
    // byte length (if present) has to be added back in rather than scanning
    // a BOM-stripped copy the way `split_frontmatter` does -- an offset
    // computed against a stripped copy would be wrong by exactly that many
    // bytes once used to index back into `source`.
    let bom_len = if source.starts_with('\u{FEFF}') {
        '\u{FEFF}'.len_utf8()
    } else {
        0
    };
    let rest = &source[bom_len..];

    let mut lines = rest.split_inclusive('\n');
    let first = lines.next().ok_or(BrandError::MissingFrontmatter)?;
    if !is_delimiter_line(first) {
        return Err(BrandError::MissingFrontmatter);
    }

    let mut pos = bom_len + first.len();
    let fm_start = pos;
    loop {
        let line = lines.next().ok_or_else(|| {
            BrandError::Toml(
                "brand.md frontmatter is not terminated -- expected a line containing exactly \
                 +++ before the document ends"
                    .to_string(),
            )
        })?;
        if is_delimiter_line(line) {
            return Ok(fm_start..pos);
        }
        pos += line.len();
    }
}

/// The byte range of a top-level TOML table's *body*: everything after its
/// `[name]` header line up to (but not including) the next top-level
/// `[...]` header line, or the end of `text` if there isn't one. Line-based
/// rather than a real TOML walk, because this module never needs to
/// understand what the table contains -- only where to splice around it.
fn find_section(text: &str, name: &str) -> Option<std::ops::Range<usize>> {
    let header = format!("[{name}]");
    let mut lines = line_spans(text);
    let body_start = loop {
        let (start, line) = lines.next()?;
        if line.trim() == header {
            break start + line.len();
        }
    };
    let mut body_end = text.len();
    for (start, line) in lines {
        if line.trim_start().starts_with('[') {
            body_end = start;
            break;
        }
    }
    Some(body_start..body_end)
}

/// The byte range (including its line terminator) of the line inside `text`
/// that assigns `key`, e.g. `file = "logo.png"`. Skips comment and blank
/// lines rather than matching on them.
fn find_key_line(text: &str, key: &str) -> Option<std::ops::Range<usize>> {
    for (start, line) in line_spans(text) {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let eq = line.find('=')?;
        if line[..eq].trim() == key {
            return Some(start..start + line.len());
        }
    }
    None
}

/// Replace only the quoted value on a `key = "..."` line, preserving
/// everything else on it -- indentation before the key, the key's own
/// spelling, alignment whitespace, and any trailing inline comment -- byte
/// for byte. `key` is only used for the no-well-formed-value fallback below;
/// the normal path finds the value purely by locating the quotes.
/// Escape a value for a TOML *basic* string (the `"..."` form these
/// primitives emit).
///
/// The surgical writers below build `key = "value"` with `format!`, so an
/// unescaped `"` or `\` in the value ends the string early and produces a file
/// that no longer parses. That is not hypothetical: `app_name`, `display_name`
/// and `tagline` are free text typed into Settings, and `check_identity_field`
/// deliberately bounds only length and emptiness, not character content.
///
/// [`render_brand_md`] never had this problem because it goes through
/// `toml::to_string`, which escapes for us; only the merge path builds TOML by
/// hand. `brand_emit::render_generated_ts` reached the same conclusion for its
/// own hand-built output and solved it with `serde_json::to_string` — this is
/// the TOML-side counterpart of that reasoning.
///
/// Escapes exactly what the TOML spec requires of a basic string: backslash,
/// double quote, and the control characters, using the named escapes where
/// they exist and `\uXXXX` otherwise.
fn escape_toml_basic(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            // The remaining control characters have no named escape and are
            // not legal raw inside a basic string.
            c if (c as u32) < 0x20 || c as u32 == 0x7f => {
                out.push_str(&format!("\\u{:04X}", c as u32));
            }
            c => out.push(c),
        }
    }
    out
}

fn replace_quoted_value(line: &str, key: &str, new_value: &str) -> String {
    if let Some(eq) = line.find('=') {
        let (before, after_eq) = line.split_at(eq + 1);
        if let Some(q1) = after_eq.find('"') {
            if let Some(q2_rel) = after_eq[q1 + 1..].find('"') {
                let q2 = q1 + 1 + q2_rel;
                let prefix = &after_eq[..q1];
                let suffix = &after_eq[q2 + 1..];
                let escaped = escape_toml_basic(new_value);
                return format!("{before}{prefix}\"{escaped}\"{suffix}");
            }
        }
    }
    // Line was hand-edited into a shape with no well-formed `= "..."` --
    // rebuild it with the new value, keeping only the line's own terminator.
    let terminator: String = line
        .chars()
        .rev()
        .take_while(|c| matches!(c, '\n' | '\r'))
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("{key} = \"{}\"{terminator}", escape_toml_basic(new_value))
}

/// `"\r\n"` if `source` uses CRLF line endings anywhere, else `"\n"`. Text
/// this module inserts (a new `file = "..."` line, or a whole new `[logo]`
/// section) is built with plain `\n` and then only ever spliced in using
/// this constant, so an inserted line matches the rest of the document's
/// convention instead of mixing endings within one file.
fn newline_style(source: &str) -> &'static str {
    if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn splice(text: &str, range: std::ops::Range<usize>, replacement: &str) -> String {
    format!(
        "{}{}{}",
        &text[..range.start],
        replacement,
        &text[range.end..]
    )
}

/// Set `key = "value"` inside `[section]` in `source`'s frontmatter,
/// touching only the bytes that make up that one value. If `section` exists
/// but lacks `key`, the key is appended as the section's *last* line (so
/// bulk insertion of several keys via [`upsert_section`] comes out in the
/// order they were given, rather than reversed). If `section` itself is
/// absent, it is appended as a fresh table at the end of the frontmatter.
/// Every other byte of `source` -- other keys, comments, blank-line spacing,
/// key order elsewhere in the file, and the entire Markdown body -- is
/// reproduced verbatim in the output.
///
/// This is the general (section, key) primitive [`set_logo_reference`] used
/// to hardcode by hand for its one pair; [`merge_brand_edits`] is what
/// forced the generalization, since applying a whole `BrandConfig` touches
/// many pairs across `[identity]`, `[logo]`, and both palette tables.
fn set_frontmatter_value(
    source: &str,
    section: &str,
    key: &str,
    value: &str,
) -> Result<String, BrandError> {
    let fm_range = frontmatter_span(source)?;
    let frontmatter = &source[fm_range.clone()];
    let nl = newline_style(source);

    let edited = if let Some(sec_range) = find_section(frontmatter, section) {
        if let Some(line_range) = find_key_line(&frontmatter[sec_range.clone()], key) {
            let abs = (sec_range.start + line_range.start)..(sec_range.start + line_range.end);
            let new_line = replace_quoted_value(&frontmatter[abs.clone()], key, value);
            splice(frontmatter, abs, &new_line)
        } else {
            // `[section]` exists but has no `key` yet -- append it as the
            // section's last line, right before whatever follows (the next
            // `[...]` header, or the end of the frontmatter).
            let insertion = format!("{key} = \"{}\"{nl}", escape_toml_basic(value));
            splice(frontmatter, sec_range.end..sec_range.end, &insertion)
        }
    } else {
        insert_new_section(frontmatter, nl, section, &[(key, value)])
    };

    Ok(format!(
        "{}{}{}",
        &source[..fm_range.start],
        edited,
        &source[fm_range.end..]
    ))
}

/// Append a brand-new `[section]` table -- header line plus every pair in
/// `kvs`, each rendered `key = "value"` -- to the end of `frontmatter` in a
/// single insertion. Shared by [`set_frontmatter_value`] (one key) and
/// [`upsert_section`] (many keys at once, e.g. all eighteen palette fields)
/// so a from-scratch section is always written whole, rather than key by
/// key, which would re-insert (and thus duplicate) the `[section]` header
/// once per key.
fn insert_new_section(frontmatter: &str, nl: &str, section: &str, kvs: &[(&str, &str)]) -> String {
    let mut insertion = String::new();
    if !frontmatter.is_empty() && !frontmatter.ends_with('\n') {
        insertion.push_str(nl);
    }
    insertion.push_str(&format!("[{section}]{nl}"));
    for (key, value) in kvs {
        insertion.push_str(&format!("{key} = \"{}\"{nl}", escape_toml_basic(value)));
    }
    splice(
        frontmatter,
        frontmatter.len()..frontmatter.len(),
        &insertion,
    )
}

/// Set every pair in `kvs` inside `[section]`, creating the table in one
/// shot via [`insert_new_section`] if it does not exist yet, or upserting
/// each key individually via [`set_frontmatter_value`] if it does (so keys
/// that are already present and unchanged come through byte-identical, and
/// only the ones that differ -- or are missing entirely -- are touched).
/// [`merge_brand_edits`] uses this for `[palette.dark]` / `[palette.light]`;
/// [`set_logo_reference`] uses it too, with a single-pair `kvs`.
fn upsert_section(source: &str, section: &str, kvs: &[(&str, &str)]) -> Result<String, BrandError> {
    let fm_range = frontmatter_span(source)?;
    let frontmatter = &source[fm_range.clone()];

    if find_section(frontmatter, section).is_some() {
        let mut out = source.to_string();
        for (key, value) in kvs {
            out = set_frontmatter_value(&out, section, key, value)?;
        }
        Ok(out)
    } else {
        let nl = newline_style(source);
        let edited = insert_new_section(frontmatter, nl, section, kvs);
        Ok(format!(
            "{}{}{}",
            &source[..fm_range.start],
            edited,
            &source[fm_range.end..]
        ))
    }
}

/// Remove one `key = ...` line from inside `[section]`, if both the section
/// and the key are present. A no-op (returns `source` unchanged) if either
/// is absent -- clearing a key that was never set is success, matching this
/// module's existing no-op stance on [`clear_logo_reference`] /
/// [`remove_frontmatter_section`].
///
/// Only [`BrandIdentity::tagline`] ever needs a lone-key removal:
/// [`merge_brand_edits`] uses this when a config drops its tagline but keeps
/// `[identity]` itself. Every other optional value in the format (`[logo]`,
/// `[palette]`) is optional at the whole-*section* level, so going from
/// `Some` to `None` there removes the entire table via
/// [`remove_frontmatter_section`] instead.
fn remove_frontmatter_key(source: &str, section: &str, key: &str) -> Result<String, BrandError> {
    let fm_range = frontmatter_span(source)?;
    let frontmatter = &source[fm_range.clone()];

    let Some(sec_range) = find_section(frontmatter, section) else {
        return Ok(source.to_string());
    };
    let Some(line_range) = find_key_line(&frontmatter[sec_range.clone()], key) else {
        return Ok(source.to_string());
    };
    let abs = (sec_range.start + line_range.start)..(sec_range.start + line_range.end);
    let edited = splice(frontmatter, abs, "");

    Ok(format!(
        "{}{}{}",
        &source[..fm_range.start],
        edited,
        &source[fm_range.end..]
    ))
}

/// Remove an entire `[section]` table -- header line and its whole body --
/// from `source`'s frontmatter, if one is present. A no-op (returns `source`
/// unchanged) when the section is already absent.
///
/// The general form of what [`clear_logo_reference`] used to do by hand for
/// `[logo]` specifically; [`merge_brand_edits`] needs the identical
/// operation for `[palette.dark]` / `[palette.light]` when a config drops
/// its palette entirely.
fn remove_frontmatter_section(source: &str, section: &str) -> Result<String, BrandError> {
    let fm_range = frontmatter_span(source)?;
    let frontmatter = &source[fm_range.clone()];

    let Some(sec_range) = find_section(frontmatter, section) else {
        return Ok(source.to_string());
    };

    // `sec_range` is the table's *body* (see `find_section`); walk back over
    // the header line's own trailing newline to find where the header text
    // itself starts, so the whole table is removed rather than just its
    // contents.
    let before_header = frontmatter[..sec_range.start]
        .strip_suffix('\n')
        .unwrap_or(&frontmatter[..sec_range.start]);
    let header_start = before_header.rfind('\n').map(|i| i + 1).unwrap_or(0);

    let edited = splice(frontmatter, header_start..sec_range.end, "");
    Ok(format!(
        "{}{}{}",
        &source[..fm_range.start],
        edited,
        &source[fm_range.end..]
    ))
}

/// Set or insert `[logo] file = "<filename>"` in `source` -- a thin caller
/// of [`upsert_section`] that adds the one thing generic to the primitive:
/// validating `filename` against the same bare-filename grammar
/// [`validate_logo`] enforces (via [`bare_filename_violations`]) before any
/// edit is made. This function is a second place a `logo.file` value can
/// enter `brand.md` (the desktop crate's save-logo command calls it after
/// writing the image bytes to disk), and that value is joined to the brand
/// directory by the loader exactly the same way a hand-authored one is, so
/// it needs the exact same path-traversal boundary, not a re-derived
/// approximation of it.
pub fn set_logo_reference(source: &str, filename: &str) -> Result<String, BrandError> {
    let violations = bare_filename_violations(filename);
    if !violations.is_empty() {
        return Err(BrandError::Invalid(vec![BrandIssue {
            field: "logo.file".to_string(),
            message: format!(
                "`{filename}` is not a bare filename ({}); it is joined to the brand directory \
                 by the loader, so this is a path-traversal boundary",
                violations.join(", ")
            ),
            severity: Severity::Error,
        }]));
    }

    upsert_section(source, "logo", &[("file", filename)])
}

/// Remove the `[logo]` table -- header line and its entire body -- from
/// `source`'s frontmatter, if one is present. The desktop crate's
/// `clear_brand_logo` command uses this so clearing a logo removes both the
/// stored file *and* the reference to it, rather than leaving a `file =
/// "..."` value that now names nothing (which [`crate::branding::load`]
/// would otherwise have to keep surfacing as a missing-logo warning forever).
///
/// A no-op that returns `source` unchanged when there is no `[logo]` section
/// to remove -- clearing an already-logo-less brand is success, not an
/// error, matching the idempotency the rest of this format's storage layer
/// (`crate::branding::clear`) already guarantees.
pub fn clear_logo_reference(source: &str) -> Result<String, BrandError> {
    remove_frontmatter_section(source, "logo")
}

/// Surgically rewrite `source`'s frontmatter so it expresses `cfg`, changing
/// as few bytes as possible -- the merge counterpart to [`render_brand_md`]
/// for the common case where a `brand.md` already exists and may carry
/// hand-authored comments, key order, or alignment worth preserving.
///
/// Every leaf value is set via [`set_frontmatter_value`] / [`upsert_section`]
/// unconditionally, not only when it differs from `source`'s current value:
/// [`replace_quoted_value`] only ever touches the bytes between the quotes on
/// a matched line, so re-"setting" a key to the value it already has
/// reproduces that line byte-for-byte. That is what actually delivers "only
/// rewrite keys whose value differs" -- there is no separate diff step to
/// keep in sync with the field list below, and no risk of it drifting out of
/// sync with a manual comparison as fields are added later.
///
/// The Markdown body is the one exception: it is compared explicitly and
/// left completely untouched unless `cfg.notes` differs from what `source`
/// already has, per this module's contract that a config's prose is never
/// silently rewritten just because a colour changed.
pub fn merge_brand_edits(source: &str, cfg: &BrandConfig) -> Result<String, BrandError> {
    let (existing, _warnings) = parse(source)?;
    let mut out = source.to_string();

    out = set_frontmatter_value(&out, "identity", "appName", &cfg.identity.app_name)?;
    out = set_frontmatter_value(&out, "identity", "displayName", &cfg.identity.display_name)?;
    out = match &cfg.identity.tagline {
        Some(tagline) => set_frontmatter_value(&out, "identity", "tagline", tagline)?,
        None => remove_frontmatter_key(&out, "identity", "tagline")?,
    };

    out = match &cfg.logo {
        Some(logo) => set_logo_reference(&out, &logo.file)?,
        None => clear_logo_reference(&out)?,
    };

    out = match &cfg.palette {
        Some(themes) => {
            let out = upsert_section(&out, "palette.dark", &palette_fields(&themes.dark))?;
            upsert_section(&out, "palette.light", &palette_fields(&themes.light))?
        }
        None => {
            let out = remove_frontmatter_section(&out, "palette.dark")?;
            remove_frontmatter_section(&out, "palette.light")?
        }
    };

    if existing.notes.as_deref() != cfg.notes.as_deref() {
        out = replace_body(&out, cfg.notes.as_deref())?;
    }

    Ok(out)
}

/// The byte offset just after the closing `+++` delimiter line (including
/// its own line terminator) -- i.e. where the Markdown body begins. The
/// mirror image of [`frontmatter_span`]'s `end`, which stops *before* that
/// line so frontmatter-only edits can leave it (and everything after it)
/// untouched; [`replace_body`] needs the opposite boundary, since the body
/// is exactly what it *does* want to overwrite.
fn body_start_offset(source: &str) -> Result<usize, BrandError> {
    let fm_range = frontmatter_span(source)?;
    let mut lines = source[fm_range.end..].split_inclusive('\n');
    // `frontmatter_span` already proved a closing delimiter line exists at
    // this offset, so this can only fail if `source` changed out from under
    // the caller between the two calls.
    let closing = lines.next().ok_or(BrandError::MissingFrontmatter)?;
    Ok(fm_range.end + closing.len())
}

/// Replace everything after the closing `+++` line with `notes` (or nothing,
/// for `None`), leaving the frontmatter -- including the closing delimiter
/// line itself -- byte-for-byte untouched. `notes` is written with a single
/// blank line separating it from the frontmatter and a trailing newline,
/// matching the shape [`render_brand_md`] and every hand-authored fixture in
/// this module's tests already use, regardless of whatever whitespace the
/// body being replaced happened to have.
fn replace_body(source: &str, notes: Option<&str>) -> Result<String, BrandError> {
    let body_start = body_start_offset(source)?;
    let nl = newline_style(source);

    let mut replacement = String::new();
    if let Some(text) = notes {
        replacement.push_str(nl);
        replacement.push_str(text);
        if !text.ends_with('\n') {
            replacement.push_str(nl);
        }
    }

    Ok(format!("{}{replacement}", &source[..body_start]))
}

// =============================================================================
// TOML deserialization
// =============================================================================

/// Mirrors the core-profile keys of `brand.md`'s frontmatter. A separate type
/// from [`BrandConfig`] because `notes` is not a frontmatter key -- it comes
/// from the Markdown body -- and because keeping this private avoids
/// confusing a caller into constructing one directly instead of calling
/// [`parse`].
///
/// Build-profile sections (`[fonts]`, `[bundle]`, `[updater]`, `[runtime]`)
/// are deliberately not modeled here: `toml::from_str` ignores unrecognized
/// top-level keys by default (no `deny_unknown_fields`), so a Mode B file
/// parses under Mode A without error, matching the plan's requirement that
/// build-only keys are a notice, not a failure.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Frontmatter {
    schema_version: u32,
    identity: BrandIdentity,
    #[serde(default)]
    logo: Option<BrandLogo>,
    #[serde(default)]
    palette: Option<BrandThemes>,
    // Build profile (Mode B). Captured here so the runtime can *notice* them
    // and say they need a packaged build, rather than serde dropping them
    // silently and leaving the author wondering why nothing happened.
    #[serde(default)]
    fonts: Option<BrandFonts>,
    #[serde(default)]
    bundle: Option<BrandBundle>,
    #[serde(default)]
    updater: Option<BrandUpdater>,
    #[serde(default)]
    runtime: Option<BrandRuntime>,
}

/// The palette keys, in their TOML (camelCase) spelling, used to recognize
/// which field a `toml` deserialize error is complaining about so the
/// unquoted-hex hint can be attached to it.
const PALETTE_FIELD_NAMES: &[&str] = &[
    "bg", "bgSide", "card", "cardHi", "line", "lineSoft", "lineHi", "ink", "ink2", "ink3", "hue",
    "hueText", "hueSolid", "onHue", "ok", "warn", "err", "link",
];

/// Turn a raw `toml::de::Error` into a [`BrandError::Toml`] with an
/// author-actionable hint attached for the two mistakes this format invites:
///
/// - Forgetting that `#` starts a comment in TOML, so an unquoted hex value
///   is missing by the time serde ever sees the key.
/// - Specifying only one of `[palette.dark]` / `[palette.light]`, which
///   `BrandThemes` requires both of at the type level (see its doc comment
///   on the specificity trap this exists to prevent).
///
/// This only fires for genuinely *absent* keys (a "missing field" error from
/// serde). The far more common case -- `key = #abc123` right on the line --
/// is caught earlier, before this function is ever called, by
/// [`find_unquoted_hex_hint`] scanning the raw text; that path produces a
/// clearer error because it can see the actual line, not just a field name.
fn classify_toml_error(err: toml::de::Error) -> BrandError {
    let msg = err.to_string();

    if msg.contains("missing field `dark`") || msg.contains("missing field `light`") {
        return BrandError::Toml(format!(
            "{msg}\n\nhint: a brand palette must declare both [palette.dark] and \
             [palette.light]. A palette that overrides colours for one theme but not the \
             other leaves the other theme's rules to keep winning on some tokens and losing on \
             others -- the specificity trap tokens.css documents -- which silently produces \
             unreadable text rather than an obvious failure."
        ));
    }

    for name in PALETTE_FIELD_NAMES {
        if msg.contains(&format!("missing field `{name}`")) {
            return BrandError::Toml(format!(
                "{msg}\n\nhint: palette key `{name}` is missing. If you wrote it as \
                 `{name} = #......`, remember `#` starts a comment in TOML, so the value never \
                 reached the parser -- did you forget to quote the hex value? Use \
                 `{name} = \"#......\"` instead."
            ));
        }
    }

    BrandError::Toml(msg)
}

/// Scans the raw frontmatter text for the classic authoring mistake --
/// `key = #abc123` instead of `key = "#abc123"` -- before ever handing the
/// text to the TOML parser.
///
/// This has to run first, not as a fallback once `toml::from_str` fails: `#`
/// immediately after `=` starts a comment, so the value is syntactically
/// absent and the TOML parser reports a generic "invalid value" / "expected
/// value" error pointing at end-of-line rather than anything mentioning the
/// key. Recognizing the pattern in the source text directly produces a
/// message an author can act on instead of a parser's confusion.
fn find_unquoted_hex_hint(frontmatter: &str) -> Option<String> {
    for line in frontmatter.lines() {
        let trimmed = line.trim_start();
        // A line that is itself a comment can start with `#`; only inspect
        // lines that contain a `key = value` assignment.
        if trimmed.starts_with('#') || trimmed.is_empty() {
            continue;
        }
        let Some(eq_pos) = line.find('=') else {
            continue;
        };
        let key = line[..eq_pos].trim();
        // A bare identifier check keeps this from misfiring on something
        // like `"a = b" = "#fff"` (a quoted key containing `=`); brand.md
        // never needs quoted keys, so requiring plain identifier characters
        // is not a real restriction here.
        if key.is_empty()
            || !key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            continue;
        }
        let value = line[eq_pos + 1..].trim_start();
        if value.starts_with('#') {
            return Some(format!(
                "brand.md line {line:?}: `{key}` looks like it was written as an unquoted hex \
                 colour. `#` starts a comment in TOML, so everything from it to the end of the \
                 line is discarded and the value is empty -- did you forget to quote the hex \
                 value? Use `{key} = \"#......\"` instead."
            ));
        }
    }
    None
}

// =============================================================================
// Rendering a brand.md from scratch
// =============================================================================
//
// `render_brand_md` is [`merge_brand_edits`]'s counterpart for the one case
// the surgical primitives above cannot handle: there is no existing file, so
// there is no author formatting to preserve and nothing to be surgical
// *about*. This is the only place in the module that builds frontmatter
// through `toml`'s serializer rather than a byte-level edit -- and precisely
// because there is no hand-authored text on the other side of it to lose.

/// Local mirror of [`BrandIdentity`] used only for serialization here.
/// [`BrandIdentity::tagline`] is `Option<String>`, and the `toml` crate's
/// serializer has no representation for a bare `None` (TOML has no null) --
/// it errors rather than silently omitting the field. Re-declaring the
/// field as `Option<&str>` with `skip_serializing_if` sidesteps that without
/// adding a serde attribute to [`BrandIdentity`] itself, which stays exactly
/// as ts-rs-exported today.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderIdentity<'a> {
    app_name: &'a str,
    display_name: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    tagline: Option<&'a str>,
}

impl<'a> From<&'a BrandIdentity> for RenderIdentity<'a> {
    fn from(identity: &'a BrandIdentity) -> Self {
        Self {
            app_name: &identity.app_name,
            display_name: &identity.display_name,
            tagline: identity.tagline.as_deref(),
        }
    }
}

/// Serializable mirror of a `brand.md` frontmatter, used only by
/// [`render_brand_md`] to hand the whole config to the `toml` crate's
/// serializer in one shot. Field order matches [`BrandConfig`], and TOML
/// requires every scalar field in a table to precede every table field --
/// `schema_version` is the only scalar here, so this order is also the only
/// valid one.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RenderFrontmatter<'a> {
    schema_version: u32,
    identity: RenderIdentity<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    logo: Option<&'a BrandLogo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    palette: Option<&'a BrandThemes>,
}

/// Default Markdown body used when `cfg.notes` is absent -- a brand built
/// entirely from Settings form fields has no author-written prose to carry
/// over. Deliberately not just an empty body: an empty `brand.md` teaches
/// nothing about what `notes` is *for*, and the whole reason the format has
/// a body at all (see the module doc comment) is that it is meant to be
/// filled in, ideally by the user asking an LLM to describe the theme they
/// just built.
fn default_notes_body(identity: &BrandIdentity) -> String {
    format!(
        "# {} — design notes\n\nThis section is never parsed -- it is prose for humans, and for \
         an LLM asked to revise this theme later. Describe what the palette is going for and why \
         the accent colour was chosen.\n",
        identity.display_name
    )
}

/// Render a complete, well-formed `brand.md` from scratch: `+++` TOML
/// frontmatter expressing every field of `cfg`, followed by `cfg.notes` (or
/// [`default_notes_body`] when there are none yet). Used exactly once in a
/// brand's lifetime -- the very first save, when the desktop crate's storage
/// layer finds no existing `brand.md` to [`merge_brand_edits`] into instead.
///
/// `toml::to_string` is what enforces the format's single sharpest edge
/// (`#` starts a TOML comment, so a hex colour must be quoted): it always
/// emits `String` fields as quoted TOML strings, so there is no code path
/// here that could produce an unquoted `#rrggbb`.
///
/// Round-trips: `parse(&render_brand_md(&cfg))` yields a config equal to
/// `cfg`, provided `cfg.notes` is `Some` (see
/// [`tests::render_brand_md_round_trips`]) -- when it is `None`, rendering
/// fills in [`default_notes_body`], so the round trip necessarily produces
/// `notes: Some(..)` rather than reproducing the `None` it started from.
pub fn render_brand_md(cfg: &BrandConfig) -> String {
    let frontmatter = RenderFrontmatter {
        schema_version: cfg.schema_version,
        identity: RenderIdentity::from(&cfg.identity),
        logo: cfg.logo.as_ref(),
        palette: cfg.palette.as_ref(),
    };
    let toml_src = toml::to_string(&frontmatter).expect(
        "BrandConfig's frontmatter fields are all plain strings/u32s, which the toml crate can \
         always serialize",
    );

    let body = cfg
        .notes
        .clone()
        .unwrap_or_else(|| default_notes_body(&cfg.identity));

    let mut out = format!("+++\n{toml_src}+++\n\n{body}");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

// =============================================================================
// Public API
// =============================================================================

/// Parse a `brand.md` source string: split the `+++` frontmatter from the
/// Markdown body, deserialize the frontmatter as TOML, reject an
/// unsupported `schemaVersion`, then run [`validate`].
///
/// Returns the config plus any [`Severity::Warning`] issues worth surfacing
/// to the user (e.g. a contrast shortfall on their own install -- not
/// blocking, but worth a nudge). [`Severity::Error`] issues are returned as
/// [`BrandError::Invalid`] instead of a config: a brand that fails
/// validation is not partially applied.
pub fn parse(source: &str) -> Result<(BrandConfig, Vec<BrandIssue>), BrandError> {
    let (frontmatter_src, notes) = split_frontmatter(source)?;

    if let Some(hint) = find_unquoted_hex_hint(frontmatter_src) {
        return Err(BrandError::Toml(hint));
    }

    let frontmatter: Frontmatter = toml::from_str(frontmatter_src).map_err(classify_toml_error)?;

    if frontmatter.schema_version != BRAND_SCHEMA_VERSION {
        return Err(BrandError::UnsupportedVersion {
            found: frontmatter.schema_version,
            supported: BRAND_SCHEMA_VERSION,
        });
    }

    let config = BrandConfig {
        schema_version: frontmatter.schema_version,
        identity: frontmatter.identity,
        logo: frontmatter.logo,
        palette: frontmatter.palette,
        notes,
        fonts: frontmatter.fonts,
        bundle: frontmatter.bundle,
        updater: frontmatter.updater,
        runtime: frontmatter.runtime,
    };

    let issues = validate(&config);
    let (errors, warnings): (Vec<_>, Vec<_>) = issues
        .into_iter()
        .partition(|issue| issue.severity == Severity::Error);
    if !errors.is_empty() {
        return Err(BrandError::Invalid(errors));
    }

    Ok((config, warnings))
}

/// Validate an already-built config. Pure; no IO.
///
/// Runs four independent groups of checks and returns every finding rather
/// than stopping at the first: identity length/emptiness, the logo filename
/// grammar, (when a palette is present) hex-only colour values plus WCAG
/// contrast, and the build profile (see [`validate_build_profile`]).
/// `BrandThemes` already guarantees both themes are present at the type
/// level by the time a value reaches here.
pub fn validate(cfg: &BrandConfig) -> Vec<BrandIssue> {
    let mut issues = Vec::new();

    validate_identity(&cfg.identity, &mut issues);

    if let Some(logo) = &cfg.logo {
        validate_logo(logo, &mut issues);
    }

    if let Some(themes) = &cfg.palette {
        validate_palette_theme("palette.dark", &themes.dark, &mut issues);
        validate_palette_theme("palette.light", &themes.light, &mut issues);
        check_contrast("palette.dark", &themes.dark, &mut issues);
        check_contrast("palette.light", &themes.light, &mut issues);
    }

    validate_build_profile(cfg, &mut issues);

    issues
}

// =============================================================================
// Build profile (Mode B) -- presence notices + own-content validation
// =============================================================================
//
// The four build-profile sections ([fonts], [bundle], [updater], [runtime])
// are captured by `Frontmatter` (see its doc comment) so this runtime can
// *notice* them rather than have `toml::from_str` drop them silently. Per
// the plan (docs/private/white-label-plan.md §2-3): "Mode A parses the whole
// file, applies the core profile, and surfaces build-only keys as 'this key
// only takes effect in a packaged build' -- not as an error." A brand file
// is one artifact describing one brand; which half of it applies depends on
// who is reading it, not on maintaining two divergent files -- so every one
// of these presence notices is `Severity::Warning`, never `Severity::Error`.
// Without it, an author sets `[fonts]` in a demo build, nothing visibly
// happens, and there is no feedback at all.
//
// Independent of that presence notice, each section's own *contents* are
// still validated, for the same reasons the core profile's are: a font path
// that escapes the brand directory is exactly the same path-traversal
// problem [`validate_logo`] exists to catch (the emitter joins it to the
// brand directory the same way the runtime loader joins `logo.file`), and an
// updater endpoint that isn't `https://` is a build that would ship checking
// an insecure channel for its own updates. These content checks run
// regardless of which mode is reading the file -- an author benefits from
// finding out about a typo'd endpoint from Mode A's parse, long before a
// build pipeline ever runs the emitter.
fn validate_build_profile(cfg: &BrandConfig, issues: &mut Vec<BrandIssue>) {
    if let Some(fonts) = &cfg.fonts {
        issues.push(build_profile_notice("fonts"));
        validate_fonts(fonts, issues);
    }
    if let Some(bundle) = &cfg.bundle {
        issues.push(build_profile_notice("bundle"));
        validate_bundle(bundle, issues);
    }
    if let Some(updater) = &cfg.updater {
        issues.push(build_profile_notice("updater"));
        validate_updater(updater, issues);
    }
    if cfg.runtime.is_some() {
        issues.push(build_profile_notice("runtime"));
        // BrandRuntime has exactly one field, a bool with a serde default --
        // there is no value in it that can be out of grammar.
    }
}

/// The "this only applies in a packaged build" notice itself. `field` is the
/// bare top-level section name (`"fonts"`, not `"fonts.ui"`), which is what
/// lets a caller (the `apply_brand` emitter, in particular -- see its own
/// module comment) distinguish this presence notice from a genuine per-field
/// issue like `"fonts.ui"` and filter just this one out when it is, itself,
/// the packaged build these keys are for.
fn build_profile_notice(section: &'static str) -> BrandIssue {
    BrandIssue {
        field: section.to_string(),
        message: format!(
            "[{section}] only takes effect in a packaged build produced by `cargo run --example \
             apply_brand -p provider-core`; a demo build (Mode A) parses it but does not apply it."
        ),
        severity: Severity::Warning,
    }
}

/// `fonts.*` values are filenames resolved against the brand directory by
/// the emitter, exactly like `logo.file` is resolved by the runtime loader
/// -- so they are held to the exact same bare-filename grammar via
/// [`bare_filename_violations`], not a re-derived approximation of it.
fn validate_fonts(fonts: &BrandFonts, issues: &mut Vec<BrandIssue>) {
    for (field, value) in [
        ("fonts.ui", &fonts.ui),
        ("fonts.mono", &fonts.mono),
        ("fonts.serif", &fonts.serif),
    ] {
        let Some(filename) = value else { continue };
        let reasons = bare_filename_violations(filename);
        if !reasons.is_empty() {
            issues.push(BrandIssue {
                field: field.to_string(),
                message: format!(
                    "`{filename}` is not a bare filename ({}); it is joined to the brand \
                     directory by the emitter, so this is a path-traversal boundary -- the same \
                     one `logo.file` is held to",
                    reasons.join(", ")
                ),
                severity: Severity::Error,
            });
        }
    }
}

fn validate_bundle(bundle: &BrandBundle, issues: &mut Vec<BrandIssue>) {
    if !looks_like_reverse_dns(&bundle.identifier) {
        issues.push(BrandIssue {
            field: "bundle.identifier".to_string(),
            message: format!(
                "`{}` does not look like a reverse-DNS identifier (e.g. `com.northwind.ai`) -- \
                 this becomes the macOS bundle ID, the Windows registry key, and the keychain \
                 namespace",
                bundle.identifier
            ),
            severity: Severity::Warning,
        });
    }
}

/// A loose shape check, not a real reverse-DNS grammar: at least two
/// dot-separated segments, each a non-empty run of ASCII alphanumerics, `-`,
/// or `_`. Deliberately `Severity::Warning`, not `Error` -- "looks like"
/// admits there is no single correct grammar here, only a shape that catches
/// the obviously-wrong values (a bare word, a URL, an empty string) before
/// they reach `tauri.conf.json` unnoticed.
fn looks_like_reverse_dns(value: &str) -> bool {
    let segments: Vec<&str> = value.split('.').collect();
    segments.len() >= 2
        && segments.iter().all(|s| {
            !s.is_empty()
                && s.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
}

/// `updater.endpoint` must be `https://` -- a manifest fetched over plain
/// HTTP is exactly the insecure update channel a signed updater exists to
/// prevent, so this is `Severity::Error`, not a notice.
fn validate_updater(updater: &BrandUpdater, issues: &mut Vec<BrandIssue>) {
    if !updater.endpoint.starts_with("https://") {
        issues.push(BrandIssue {
            field: "updater.endpoint".to_string(),
            message: format!(
                "`{}` must start with `https://` -- an update manifest fetched over plain HTTP \
                 defeats the point of a signed updater",
                updater.endpoint
            ),
            severity: Severity::Error,
        });
    }
}

// =============================================================================
// Identity
// =============================================================================

/// Long enough for any real product name, short enough that a pathological
/// value (a name someone pasted an essay into) cannot wreck the sidebar
/// wordmark or settings layout.
const MAX_IDENTITY_LEN: usize = 64;

fn validate_identity(identity: &BrandIdentity, issues: &mut Vec<BrandIssue>) {
    check_identity_field(&identity.app_name, "identity.appName", issues);
    check_identity_field(&identity.display_name, "identity.displayName", issues);
}

fn check_identity_field(value: &str, field: &str, issues: &mut Vec<BrandIssue>) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        issues.push(BrandIssue {
            field: field.to_string(),
            message: "must not be empty".to_string(),
            severity: Severity::Error,
        });
    } else if trimmed.chars().count() > MAX_IDENTITY_LEN {
        issues.push(BrandIssue {
            field: field.to_string(),
            message: format!("must be at most {MAX_IDENTITY_LEN} characters"),
            severity: Severity::Error,
        });
    }
}

// =============================================================================
// Logo filename
// =============================================================================

/// `logo.file` is joined to the brand directory by the loader (not by this
/// module -- there is no IO here), so this check is the entire
/// path-traversal boundary for that join. Every reason a value is rejected
/// is collected rather than stopping at the first, since an author fixing
/// one at a time from a single error is a worse experience than seeing all
/// of them.
///
/// Deliberately does *not* use `std::path::Path::is_absolute()`: that
/// method's notion of "absolute" is platform-dependent (a leading `/` is
/// absolute on Unix but not recognized as such by the Windows
/// implementation, and vice versa for drive letters), which would make this
/// validator's behavior depend on the OS it happens to run on. Every
/// separator character is rejected outright instead, which is both stricter
/// and platform-independent -- a bare filename never needs one.
fn validate_logo(logo: &BrandLogo, issues: &mut Vec<BrandIssue>) {
    let file = logo.file.as_str();
    let reasons = bare_filename_violations(file);

    if !reasons.is_empty() {
        issues.push(BrandIssue {
            field: "logo.file".to_string(),
            message: format!(
                "`{file}` is not a bare filename ({}); it is joined to the brand directory by \
                 the loader, so this is a path-traversal boundary",
                reasons.join(", ")
            ),
            severity: Severity::Error,
        });
    }
}

/// The bare-filename grammar itself, extracted out of [`validate_logo`] so
/// [`set_logo_reference`] can apply the exact same path-traversal boundary
/// before ever writing a filename into `brand.md`, rather than re-deriving
/// (and risking drifting from) an equivalent check.
fn bare_filename_violations(file: &str) -> Vec<&'static str> {
    let mut reasons = Vec::new();

    if file.is_empty() {
        reasons.push("must not be empty");
    }
    if file.contains('/') || file.contains('\\') {
        reasons.push("must not contain a path separator");
    }
    if file.contains("..") {
        reasons.push("must not contain `..`");
    }
    if file.starts_with('~') {
        reasons.push("must not start with `~`");
    }
    if file.contains('\0') {
        reasons.push("must not contain a null byte");
    }
    // "C:", "d:", etc. -- a Windows drive-qualified path even without a
    // separator after the colon (e.g. `C:logo.png` is drive-relative, not a
    // bare filename).
    let bytes = file.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        reasons.push("must not be a drive-qualified path");
    }

    reasons
}

// =============================================================================
// Palette: hex grammar
// =============================================================================

/// `^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$`, hand-written rather
/// than pulling in the `regex` crate for one closed grammar: every branch is
/// a fixed length and every character class is `is_ascii_hexdigit`, so a
/// regex engine buys nothing here but a new dependency.
///
/// Hex-only is deliberately narrower than CSS: no `url(...)`, `var(...)`,
/// `rgb(...)`, or named colours. The point is not just "reject garbage" --
/// it is that this grammar cannot express a network fetch at all, whatever
/// the CSP happens to allow at the point a value is applied.
fn is_valid_hex_color(value: &str) -> bool {
    let Some(hex) = value.strip_prefix('#') else {
        return false;
    };
    matches!(hex.len(), 3 | 6 | 8) && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The 18 curated palette keys, paired with their TOML (camelCase) spelling
/// for error messages, in the same order as [`BrandPalette`]'s fields.
fn palette_fields(palette: &BrandPalette) -> [(&'static str, &str); 18] {
    [
        ("bg", palette.bg.as_str()),
        ("bgSide", palette.bg_side.as_str()),
        ("card", palette.card.as_str()),
        ("cardHi", palette.card_hi.as_str()),
        ("line", palette.line.as_str()),
        ("lineSoft", palette.line_soft.as_str()),
        ("lineHi", palette.line_hi.as_str()),
        ("ink", palette.ink.as_str()),
        ("ink2", palette.ink2.as_str()),
        ("ink3", palette.ink3.as_str()),
        ("hue", palette.hue.as_str()),
        ("hueText", palette.hue_text.as_str()),
        ("hueSolid", palette.hue_solid.as_str()),
        ("onHue", palette.on_hue.as_str()),
        ("ok", palette.ok.as_str()),
        ("warn", palette.warn.as_str()),
        ("err", palette.err.as_str()),
        ("link", palette.link.as_str()),
    ]
}

fn validate_palette_theme(prefix: &str, palette: &BrandPalette, issues: &mut Vec<BrandIssue>) {
    for (name, value) in palette_fields(palette) {
        if !is_valid_hex_color(value) {
            issues.push(BrandIssue {
                field: format!("{prefix}.{name}"),
                message: format!(
                    "`{value}` is not a hex colour (#rgb, #rrggbb, or #rrggbbaa are the only \
                     accepted forms -- no url(...), var(...), rgb(...), or named colours). If \
                     this value is empty, `#` starting a comment in TOML is the likely cause --\
                     did you forget to quote the hex value?"
                ),
                severity: Severity::Error,
            });
        }
    }
}

// =============================================================================
// Contrast (WCAG AA, 4.5:1)
// =============================================================================
//
// This is a deliberate reimplementation of the ratio math in
// `apps/desktop/src/styles/tokenContrast.test.ts`, not a shared library,
// because the two live on opposite sides of the Rust/TypeScript boundary
// this crate exists to be canonical across (see `lib.rs` / C1: Rust is the
// schema source of truth and TS is generated from it, but there is no
// mechanism today for sharing *logic*, only *types*, across that boundary).
// The formulas are standard WCAG 2.1 relative luminance / contrast ratio
// math with no tuning knobs, so a reimplementation carries very little
// drift risk; `tokenContrast.test.ts`'s own doc comment is worth reading
// for why the check exists at all (a real V7 regression: `--ink-3` at
// 3.2:1, under the AA floor, on copy that mattered).

/// WCAG AA for normal text.
const AA_MIN_CONTRAST: f64 = 4.5;

/// sRGB channel value (0-255) to linearized channel, per WCAG 2.1 §1.4.3.
fn linearize_channel(v: u8) -> f64 {
    let c = f64::from(v) / 255.0;
    if c <= 0.03928 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Decodes `#rgb`, `#rrggbb`, or `#rrggbbaa` into 8-bit R/G/B. The alpha
/// channel of an `#rrggbbaa` value is ignored: WCAG's contrast ratio is
/// defined over opaque colour pairs, and this crate has no compositing
/// context (what the token sits over) to resolve a translucent value
/// against. Treating it as opaque is the same simplification
/// `tokenContrast.test.ts` makes implicitly by never encountering an 8-digit
/// token in `tokens.css`.
fn hex_to_rgb(value: &str) -> Option<(u8, u8, u8)> {
    let hex = value.strip_prefix('#')?;
    match hex.len() {
        3 => {
            let mut chars = hex.chars();
            let r = chars.next()?.to_digit(16)? as u8;
            let g = chars.next()?.to_digit(16)? as u8;
            let b = chars.next()?.to_digit(16)? as u8;
            Some((r * 17, g * 17, b * 17))
        }
        6 | 8 => {
            let r = u8::from_str_radix(hex.get(0..2)?, 16).ok()?;
            let g = u8::from_str_radix(hex.get(2..4)?, 16).ok()?;
            let b = u8::from_str_radix(hex.get(4..6)?, 16).ok()?;
            Some((r, g, b))
        }
        _ => None,
    }
}

fn relative_luminance(value: &str) -> Option<f64> {
    let (r, g, b) = hex_to_rgb(value)?;
    Some(
        0.2126 * linearize_channel(r)
            + 0.7152 * linearize_channel(g)
            + 0.0722 * linearize_channel(b),
    )
}

/// `(L1 + 0.05) / (L2 + 0.05)` with `L1` the lighter of the two, per WCAG
/// 2.1 §1.4.3. Returns `None` if either value is not decodable hex --
/// [`validate_palette_theme`] already reports that as its own error, so
/// contrast checking silently skips rather than compounding it with a
/// second, less specific finding.
fn contrast_ratio(a: &str, b: &str) -> Option<f64> {
    let la = relative_luminance(a)?;
    let lb = relative_luminance(b)?;
    let (hi, lo) = if la >= lb { (la, lb) } else { (lb, la) };
    Some((hi + 0.05) / (lo + 0.05))
}

/// Checks the `ink`/`ink2`/`ink3` ramp against every surface, and `onHue`
/// against `hueSolid`, mirroring the surface/ink cross-product
/// `tokenContrast.test.ts` runs against `tokens.css`. `Severity::Warning`,
/// never `Error`: per the plan, this is the user's own install, so a brand
/// that fails AA is surfaced, not rejected.
fn check_contrast(prefix: &str, palette: &BrandPalette, issues: &mut Vec<BrandIssue>) {
    let surfaces: [(&str, &str); 4] = [
        ("bg", palette.bg.as_str()),
        ("bgSide", palette.bg_side.as_str()),
        ("card", palette.card.as_str()),
        ("cardHi", palette.card_hi.as_str()),
    ];
    let inks: [(&str, &str); 3] = [
        ("ink", palette.ink.as_str()),
        ("ink2", palette.ink2.as_str()),
        ("ink3", palette.ink3.as_str()),
    ];

    for (ink_name, ink_value) in inks {
        for (surface_name, surface_value) in surfaces {
            if let Some(ratio) = contrast_ratio(ink_value, surface_value) {
                if ratio < AA_MIN_CONTRAST {
                    issues.push(contrast_issue(prefix, ink_name, surface_name, ratio));
                }
            }
        }
    }

    if let Some(ratio) = contrast_ratio(palette.on_hue.as_str(), palette.hue_solid.as_str()) {
        if ratio < AA_MIN_CONTRAST {
            issues.push(contrast_issue(prefix, "onHue", "hueSolid", ratio));
        }
    }
}

fn contrast_issue(prefix: &str, fg: &str, bg: &str, ratio: f64) -> BrandIssue {
    BrandIssue {
        field: format!("{prefix}.{fg}"),
        message: format!(
            "contrast against {prefix}.{bg} is {ratio:.2}:1, below the WCAG AA floor of \
             {AA_MIN_CONTRAST}:1 for normal text"
        ),
        severity: Severity::Warning,
    }
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    /// A realistic, fully-specified `brand.md`, kept in sync with the
    /// example in `docs/private/white-label-plan.md` section 2 (extended
    /// with `lineSoft`/`lineHi`, which the plan's illustrative snippet
    /// omits but `BrandPalette` requires).
    const VALID_FIXTURE: &str = r##"+++
schemaVersion = 1

[identity]
appName     = "Northwind"
displayName = "Northwind AI"
tagline     = "Message Northwind..."

[logo]
file = "logo.png"

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

[palette.light]
bg       = "#FBFAF8"
bgSide   = "#F3F1EC"
card     = "#FFFFFF"
cardHi   = "#F3F1EC"
line     = "#E4E0D8"
lineSoft = "#EDEAE2"
lineHi   = "#CFC9BC"
ink      = "#1E1B16"
ink2     = "#4A4438"
ink3     = "#6E6656"
hue      = "#B8441F"
hueText  = "#9A3A1B"
hueSolid = "#B8441F"
onHue    = "#FFFFFF"
ok       = "#1A7F37"
warn     = "#9A6700"
err      = "#CF222E"
link     = "#0969DA"
+++

# Northwind — design notes

Warm, editorial, low-contrast. The accent is a burnt orange used sparingly:
send button, active nav row, focus ring. Surfaces stay near-neutral so the
accent never competes with message content.
"##;

    // -------------------------------------------------------------------
    // Frontmatter splitting
    // -------------------------------------------------------------------

    #[test]
    fn round_trip_valid_fixture() {
        let (cfg, warnings) = parse(VALID_FIXTURE).expect("fixture should parse cleanly");
        assert_eq!(cfg.schema_version, 1);
        assert_eq!(cfg.identity.app_name, "Northwind");
        assert_eq!(cfg.identity.display_name, "Northwind AI");
        assert_eq!(
            cfg.identity.tagline.as_deref(),
            Some("Message Northwind...")
        );
        assert_eq!(cfg.logo.as_ref().unwrap().file, "logo.png");
        assert!(cfg.palette.is_some());
        assert!(warnings.is_empty(), "fixture should clear AA: {warnings:?}");

        let notes = cfg.notes.expect("body should be preserved as notes");
        assert!(notes.starts_with("# Northwind — design notes"));
        assert!(notes.contains("Warm, editorial, low-contrast."));
        // Verbatim means no re-wrapping/re-flowing of the body text.
        assert!(notes.contains(
            "send button, active nav row, focus ring. Surfaces stay near-neutral so the\naccent never competes with message content."
        ));
    }

    #[test]
    fn missing_frontmatter_is_rejected() {
        let err = parse("# Just a markdown file\n\nNo frontmatter here.").unwrap_err();
        assert_eq!(err, BrandError::MissingFrontmatter);
    }

    #[test]
    fn empty_source_is_missing_frontmatter() {
        let err = parse("").unwrap_err();
        assert_eq!(err, BrandError::MissingFrontmatter);
    }

    #[test]
    fn unterminated_frontmatter_is_rejected() {
        let source = "+++\nschemaVersion = 1\n[identity]\nappName = \"X\"\n";
        let err = parse(source).unwrap_err();
        match err {
            BrandError::Toml(msg) => assert!(msg.contains("not terminated")),
            other => panic!("expected Toml(..), got {other:?}"),
        }
    }

    #[test]
    fn body_only_after_valid_frontmatter_is_preserved_trimmed() {
        let source = "+++\nschemaVersion = 1\n\n[identity]\nappName = \"X\"\ndisplayName = \"X\"\n+++\n\n\n   Hello, world.   \n\n\n";
        let (cfg, _warnings) = parse(source).expect("minimal identity-only file should parse");
        assert_eq!(cfg.notes.as_deref(), Some("Hello, world."));
    }

    #[test]
    fn frontmatter_with_no_body_yields_no_notes() {
        let source =
            "+++\nschemaVersion = 1\n\n[identity]\nappName = \"X\"\ndisplayName = \"X\"\n+++\n";
        let (cfg, _warnings) = parse(source).expect("should parse");
        assert_eq!(cfg.notes, None);
    }

    #[test]
    fn crlf_line_endings_are_handled() {
        let source = VALID_FIXTURE.replace('\n', "\r\n");
        let (cfg, warnings) = parse(&source).expect("CRLF fixture should parse");
        assert_eq!(cfg.identity.app_name, "Northwind");
        assert!(warnings.is_empty());
    }

    #[test]
    fn leading_bom_is_stripped() {
        let source = format!("\u{FEFF}{VALID_FIXTURE}");
        let (cfg, _warnings) = parse(&source).expect("BOM-prefixed fixture should parse");
        assert_eq!(cfg.identity.app_name, "Northwind");
    }

    #[test]
    fn trailing_whitespace_on_delimiter_lines_is_tolerated() {
        let source = VALID_FIXTURE.replacen("+++\n", "+++   \n", 2);
        let (cfg, _warnings) =
            parse(&source).expect("delimiters with trailing spaces should parse");
        assert_eq!(cfg.identity.app_name, "Northwind");
    }

    // -------------------------------------------------------------------
    // Version
    // -------------------------------------------------------------------

    #[test]
    fn unsupported_schema_version_is_rejected() {
        let source = VALID_FIXTURE.replace("schemaVersion = 1", "schemaVersion = 2");
        let err = parse(&source).unwrap_err();
        assert_eq!(
            err,
            BrandError::UnsupportedVersion {
                found: 2,
                supported: BRAND_SCHEMA_VERSION
            }
        );
    }

    // -------------------------------------------------------------------
    // Hex grammar
    // -------------------------------------------------------------------

    #[test]
    fn hex_grammar_accepts_3_6_and_8_digit_forms() {
        assert!(is_valid_hex_color("#abc"));
        assert!(is_valid_hex_color("#ABCDEF"));
        assert!(is_valid_hex_color("#aabbccdd"));
    }

    #[test]
    fn hex_grammar_rejects_functional_and_named_values() {
        for value in [
            "url(evil.com)",
            "var(--x)",
            "rgb(0,0,0)",
            "rgba(0,0,0,1)",
            "red",
            "javascript:alert(1)",
            "#gggggg",
            "#12345",
            "",
            "0F1115",
        ] {
            assert!(
                !is_valid_hex_color(value),
                "expected {value:?} to be rejected"
            );
        }
    }

    #[test]
    fn quoted_non_hex_palette_value_is_a_validation_error() {
        let source =
            VALID_FIXTURE.replace("bg       = \"#0F1115\"", "bg       = \"rgb(15, 17, 21)\"");
        let err = parse(&source).unwrap_err();
        match err {
            BrandError::Invalid(issues) => {
                assert!(issues
                    .iter()
                    .any(|i| i.field == "palette.dark.bg" && i.severity == Severity::Error));
            }
            other => panic!("expected Invalid(..), got {other:?}"),
        }
    }

    #[test]
    fn url_value_is_rejected() {
        let source = VALID_FIXTURE.replace(
            "hue      = \"#E4572E\"",
            "hue      = \"url(https://evil.example/x.png)\"",
        );
        let err = parse(&source).unwrap_err();
        assert!(matches!(err, BrandError::Invalid(_)));
    }

    #[test]
    fn javascript_uri_value_is_rejected() {
        let source = VALID_FIXTURE.replace(
            "link     = \"#58A6FF\"",
            "link     = \"javascript:alert(1)\"",
        );
        let err = parse(&source).unwrap_err();
        assert!(matches!(err, BrandError::Invalid(_)));
    }

    #[test]
    fn unquoted_hex_value_gets_a_specific_hint() {
        let source = VALID_FIXTURE.replace("bg       = \"#0F1115\"", "bg       = #0F1115");
        let err = parse(&source).unwrap_err();
        match err {
            BrandError::Toml(msg) => {
                assert!(msg.contains("quote the hex value"), "message: {msg}");
                assert!(
                    msg.contains('#'),
                    "message should reference TOML comments: {msg}"
                );
            }
            other => panic!("expected Toml(..), got {other:?}"),
        }
    }

    // -------------------------------------------------------------------
    // Dark/light symmetry
    // -------------------------------------------------------------------

    #[test]
    fn palette_with_only_dark_theme_is_rejected() {
        let source = r##"+++
schemaVersion = 1

[identity]
appName     = "X"
displayName = "X"

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
hueSolid = "#E4572E"
onHue    = "#FFFFFF"
ok       = "#3FB950"
warn     = "#D29922"
err      = "#F85149"
link     = "#58A6FF"
+++
"##;
        let err = parse(source).unwrap_err();
        match err {
            BrandError::Toml(msg) => {
                assert!(msg.contains("light"), "message: {msg}");
                assert!(
                    msg.to_lowercase().contains("specificity")
                        || msg.to_lowercase().contains("unreadable"),
                    "message should explain *why* both are required: {msg}"
                );
            }
            other => panic!("expected Toml(..), got {other:?}"),
        }
    }

    // -------------------------------------------------------------------
    // Logo filename safety
    // -------------------------------------------------------------------

    #[test]
    fn logo_traversal_cases_are_rejected() {
        let cases = [
            "../../etc/passwd",
            "..\\..\\Windows\\System32\\evil.dll",
            "/etc/passwd",
            "\\\\server\\share\\logo.png",
            "C:\\Windows\\System32\\evil.dll",
            "C:logo.png",
            "~/.ssh/id_rsa",
            "logo.png\0.exe",
            "sub/dir/logo.png",
        ];
        for file in cases {
            let cfg = BrandConfig {
                schema_version: BRAND_SCHEMA_VERSION,
                identity: BrandIdentity {
                    app_name: "X".to_string(),
                    display_name: "X".to_string(),
                    tagline: None,
                },
                logo: Some(BrandLogo {
                    file: file.to_string(),
                }),
                palette: None,
                notes: None,
                fonts: None,
                bundle: None,
                updater: None,
                runtime: None,
            };
            let issues = validate(&cfg);
            assert!(
                issues
                    .iter()
                    .any(|i| i.field == "logo.file" && i.severity == Severity::Error),
                "expected {file:?} to be rejected as unsafe"
            );
        }
    }

    #[test]
    fn bare_logo_filename_is_accepted() {
        let cfg = BrandConfig {
            schema_version: BRAND_SCHEMA_VERSION,
            identity: BrandIdentity {
                app_name: "X".to_string(),
                display_name: "X".to_string(),
                tagline: None,
            },
            logo: Some(BrandLogo {
                file: "logo.png".to_string(),
            }),
            palette: None,
            notes: None,
            fonts: None,
            bundle: None,
            updater: None,
            runtime: None,
        };
        assert!(validate(&cfg).is_empty());
    }

    // -------------------------------------------------------------------
    // Identity
    // -------------------------------------------------------------------

    #[test]
    fn empty_identity_fields_are_rejected() {
        let cfg = BrandConfig {
            schema_version: BRAND_SCHEMA_VERSION,
            identity: BrandIdentity {
                app_name: "   ".to_string(),
                display_name: String::new(),
                tagline: None,
            },
            logo: None,
            palette: None,
            notes: None,
            fonts: None,
            bundle: None,
            updater: None,
            runtime: None,
        };
        let issues = validate(&cfg);
        assert!(issues
            .iter()
            .any(|i| i.field == "identity.appName" && i.severity == Severity::Error));
        assert!(issues
            .iter()
            .any(|i| i.field == "identity.displayName" && i.severity == Severity::Error));
    }

    #[test]
    fn overlong_identity_field_is_rejected() {
        let cfg = BrandConfig {
            schema_version: BRAND_SCHEMA_VERSION,
            identity: BrandIdentity {
                app_name: "x".repeat(65),
                display_name: "X".to_string(),
                tagline: None,
            },
            logo: None,
            palette: None,
            notes: None,
            fonts: None,
            bundle: None,
            updater: None,
            runtime: None,
        };
        let issues = validate(&cfg);
        assert!(issues
            .iter()
            .any(|i| i.field == "identity.appName" && i.severity == Severity::Error));
    }

    // -------------------------------------------------------------------
    // Contrast
    // -------------------------------------------------------------------

    #[test]
    fn low_contrast_ink_produces_a_warning_not_an_error() {
        // ink3 barely distinguishable from bg: near-identical dark greys.
        let source = VALID_FIXTURE.replace("ink3     = \"#8790A0\"", "ink3     = \"#12141A\"");
        let (_cfg, warnings) = parse(&source).expect("contrast failures must not block parse");
        assert!(
            warnings
                .iter()
                .any(|i| i.field == "palette.dark.ink3" && i.severity == Severity::Warning),
            "warnings: {warnings:?}"
        );
    }

    #[test]
    fn contrast_ratio_matches_known_value() {
        // Black on white is the canonical 21:1 maximum.
        let ratio = contrast_ratio("#000000", "#FFFFFF").unwrap();
        assert!((ratio - 21.0).abs() < 0.01, "ratio was {ratio}");
    }

    #[test]
    fn on_hue_against_hue_solid_is_checked() {
        let source = VALID_FIXTURE.replace(
            "onHue    = \"#FFFFFF\"\nok       = \"#3FB950\"\nwarn     = \"#D29922\"\nerr      = \"#F85149\"\nlink     = \"#58A6FF\"\n\n[palette.light]",
            "onHue    = \"#E9603A\"\nok       = \"#3FB950\"\nwarn     = \"#D29922\"\nerr      = \"#F85149\"\nlink     = \"#58A6FF\"\n\n[palette.light]",
        );
        let (_cfg, warnings) = parse(&source).expect("should still parse");
        assert!(
            warnings
                .iter()
                .any(|i| i.field == "palette.dark.onHue" && i.severity == Severity::Warning),
            "warnings: {warnings:?}"
        );
    }

    // -------------------------------------------------------------------
    // Absent palette
    // -------------------------------------------------------------------

    #[test]
    fn absent_palette_is_allowed() {
        let source = r##"+++
schemaVersion = 1

[identity]
appName     = "X"
displayName = "X"
+++
"##;
        let (cfg, warnings) = parse(source).expect("a brand may rename without restyling");
        assert!(cfg.palette.is_none());
        assert!(warnings.is_empty());
    }

    // -------------------------------------------------------------------
    // set_logo_reference
    // -------------------------------------------------------------------

    /// Deliberately includes a comment, a trailing inline comment on the
    /// value line, and a `#`-comment-looking (but not real) line in the
    /// body -- all of it must survive an edit untouched.
    const COMMENTED_FIXTURE: &str = "+++\n\
schemaVersion = 1\n\
\n\
# Core identity -- do not remove this section\n\
[identity]\n\
appName     = \"Northwind\"\n\
displayName = \"Northwind AI\"\n\
\n\
[logo]\n\
file = \"old-logo.png\"   # picked by design\n\
+++\n\
\n\
# Northwind notes\n\
\n\
Body text with **markdown** and a trailing comment-like # not a real comment.\n";

    const IDENTITY_WITH_EMPTY_LOGO_SECTION: &str = "+++\n\
schemaVersion = 1\n\
\n\
[identity]\n\
appName     = \"X\"\n\
displayName = \"X\"\n\
\n\
[logo]\n\
+++\n";

    const IDENTITY_ONLY_NO_LOGO: &str = "+++\nschemaVersion = 1\n\n[identity]\nappName     = \"X\"\ndisplayName = \"X\"\n+++\n\nSome notes.\n";

    #[test]
    fn set_logo_reference_replaces_existing_value() {
        let out = set_logo_reference(COMMENTED_FIXTURE, "new-logo.svg").unwrap();
        assert!(out.contains("file = \"new-logo.svg\"   # picked by design"));
        assert!(!out.contains("old-logo.png"));

        let (cfg, _warnings) = parse(&out).expect("edited source must still parse");
        assert_eq!(cfg.logo.unwrap().file, "new-logo.svg");
    }

    #[test]
    fn set_logo_reference_adds_key_to_existing_empty_section() {
        let out = set_logo_reference(IDENTITY_WITH_EMPTY_LOGO_SECTION, "logo.png").unwrap();
        assert!(out.contains("[logo]\nfile = \"logo.png\"\n"));

        let (cfg, _warnings) = parse(&out).expect("edited source must still parse");
        assert_eq!(cfg.logo.unwrap().file, "logo.png");
    }

    #[test]
    fn set_logo_reference_inserts_whole_section_when_absent() {
        let out = set_logo_reference(IDENTITY_ONLY_NO_LOGO, "logo.png").unwrap();
        assert!(out.contains("[logo]\nfile = \"logo.png\"\n"));

        let (cfg, _warnings) = parse(&out).expect("edited source must still parse");
        assert_eq!(cfg.logo.unwrap().file, "logo.png");

        // Nothing before the inserted section changed.
        assert!(out.starts_with(
            "+++\nschemaVersion = 1\n\n[identity]\nappName     = \"X\"\ndisplayName = \"X\"\n"
        ));
        // The body survives, appended after the (now-later) closing +++.
        assert!(out.trim_end().ends_with("Some notes."));
    }

    /// The property that actually matters: apart from the one value that
    /// changed, every byte of the frontmatter's comments and the entire
    /// Markdown body is reproduced exactly.
    #[test]
    fn set_logo_reference_preserves_comments_and_body_byte_for_byte() {
        let out = set_logo_reference(COMMENTED_FIXTURE, "new-logo.svg").unwrap();

        assert!(out.contains("# Core identity -- do not remove this section\n"));
        assert!(out.contains("appName     = \"Northwind\"\n"));
        assert!(out.contains("displayName = \"Northwind AI\"\n"));

        // Everything from the closing `+++` onward -- including the body's
        // own `#`-lookalike text -- is outside the frontmatter span entirely,
        // so it must come through completely untouched.
        let tail_from_closing_delimiter = "+++\n\n# Northwind notes\n\nBody text with \
             **markdown** and a trailing comment-like # not a real comment.\n";
        assert!(
            out.ends_with(tail_from_closing_delimiter),
            "everything from the closing +++ onward must survive verbatim: {out:?}"
        );
    }

    #[test]
    fn set_logo_reference_preserves_crlf() {
        let source = COMMENTED_FIXTURE.replace('\n', "\r\n");
        let out = set_logo_reference(&source, "new-logo.svg").unwrap();

        assert!(out.contains("file = \"new-logo.svg\"   # picked by design\r\n"));
        assert!(
            !out.replace("\r\n", "").contains('\n'),
            "no bare LF should appear in a CRLF document: {out:?}"
        );

        let (cfg, _warnings) = parse(&out).expect("CRLF edit must still parse");
        assert_eq!(cfg.logo.unwrap().file, "new-logo.svg");
    }

    #[test]
    fn set_logo_reference_inserts_section_with_crlf() {
        let source = IDENTITY_ONLY_NO_LOGO.replace('\n', "\r\n");
        let out = set_logo_reference(&source, "logo.png").unwrap();
        assert!(out.contains("[logo]\r\nfile = \"logo.png\"\r\n"));
        assert!(!out.replace("\r\n", "").contains('\n'));
    }

    #[test]
    fn set_logo_reference_rejects_traversal_filename() {
        let err = set_logo_reference(COMMENTED_FIXTURE, "../../etc/passwd").unwrap_err();
        match err {
            BrandError::Invalid(issues) => {
                assert!(issues
                    .iter()
                    .any(|i| i.field == "logo.file" && i.severity == Severity::Error));
            }
            other => panic!("expected Invalid(..), got {other:?}"),
        }
    }

    #[test]
    fn set_logo_reference_rejects_when_no_frontmatter() {
        let err = set_logo_reference("just markdown, no frontmatter", "logo.png").unwrap_err();
        assert_eq!(err, BrandError::MissingFrontmatter);
    }

    // -------------------------------------------------------------------
    // clear_logo_reference
    // -------------------------------------------------------------------

    #[test]
    fn clear_logo_reference_removes_the_section() {
        let out = clear_logo_reference(COMMENTED_FIXTURE).unwrap();
        assert!(!out.contains("[logo]"));
        assert!(!out.contains("old-logo.png"));

        let (cfg, _warnings) = parse(&out).expect("edited source must still parse");
        assert!(cfg.logo.is_none());

        // Identity and its comment, and the body, are untouched.
        assert!(out.contains("# Core identity -- do not remove this section\n"));
        assert!(out.contains("appName     = \"Northwind\"\n"));
        let tail_from_closing_delimiter = "+++\n\n# Northwind notes\n\nBody text with \
             **markdown** and a trailing comment-like # not a real comment.\n";
        assert!(out.ends_with(tail_from_closing_delimiter));
    }

    #[test]
    fn clear_logo_reference_is_a_no_op_when_absent() {
        let out = clear_logo_reference(IDENTITY_ONLY_NO_LOGO).unwrap();
        assert_eq!(out, IDENTITY_ONLY_NO_LOGO);
    }

    #[test]
    fn clear_logo_reference_removes_a_logo_section_that_is_the_first_frontmatter_line() {
        let source = "+++\n[logo]\nfile = \"logo.png\"\n\n[identity]\nappName = \"X\"\ndisplayName = \"X\"\n+++\n";
        let out = clear_logo_reference(source).unwrap();
        assert!(!out.contains("[logo]"));
        assert!(out.contains("[identity]"));
    }

    // -------------------------------------------------------------------
    // Deep-equality helpers
    // -------------------------------------------------------------------
    //
    // `BrandConfig` and its nested types deliberately do not derive
    // `PartialEq` in `schema.rs` -- they stay exactly as ts-rs-exports them,
    // untouched by this phase of work. These reimplement just enough
    // structural equality for the round-trip/merge tests below without
    // adding a derive there.

    fn assert_identity_eq(a: &BrandIdentity, b: &BrandIdentity) {
        assert_eq!(a.app_name, b.app_name, "appName");
        assert_eq!(a.display_name, b.display_name, "displayName");
        assert_eq!(a.tagline, b.tagline, "tagline");
    }

    fn assert_logo_eq(a: &Option<BrandLogo>, b: &Option<BrandLogo>) {
        match (a, b) {
            (Some(x), Some(y)) => assert_eq!(x.file, y.file, "logo.file"),
            (None, None) => {}
            _ => panic!("logo presence differs: {a:?} vs {b:?}"),
        }
    }

    fn assert_palette_eq(a: &Option<BrandThemes>, b: &Option<BrandThemes>) {
        match (a, b) {
            (Some(x), Some(y)) => {
                assert_eq!(
                    palette_fields(&x.dark),
                    palette_fields(&y.dark),
                    "palette.dark"
                );
                assert_eq!(
                    palette_fields(&x.light),
                    palette_fields(&y.light),
                    "palette.light"
                );
            }
            (None, None) => {}
            _ => panic!("palette presence differs: {a:?} vs {b:?}"),
        }
    }

    fn assert_brand_config_eq(a: &BrandConfig, b: &BrandConfig) {
        assert_eq!(a.schema_version, b.schema_version, "schemaVersion");
        assert_identity_eq(&a.identity, &b.identity);
        assert_logo_eq(&a.logo, &b.logo);
        assert_palette_eq(&a.palette, &b.palette);
        assert_eq!(a.notes, b.notes, "notes");
    }

    #[test]
    fn clear_logo_reference_then_set_logo_reference_round_trips() {
        let cleared = clear_logo_reference(COMMENTED_FIXTURE).unwrap();
        let restored = set_logo_reference(&cleared, "logo.png").unwrap();
        let (cfg, _warnings) = parse(&restored).expect("restored source must parse");
        assert_eq!(cfg.logo.unwrap().file, "logo.png");
    }

    // -------------------------------------------------------------------
    // render_brand_md
    // -------------------------------------------------------------------

    #[test]
    fn render_brand_md_round_trips() {
        let (cfg, warnings) = parse(VALID_FIXTURE).expect("fixture should parse");
        assert!(warnings.is_empty());

        let rendered = render_brand_md(&cfg);
        let (round_tripped, warnings) = parse(&rendered)
            .unwrap_or_else(|err| panic!("rendered brand.md must parse: {err}\n\n{rendered}"));

        assert_brand_config_eq(&cfg, &round_tripped);
        assert!(warnings.is_empty(), "warnings: {warnings:?}");
    }

    #[test]
    fn render_brand_md_quotes_every_hex_value() {
        let (cfg, _warnings) = parse(VALID_FIXTURE).unwrap();
        let rendered = render_brand_md(&cfg);

        // The format's single sharpest edge: a bare `= #......` would be a
        // TOML comment, silently discarding the value. Every colour line
        // must instead read `= "#......"`.
        for line in rendered.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with('#') || !trimmed.contains('=') {
                continue;
            }
            let value = trimmed.split('=').nth(1).unwrap().trim();
            if value.trim_start_matches('"').starts_with('#') {
                assert!(
                    value.starts_with('"'),
                    "unquoted hex value in rendered output: {line:?}"
                );
            }
        }
        assert!(
            rendered.contains("bg       = \"#0F1115\"") || rendered.contains("bg = \"#0F1115\"")
        );
    }

    #[test]
    fn render_brand_md_without_notes_uses_a_default_body() {
        let mut cfg = parse(VALID_FIXTURE).unwrap().0;
        cfg.notes = None;

        let rendered = render_brand_md(&cfg);
        let (round_tripped, _warnings) = parse(&rendered).expect("must still parse");

        // The default body is filled in, not left empty or `None` --
        // see `default_notes_body`'s doc comment for why.
        assert!(round_tripped.notes.is_some());
        assert!(round_tripped
            .notes
            .as_deref()
            .unwrap()
            .contains(&cfg.identity.display_name));

        // Every field *other* than notes still round-trips exactly.
        assert_identity_eq(&round_tripped.identity, &cfg.identity);
        assert_logo_eq(&round_tripped.logo, &cfg.logo);
        assert_palette_eq(&round_tripped.palette, &cfg.palette);
    }

    #[test]
    fn render_brand_md_omits_absent_logo_and_palette() {
        let cfg = BrandConfig {
            schema_version: BRAND_SCHEMA_VERSION,
            identity: BrandIdentity {
                app_name: "X".to_string(),
                display_name: "X".to_string(),
                tagline: None,
            },
            logo: None,
            palette: None,
            notes: Some("Notes.".to_string()),
            fonts: None,
            bundle: None,
            updater: None,
            runtime: None,
        };
        let rendered = render_brand_md(&cfg);
        assert!(!rendered.contains("[logo]"));
        assert!(!rendered.contains("[palette"));
        assert!(!rendered.contains("tagline"));

        let (round_tripped, _warnings) = parse(&rendered).expect("must parse");
        assert_brand_config_eq(&round_tripped, &cfg);
    }

    // -------------------------------------------------------------------
    // merge_brand_edits
    // -------------------------------------------------------------------

    /// A richer fixture than [`VALID_FIXTURE`]: a leading section comment, an
    /// inline trailing comment on the logo line, and a Markdown body
    /// containing a `#`-lookalike -- everything a merge must leave untouched
    /// unless the corresponding field actually changed.
    const MERGE_FIXTURE: &str = "+++\n\
schemaVersion = 1\n\
\n\
# Core identity -- do not remove this section\n\
[identity]\n\
appName     = \"Northwind\"\n\
displayName = \"Northwind AI\"\n\
\n\
[logo]\n\
file = \"logo.png\"   # picked by design\n\
\n\
[palette.dark]\n\
bg       = \"#0F1115\"\n\
bgSide   = \"#0B0D11\"\n\
card     = \"#161A21\"\n\
cardHi   = \"#1D222B\"\n\
line     = \"#252B36\"\n\
lineSoft = \"#1D222B\"\n\
lineHi   = \"#2E3542\"\n\
ink      = \"#E8EAED\"\n\
ink2     = \"#A8AEB8\"\n\
ink3     = \"#8790A0\"\n\
hue      = \"#E4572E\"\n\
hueText  = \"#FF8A61\"\n\
hueSolid = \"#B8441F\"\n\
onHue    = \"#FFFFFF\"\n\
ok       = \"#3FB950\"\n\
warn     = \"#D29922\"\n\
err      = \"#F85149\"\n\
link     = \"#58A6FF\"\n\
\n\
[palette.light]\n\
bg       = \"#FBFAF8\"\n\
bgSide   = \"#F3F1EC\"\n\
card     = \"#FFFFFF\"\n\
cardHi   = \"#F3F1EC\"\n\
line     = \"#E4E0D8\"\n\
lineSoft = \"#EDEAE2\"\n\
lineHi   = \"#CFC9BC\"\n\
ink      = \"#1E1B16\"\n\
ink2     = \"#4A4438\"\n\
ink3     = \"#6E6656\"\n\
hue      = \"#B8441F\"\n\
hueText  = \"#9A3A1B\"\n\
hueSolid = \"#B8441F\"\n\
onHue    = \"#FFFFFF\"\n\
ok       = \"#1A7F37\"\n\
warn     = \"#9A6700\"\n\
err      = \"#CF222E\"\n\
link     = \"#0969DA\"\n\
+++\n\
\n\
# Northwind notes\n\
\n\
Body text with **markdown** and a trailing comment-like # not a real comment.\n";

    const MERGE_FIXTURE_NO_PALETTE: &str = "+++\n\
schemaVersion = 1\n\
\n\
[identity]\n\
appName     = \"X\"\n\
displayName = \"X\"\n\
+++\n\
\n\
Some notes.\n";

    #[test]
    fn merge_unchanged_config_is_byte_identical() {
        let (cfg, _warnings) = parse(MERGE_FIXTURE).unwrap();
        let merged = merge_brand_edits(MERGE_FIXTURE, &cfg).unwrap();
        assert_eq!(merged, MERGE_FIXTURE);
    }

    #[test]
    fn merge_one_colour_change_rewrites_exactly_one_line() {
        let (mut cfg, _warnings) = parse(MERGE_FIXTURE).unwrap();
        cfg.palette.as_mut().unwrap().dark.hue = "#00FF00".to_string();

        let merged = merge_brand_edits(MERGE_FIXTURE, &cfg).unwrap();
        assert_ne!(merged, MERGE_FIXTURE);

        let before: Vec<&str> = MERGE_FIXTURE.lines().collect();
        let after: Vec<&str> = merged.lines().collect();
        assert_eq!(before.len(), after.len(), "line count must not change");

        let diffs: Vec<(usize, &str, &str)> = before
            .iter()
            .zip(after.iter())
            .enumerate()
            .filter(|(_, (a, b))| a != b)
            .map(|(i, (a, b))| (i, *a, *b))
            .collect();
        assert_eq!(
            diffs.len(),
            1,
            "expected exactly one changed line: {diffs:?}"
        );
        assert!(diffs[0].2.contains("#00FF00"));

        // Comments, other palette lines, and the body are untouched.
        assert!(merged.contains("# Core identity -- do not remove this section\n"));
        assert!(merged.contains("file = \"logo.png\"   # picked by design\n"));
        assert!(merged.contains("Body text with **markdown**"));

        let (round_tripped, _warnings) = parse(&merged).expect("merged source must parse");
        assert_eq!(round_tripped.palette.unwrap().dark.hue, "#00FF00");
    }

    #[test]
    fn merge_adds_a_palette_when_absent() {
        let (mut cfg, _warnings) = parse(MERGE_FIXTURE_NO_PALETTE).unwrap();
        let (source_with_palette, _warnings) = parse(VALID_FIXTURE).unwrap();
        cfg.palette = source_with_palette.palette.clone();

        let merged = merge_brand_edits(MERGE_FIXTURE_NO_PALETTE, &cfg).unwrap();
        assert!(merged.contains("[palette.dark]"));
        assert!(merged.contains("[palette.light]"));
        // Identity and the body survive untouched.
        assert!(merged.contains("appName     = \"X\""));
        assert!(merged.trim_end().ends_with("Some notes."));

        let (round_tripped, warnings) = parse(&merged).expect("merged source must parse");
        assert_palette_eq(&round_tripped.palette, &cfg.palette);
        assert!(warnings.is_empty(), "warnings: {warnings:?}");
    }

    #[test]
    fn merge_removes_the_palette_when_config_drops_it() {
        let (mut cfg, _warnings) = parse(MERGE_FIXTURE).unwrap();
        cfg.palette = None;

        let merged = merge_brand_edits(MERGE_FIXTURE, &cfg).unwrap();
        assert!(!merged.contains("[palette.dark]"));
        assert!(!merged.contains("[palette.light]"));
        assert!(merged.contains("# Core identity -- do not remove this section\n"));
        assert!(merged.contains("file = \"logo.png\"   # picked by design\n"));

        let (round_tripped, _warnings) = parse(&merged).expect("merged source must parse");
        assert!(round_tripped.palette.is_none());
    }

    #[test]
    fn merge_preserves_crlf() {
        let source = MERGE_FIXTURE.replace('\n', "\r\n");
        let (mut cfg, _warnings) = parse(&source).unwrap();
        cfg.palette.as_mut().unwrap().light.err = "#123456".to_string();

        let merged = merge_brand_edits(&source, &cfg).unwrap();
        assert!(merged.contains("err      = \"#123456\"\r\n"));
        assert!(
            !merged.replace("\r\n", "").contains('\n'),
            "no bare LF should appear in a CRLF document: {merged:?}"
        );
    }

    #[test]
    fn merge_replaces_the_body_only_when_notes_differ() {
        let (mut cfg, _warnings) = parse(MERGE_FIXTURE).unwrap();
        cfg.notes = Some("Completely different notes.".to_string());

        let merged = merge_brand_edits(MERGE_FIXTURE, &cfg).unwrap();
        assert!(merged.contains("Completely different notes."));
        assert!(!merged.contains("Body text with **markdown**"));
        // Frontmatter is untouched -- only the body changed.
        assert!(merged.contains("# Core identity -- do not remove this section\n"));
        assert!(merged.contains("file = \"logo.png\"   # picked by design\n"));
        assert!(merged.contains("hue      = \"#E4572E\"\n"));
    }

    #[test]
    fn merge_adds_a_tagline_when_previously_absent() {
        let (mut cfg, _warnings) = parse(MERGE_FIXTURE).unwrap();
        assert!(cfg.identity.tagline.is_none());
        cfg.identity.tagline = Some("Message Northwind...".to_string());

        let merged = merge_brand_edits(MERGE_FIXTURE, &cfg).unwrap();
        assert!(merged.contains("tagline = \"Message Northwind...\""));

        let (round_tripped, _warnings) = parse(&merged).expect("merged source must parse");
        assert_eq!(
            round_tripped.identity.tagline.as_deref(),
            Some("Message Northwind...")
        );
    }

    #[test]
    fn merge_removes_a_tagline_when_config_drops_it() {
        let source = MERGE_FIXTURE.replacen(
            "displayName = \"Northwind AI\"\n",
            "displayName = \"Northwind AI\"\ntagline     = \"Message Northwind...\"\n",
            1,
        );
        let (mut cfg, _warnings) = parse(&source).unwrap();
        assert!(cfg.identity.tagline.is_some());
        cfg.identity.tagline = None;

        let merged = merge_brand_edits(&source, &cfg).unwrap();
        assert!(!merged.contains("tagline"));
        assert!(merged.contains("appName     = \"Northwind\"\n"));
        assert!(merged.contains("displayName = \"Northwind AI\"\n"));

        let (round_tripped, _warnings) = parse(&merged).expect("merged source must parse");
        assert!(round_tripped.identity.tagline.is_none());
    }

    // -------------------------------------------------------------------
    // brand.template.md
    // -------------------------------------------------------------------

    /// The starter template documented in `docs/branding/brand.template.md`
    /// must actually parse -- mirrors how `cssContract.test.ts` reads real
    /// files off disk rather than a fixture that can drift from what the
    /// repo actually ships.
    #[test]
    fn brand_template_parses_with_no_errors() {
        let source = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/branding/brand.template.md"
        ));
        let (_cfg, warnings) =
            parse(source).expect("docs/branding/brand.template.md must parse cleanly");
        assert!(
            warnings.is_empty(),
            "brand.template.md should clear WCAG AA with no warnings: {warnings:?}"
        );
    }

    // -------------------------------------------------------------------
    // Build profile (Mode B) -- presence notices + content validation
    // -------------------------------------------------------------------

    const BUILD_PROFILE_FIXTURE: &str = r##"+++
schemaVersion = 1

[identity]
appName     = "Northwind"
displayName = "Northwind AI"

[fonts]
ui   = "Soehne.woff2"
mono = "SoehneMono.woff2"

[bundle]
productName = "Northwind AI"
identifier  = "com.northwind.ai"

[updater]
endpoint = "https://updates.northwind.example/stable/manifest.json"
pubkey   = "abc123"

[runtime]
allowUserBranding = false
+++
"##;

    #[test]
    fn build_profile_sections_are_captured_and_noticed() {
        let (cfg, warnings) =
            parse(BUILD_PROFILE_FIXTURE).expect("build-profile fixture should parse cleanly");

        assert!(cfg.fonts.is_some());
        assert!(cfg.bundle.is_some());
        assert!(cfg.updater.is_some());
        assert!(cfg.runtime.is_some());

        for section in ["fonts", "bundle", "updater", "runtime"] {
            assert!(
                warnings
                    .iter()
                    .any(|w| w.field == section && w.severity == Severity::Warning),
                "expected a Warning-severity notice for [{section}]: {warnings:?}"
            );
        }
        // Never an error: a brand file describing a build profile is still a
        // perfectly valid file for Mode A to read and (mostly) ignore.
        assert!(warnings.iter().all(|w| w.severity == Severity::Warning));
    }

    #[test]
    fn no_build_profile_sections_means_no_build_profile_warnings() {
        // `VALID_FIXTURE`'s own round-trip test already asserts
        // `warnings.is_empty()` overall; this test names the specific
        // property so a future warning source elsewhere in `validate`
        // cannot make this regress silently under a broader assertion.
        let (_cfg, warnings) = parse(VALID_FIXTURE).expect("fixture should parse cleanly");
        for section in ["fonts", "bundle", "updater", "runtime"] {
            assert!(
                !warnings.iter().any(|w| w.field == section),
                "no [{section}] in VALID_FIXTURE, so there must be no notice for it"
            );
        }
    }

    #[test]
    fn font_path_traversal_is_rejected() {
        let source = BUILD_PROFILE_FIXTURE.replace(
            r#"ui   = "Soehne.woff2""#,
            r#"ui   = "../../etc/evil.woff2""#,
        );
        let err = parse(&source).unwrap_err();
        match err {
            BrandError::Invalid(issues) => {
                assert!(
                    issues
                        .iter()
                        .any(|i| i.field == "fonts.ui" && i.severity == Severity::Error),
                    "expected an Error on fonts.ui: {issues:?}"
                );
            }
            other => panic!("expected Invalid(..), got {other:?}"),
        }
    }

    #[test]
    fn bundle_identifier_not_reverse_dns_warns() {
        let source = BUILD_PROFILE_FIXTURE.replace(
            r#"identifier  = "com.northwind.ai""#,
            r#"identifier  = "Northwind""#,
        );
        let (_cfg, warnings) = parse(&source).expect("still valid, just a warning");
        assert!(
            warnings
                .iter()
                .any(|w| w.field == "bundle.identifier" && w.severity == Severity::Warning),
            "expected a warning on bundle.identifier: {warnings:?}"
        );
    }

    #[test]
    fn bundle_identifier_reverse_dns_does_not_warn() {
        let (_cfg, warnings) =
            parse(BUILD_PROFILE_FIXTURE).expect("build-profile fixture should parse cleanly");
        assert!(
            !warnings.iter().any(|w| w.field == "bundle.identifier"),
            "com.northwind.ai should not trigger the reverse-DNS warning: {warnings:?}"
        );
    }

    #[test]
    fn updater_endpoint_must_be_https() {
        let source = BUILD_PROFILE_FIXTURE.replace(
            r#"endpoint = "https://updates.northwind.example/stable/manifest.json""#,
            r#"endpoint = "http://updates.northwind.example/stable/manifest.json""#,
        );
        let err = parse(&source).unwrap_err();
        match err {
            BrandError::Invalid(issues) => {
                assert!(
                    issues
                        .iter()
                        .any(|i| i.field == "updater.endpoint" && i.severity == Severity::Error),
                    "expected an Error on updater.endpoint: {issues:?}"
                );
            }
            other => panic!("expected Invalid(..), got {other:?}"),
        }
    }
}
