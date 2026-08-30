// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Mode B build-time emitter -- turns a validated [`crate::brand::BrandConfig`]
//! into the static files `examples/apply_brand.rs` writes to disk.
//!
//! Kept as ordinary, testable library functions rather than living inline in
//! the example so `cargo test -p provider-core` exercises them directly, and
//! so the cross-language equivalence test in `apps/desktop` (white-label
//! plan §6, "Equivalence (the important one)") can invoke exactly this code
//! by running the compiled `apply_brand` example, rather than a second, TS
//! reimplementation of it that could quietly drift.
//!
//! ## The specificity problem this file exists to solve
//!
//! `packages/ui/src/tokens.css` sets `--hue`/`--hue-text`/`--hue-solid`/
//! `--hue-weak` inside `[data-provider="anthropic|openai|ollama|custom"]`
//! blocks (specificity `(0,1,0)` -- one attribute selector), and `<html>`
//! always carries a `data-provider` attribute (`App.tsx`'s provider-tint
//! effect sets one unconditionally, regardless of branding). A brand
//! override on plain `:root` (also `(0,1,0)`) would therefore *tie* with
//! those blocks, decided only by source/import order between
//! `brand.generated.css` and `tokens.css` -- and nothing pins that order; a
//! bundler is free to reorder CSS imports. Depending on it would be exactly
//! the class of bug `apps/desktop/src/brand/applyBrand.ts`'s `deriveHueWeak`
//! comment documents Mode A already hit once (`--hue-weak` quietly staying
//! on a provider's wash instead of tracking the brand accent).
//!
//! Repeating `:root` raises specificity without changing what it selects --
//! `:root:root` is the same one element, matched twice. Each repetition adds
//! one to the selector's class/attribute/pseudo-class component. This file
//! uses:
//!
//!   - `:root:root`                     -- `(0,2,0)`, unconditionally beats
//!     the `(0,1,0)` `[data-provider]` blocks regardless of import order.
//!   - `:root:root[data-theme="light"]` -- `(0,3,0)`, unconditionally beats
//!     the light-mode compound `[data-theme="light"] [data-provider="x"]`
//!     blocks, which are `(0,2,0)`.
//!
//! Order-independence is the point: it reproduces the same property
//! Mode A's inline `setProperty` calls get for free (an inline style always
//! wins the cascade), using a static selector since a build-time emitter has
//! no `style` attribute to write into.
//!
//! **Known, deliberately unsolved edge case:** this does not also try to
//! outrank the Orange Charcoal preset
//! (`html[data-palette="orange-charcoal"][data-provider]`, specificity
//! `(0,2,1)`) in dark mode -- `(0,2,0)` loses to `(0,2,1)` on the third
//! component. In light mode, this file's `(0,3,0)` *does* outrank Orange
//! Charcoal's theme-agnostic `(0,2,1)` block, which is an asymmetry: a
//! reseller's brand accent would lose to a user's Orange Charcoal choice in
//! dark mode but win over it in light mode. There is no selector-specificity
//! value strictly between `(0,2,0)` and `(0,2,1)`, so closing this requires
//! either matching Orange Charcoal's specificity exactly (which reintroduces
//! the very order-dependency this design avoids) or an explicit decision
//! about whether a brand should ever be allowed to override a user's own
//! renderer-only appearance preference at all -- which is `data-palette`
//! composition, open question 5 in the plan doc, not yet answered for either
//! mode. Out of scope for this phase: the task this file exists for is
//! winning over `[data-provider]`, which it does, unconditionally, in both
//! themes.
//!
//! [`NEUTRALIZE_PROVIDER_HUE_ON_DESCENDANTS`] below does not change this
//! asymmetry -- it makes every `[data-provider]` *descendant* agree with
//! whatever `<html>` itself already resolved to (by forcing them to
//! `inherit` rather than use their own block's literal), rather than each
//! independently keeping its own per-provider colour regardless of theme or
//! Orange Charcoal. Before that rule, a message bubble's hue was
//! disconnected from this root-level story entirely; after it, the bubble
//! agrees with the root every time, so the brand-vs-Orange-Charcoal
//! asymmetry (if it is ever exercised at all -- see below) is at least
//! uniform across the whole page instead of split between root and
//! descendants.
//!
//! ## The bug this file's palette override could not reach on its own
//!
//! Winning over `[data-provider]` at the root is necessary but not
//! sufficient: `tokens.css`'s `[data-provider="..."]` selector matches ANY
//! element carrying that attribute, not only `<html>`, and several
//! descendants set their own independently of it (message bubbles, the
//! model picker, sidebar chips -- see [`NEUTRALIZE_PROVIDER_HUE_ON_DESCENDANTS`]'s
//! own doc comment for the exact call sites). A custom property re-declared
//! on a descendant wins over an ancestor's value for that element
//! regardless of the ancestor rule's specificity, because that is ordinary
//! CSS *inheritance*, which is an entirely different mechanism from cascade
//! *specificity* -- specificity only ever decides among rules competing for
//! the same element. `:root:root`'s specificity, however large, cannot make
//! it reach an element it does not select in the first place. Mode A's
//! inline `setProperty` on `<html>` has the exact same blind spot for the
//! exact same reason. [`NEUTRALIZE_PROVIDER_HUE_ON_DESCENDANTS`] is what
//! closes it for Mode B; `packages/ui/src/tokens.css`'s
//! `html[data-palette="brand"] [data-provider]` rule closes the identical
//! gap for Mode A, scoped to `data-palette="brand"` so a stock
//! (non-branded) build keeps per-element provider colour working exactly
//! as before. Neither is a dual form pairing a compound `<html>` selector
//! with the descendant one (the way the Orange Charcoal precedent in
//! `tokens.css` does) -- see [`NEUTRALIZE_PROVIDER_HUE_ON_DESCENDANTS`]'s
//! own doc comment for why `inherit` specifically makes that compound form
//! actively harmful at the root, unlike Orange Charcoal's concrete
//! `var(--oc-hue)` value. Both modes rely on the same mechanism (forcing
//! `--hue`/`--hue-text`/`--hue-solid`/`--hue-weak` to `inherit` on
//! `[data-provider]` descendants, `<html>` itself deliberately excluded) so
//! that a descendant's resolved colour always traces back to whichever
//! root value the active mode actually set -- the inline value in Mode A,
//! `:root:root` in Mode B -- which is what keeps the two genuinely
//! equivalent rather than only
//! agreeing at the root.

use crate::schema::{BrandConfig, BrandFonts, BrandPalette, BrandThemes};

// =============================================================================
// Palette -> CSS custom property map
// =============================================================================

/// Schema key -> CSS custom-property name, in [`BrandPalette`]'s field order.
///
/// MUST mirror `apps/desktop/src/brand/applyBrand.ts`'s `PALETTE_PROPERTY_MAP`
/// exactly -- same 18 keys, same property names. That TS map is typed
/// `Record<keyof BrandPalette, string>`, so the ts-rs-generated `BrandPalette`
/// type already guarantees it has all 18 *keys*; what it cannot guarantee is
/// that this Rust map and that TS map spell the same CSS property name for a
/// given key (e.g. one side typo'ing `--ink-2` as `--ink2`). That is exactly
/// the drift the cross-language equivalence test in
/// `apps/desktop/src/brand/brandEquivalence.test.ts` exists to catch --  it
/// runs this emitter for real and diffs its output against
/// `PALETTE_PROPERTY_MAP` + `deriveHueWeak`, so a change to either map alone
/// fails that test loudly.
fn palette_css_pairs(p: &BrandPalette) -> [(&'static str, &str); 18] {
    [
        ("--bg", p.bg.as_str()),
        ("--bg-side", p.bg_side.as_str()),
        ("--card", p.card.as_str()),
        ("--card-hi", p.card_hi.as_str()),
        ("--line", p.line.as_str()),
        ("--line-soft", p.line_soft.as_str()),
        ("--line-hi", p.line_hi.as_str()),
        ("--ink", p.ink.as_str()),
        ("--ink-2", p.ink2.as_str()),
        ("--ink-3", p.ink3.as_str()),
        ("--hue", p.hue.as_str()),
        ("--hue-text", p.hue_text.as_str()),
        ("--hue-solid", p.hue_solid.as_str()),
        ("--on-hue", p.on_hue.as_str()),
        ("--ok", p.ok.as_str()),
        ("--warn", p.warn.as_str()),
        ("--err", p.err.as_str()),
        ("--link", p.link.as_str()),
    ]
}

/// `color-mix(in srgb, <hue> 14%, transparent)` -- MUST match
/// `apps/desktop/src/brand/applyBrand.ts`'s `deriveHueWeak` byte for byte.
/// See that function's doc comment for why `--hue-weak` needs an explicit
/// derivation step at all rather than coming free with `--hue` the way
/// `--hue-a08/12/20/40` do (tokens.css derives those four with `color-mix()`
/// already; it does not for `--hue-weak`, because every place that value
/// resolves in the shipped app is either a literal `transparent` or another
/// hardcoded-hex `color-mix()`, never `var(--hue)`).
fn derive_hue_weak(hue: &str) -> String {
    format!("color-mix(in srgb, {hue} 14%, transparent)")
}

fn render_theme_block(selector: &str, palette: &BrandPalette, extra_lines: &str) -> String {
    let mut out = format!("{selector} {{\n");
    for (prop, value) in palette_css_pairs(palette) {
        out.push_str(&format!("  {prop}: {value};\n"));
    }
    out.push_str(&format!(
        "  --hue-weak: {};\n",
        derive_hue_weak(palette.hue.as_str())
    ));
    out.push_str(extra_lines);
    out.push_str("}\n");
    out
}

// =============================================================================
// Fonts
// =============================================================================

/// One of the three faces a brand may replace. Deliberately three fixed,
/// pre-named destination files (`brand-ui.woff2`, not the reseller's own
/// filename) rather than copying under the source name: a fixed, small,
/// known set of destination filenames is what lets `.gitignore` name these
/// three paths exactly, instead of needing a pattern broad enough to catch
/// an arbitrary reseller-chosen filename -- which would risk also ignoring
/// a future *stock* font shipped under a similar name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontRole {
    Ui,
    Mono,
    Serif,
}

impl FontRole {
    pub fn css_var(self) -> &'static str {
        match self {
            FontRole::Ui => "--font-ui",
            FontRole::Mono => "--font-mono",
            FontRole::Serif => "--font-serif",
        }
    }

    /// Filename this font is copied to under `packages/ui/src/fonts/`.
    pub fn dest_filename(self) -> &'static str {
        match self {
            FontRole::Ui => "brand-ui.woff2",
            FontRole::Mono => "brand-mono.woff2",
            FontRole::Serif => "brand-serif.woff2",
        }
    }

    /// The generic-family fallback tail, mirroring the corresponding stock
    /// stack in `packages/ui/src/tokens.css`'s `:root` block (minus the
    /// bundled-face name itself, which the brand's own face replaces).
    /// `--font-serif` ending in `serif`/`ui-serif` is asserted directly by
    /// `cssContract.test.ts`'s Guard G8 ("--font-serif ends in a generic
    /// family"), which is why this tail is not just "a reasonable fallback"
    /// but specifically matches what that guard checks for.
    fn fallback_tail(self) -> &'static str {
        match self {
            FontRole::Ui => {
                r#"ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif"#
            }
            FontRole::Mono => r#"ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace"#,
            FontRole::Serif => r#"Charter, "Iowan Old Style", Georgia, ui-serif, serif"#,
        }
    }
}

/// Strip a `.woff2` (or other common web-font) extension, case-insensitively,
/// to get a usable `font-family` name out of a brand-supplied filename like
/// `Soehne.woff2` -> `Soehne`. `BrandFonts` carries only a filename, not a
/// separate family-name field (see its doc comment in `schema.rs`), so the
/// filename stem is the only name available; the validator (`validate_fonts`
/// in `brand.rs`) already constrains this to a bare filename with no path
/// separators, so there is nothing here to sanitize beyond the extension.
fn font_family_name(filename: &str) -> &str {
    for ext in [".woff2", ".woff", ".ttf", ".otf"] {
        // Safe to byte-slice at `len - ext.len()`: `ends_with` only matches
        // true when the lowercased tail is exactly this all-ASCII `ext`, and
        // an ASCII byte can never be a UTF-8 continuation byte, so that
        // boundary is always a valid char boundary regardless of what
        // (possibly multi-byte) characters precede it.
        if filename.to_ascii_lowercase().ends_with(ext) {
            return &filename[..filename.len() - ext.len()];
        }
    }
    filename
}

fn render_font_faces(fonts: &BrandFonts) -> String {
    let mut out = String::new();
    for (role, filename) in font_entries(fonts) {
        let family = font_family_name(&filename);
        out.push_str(&format!(
            "@font-face {{\n  font-family: \"{family}\";\n  \
             /* A single bundled file standing in for the whole face at every\n     \
             weight it is asked for, since `BrandFonts` names one file per role,\n     \
             not a family of weights -- a wide `font-weight` range means the\n     \
             browser always uses this face rather than silently falling back to\n     \
             the next family in the stack for, say, a bold request. */\n  \
             font-weight: 100 900;\n  font-style: normal;\n  font-display: swap;\n  \
             src: url(\"./fonts/{}\") format(\"woff2\");\n}}\n",
            role.dest_filename()
        ));
    }
    out
}

fn render_font_vars(fonts: &BrandFonts) -> String {
    let mut out = String::new();
    for (role, filename) in font_entries(fonts) {
        let family = font_family_name(&filename);
        out.push_str(&format!(
            "  {}: \"{family}\", {};\n",
            role.css_var(),
            role.fallback_tail()
        ));
    }
    out
}

/// `(role, source filename)` for every font a brand actually names, in a
/// fixed order -- shared by [`render_font_faces`]/[`render_font_vars`]
/// (which only need the filename to build a `font-family` name) and
/// [`font_copy_plan`] (which the `apply_brand` example uses to know which
/// bytes to copy where).
fn font_entries(fonts: &BrandFonts) -> Vec<(FontRole, String)> {
    let mut out = Vec::new();
    if let Some(f) = &fonts.ui {
        out.push((FontRole::Ui, f.clone()));
    }
    if let Some(f) = &fonts.mono {
        out.push((FontRole::Mono, f.clone()));
    }
    if let Some(f) = &fonts.serif {
        out.push((FontRole::Serif, f.clone()));
    }
    out
}

/// Public entry point for `examples/apply_brand.rs`: which brand-directory
/// files to copy to which fixed destination under `packages/ui/src/fonts/`.
pub fn font_copy_plan(fonts: &BrandFonts) -> Vec<(FontRole, String)> {
    font_entries(fonts)
}

// =============================================================================
// The generated CSS file
// =============================================================================

fn css_header_comment(invocation: &str) -> String {
    format!(
        "/* GENERATED FILE -- do not hand edit.\n *\n * Produced by:\n *   {invocation}\n *\n \
         * Mode B (white-label) build-time emitter output -- see\n \
         * docs/private/white-label-plan.md \u{a7}5. Re-running the command above\n \
         * regenerates this file from <brand-dir>/brand.md; any hand edit here is\n \
         * silently discarded the next time it runs.\n *\n \
         * `:root:root` / `:root:root[data-theme=\"light\"]` (not plain `:root`)\n \
         * is deliberate -- see this crate's `src/brand_emit.rs` module doc\n \
         * comment for the selector-specificity reasoning: it is what makes this\n \
         * file's palette win over `tokens.css`'s `[data-provider=\"...\"]` blocks\n \
         * regardless of CSS import order. */\n\n"
    )
}

/// The descendant-neutralization rule -- the fix for the bug custom-property
/// *inheritance* (not cascade specificity) creates for a root-level palette
/// override: `packages/ui/src/tokens.css`'s `[data-provider="..."]` blocks
/// match ANY element carrying that attribute, not only `<html>` --
/// `AssistantMessage.tsx`, `ChatView.tsx`, `ComposerModelPicker.tsx` and
/// `Sidebar.tsx` all set their own `data-provider` independently of
/// `<html>`, on message bubbles, model-picker rows and sidebar chips. A
/// custom property re-declared on a descendant element wins over whatever
/// an ancestor says for that SAME property on that element regardless of
/// the ancestor rule's specificity -- specificity only ever decides among
/// rules targeting the *same* element. Forcing the four hue-identity
/// properties to `inherit` on every `[data-provider]` DESCENDANT makes them
/// chain back up through the DOM to whatever `:root:root` (or, in light
/// mode, `:root:root[data-theme="light"]`) actually declares, instead of
/// using their own block's literal per-provider value.
///
/// **Descendant-only, deliberately not a dual form.** The Orange Charcoal
/// precedent above (`html[data-palette="orange-charcoal"][data-provider],
/// html[data-palette="orange-charcoal"] [data-provider]`) pairs a compound
/// selector matching `<html>` itself with a descendant selector, because
/// `<html>` always carries `data-provider` too (`App.tsx`'s provider-tint
/// effect sets it unconditionally) and that rule's value
/// (`var(--oc-hue)`) is a perfectly good, concrete value to apply directly
/// to `<html>`. This rule's value is `inherit`, which is NOT safe to apply
/// to `<html>` itself: `<html>` is the actual DOM root, so `inherit` there
/// has no parent to climb to and resolves to nothing, which would silently
/// blank `--hue` out at the root -- worse than the bug this rule exists to
/// fix. (An earlier draft of this rule copied the dual form directly from
/// Orange Charcoal without checking that its value tolerated being applied
/// to the root the same way a concrete value does; the resolver self-tests
/// in `apps/desktop/src/brand/miniCascade.test.ts` are what caught it.) So
/// only the plain descendant selector is used here: it requires SOME
/// ancestor to satisfy `:root:root`, which `<html>` itself, having no
/// ancestors, never can -- `<html>`'s own `--hue` is therefore untouched by
/// this rule and keeps resolving via the `:root:root` /
/// `:root:root[data-theme="light"]` blocks above exactly as it always did.
///
/// Unconditional -- unlike Mode A's `tokens.css` companion rule (scoped to
/// `html[data-palette="brand"]`, since a stock build must keep per-element
/// provider colour working when no brand is active), a Mode B build has no
/// "off" state to preserve: the packaged build has exactly one look, so
/// this always applies. `:root:root [data-provider]` -- the same
/// double-`:root` device the rest of this file uses, plus the descendant
/// compound -- gives it specificity (0,3,0), which beats every rule
/// `tokens.css` can produce for a `[data-provider]` target (the highest is
/// (0,2,1), the Orange Charcoal preset's own descendant pin) regardless of
/// which stylesheet loads first. `inherit` needs no
/// `@supports not (color-mix(...))` counterpart: it has no color-mix()
/// dependency, so it behaves identically in every browser, and (0,3,0)
/// already wins there too.
const NEUTRALIZE_PROVIDER_HUE_ON_DESCENDANTS: &str = ":root:root [data-provider] {\n  --hue: inherit;\n  --hue-text: inherit;\n  --hue-solid: inherit;\n  --hue-weak: inherit;\n}\n";

/// Render `packages/ui/src/brand.generated.css`: `@font-face` rules (if
/// `[fonts]` is present), then a dark palette block, a light palette block,
/// and the provider-hue neutralization rule (if `[palette]` is present).
/// Either piece may be absent on its own -- an identity-only or fonts-only
/// brand still produces a well-formed (possibly near-empty) file.
pub fn render_generated_css(cfg: &BrandConfig, invocation: &str) -> String {
    let mut out = css_header_comment(invocation);

    if let Some(fonts) = &cfg.fonts {
        out.push_str(&render_font_faces(fonts));
        out.push('\n');
    }

    let font_vars = cfg.fonts.as_ref().map(render_font_vars).unwrap_or_default();

    match &cfg.palette {
        Some(BrandThemes { dark, light }) => {
            out.push_str(&render_theme_block(":root:root", dark, &font_vars));
            out.push('\n');
            out.push_str(&render_theme_block(
                ":root:root[data-theme=\"light\"]",
                light,
                "",
            ));
            out.push('\n');
            out.push_str(NEUTRALIZE_PROVIDER_HUE_ON_DESCENDANTS);
        }
        None if !font_vars.is_empty() => {
            out.push_str(&format!(":root:root {{\n{font_vars}}}\n"));
        }
        None => {}
    }

    out
}

// =============================================================================
// The generated TypeScript identity module
// =============================================================================

/// Render `apps/desktop/src/brand/generated.ts`: the compiled-in identity
/// defaults consumed by the Phase 0 singleton (`apps/desktop/src/brand/index.ts`).
///
/// Values are rendered via `serde_json::to_string`, which produces a quoted,
/// escaped JSON string literal -- a valid subset of JS string literal syntax
/// -- rather than hand-interpolating `identity.app_name` between quotes.
/// `BrandIdentity`'s own validator only bounds length and non-emptiness, not
/// character content, so a value containing `"` or `\` must still come out
/// as a syntactically valid TS source string.
pub fn render_generated_ts(cfg: &BrandConfig, invocation: &str) -> String {
    let app_name_lit = serde_json::to_string(&cfg.identity.app_name)
        .expect("String always serializes to a JSON string literal");
    let display_name_lit = serde_json::to_string(&cfg.identity.display_name)
        .expect("String always serializes to a JSON string literal");
    let tagline_lit = match &cfg.identity.tagline {
        Some(tagline) => serde_json::to_string(tagline),
        None => serde_json::to_string(&format!("Message {}\u{2026}", cfg.identity.app_name)),
    }
    .expect("String always serializes to a JSON string literal");

    format!(
        "// SPDX-License-Identifier: AGPL-3.0-only\n\
         // Copyright (C) 2026 Emilio Olivares\n\n\
         /**\n \
         * GENERATED FILE -- do not hand edit.\n \
         *\n \
         * Produced by:\n \
         *   {invocation}\n \
         *\n \
         * Compiled-in identity defaults for the Phase 0 brand singleton\n \
         * (`./index.ts`). See docs/private/white-label-plan.md \u{a7}5.\n \
         */\n\n\
         export const GENERATED_APP_NAME = {app_name_lit};\n\
         export const GENERATED_DISPLAY_NAME = {display_name_lit};\n\
         export const GENERATED_TAGLINE = {tagline_lit};\n"
    )
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brand::parse;

    const FIXTURE: &str = r##"+++
schemaVersion = 1

[identity]
appName     = "Northwind"
displayName = "Northwind AI"
tagline     = "Message Northwind..."

[fonts]
ui   = "Soehne.woff2"
mono = "SoehneMono.woff2"

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
"##;

    fn fixture_config() -> BrandConfig {
        parse(FIXTURE).expect("fixture should parse").0
    }

    /// The header comment documents the two selectors by name (see
    /// `css_header_comment`), so a naive `find` for either selector string
    /// can match inside the comment instead of the real rule. Every test
    /// below that locates a block searches only after the header.
    fn css_body(css: &str) -> &str {
        let marker = "*/\n\n";
        let start = css.find(marker).expect("header comment present") + marker.len();
        &css[start..]
    }

    #[test]
    fn dark_block_uses_double_root_and_every_property() {
        let css = render_generated_css(&fixture_config(), "test");
        let body = css_body(&css);
        let dark_start = body.find(":root:root {").expect("dark block present");
        let light_start = body.find(":root:root[data-theme=\"light\"]").unwrap();
        let dark_block = &body[dark_start..light_start];

        for (prop, value) in palette_css_pairs(&fixture_config().palette.unwrap().dark) {
            assert!(
                dark_block.contains(&format!("{prop}: {value};")),
                "dark block missing `{prop}: {value};`:\n{dark_block}"
            );
        }
        assert!(dark_block.contains("--hue-weak: color-mix(in srgb, #E4572E 14%, transparent);"));
    }

    #[test]
    fn light_block_is_scoped_and_uses_light_values() {
        let css = render_generated_css(&fixture_config(), "test");
        let body = css_body(&css);
        let light_start = body
            .find(":root:root[data-theme=\"light\"] {")
            .expect("light block present");
        let light_block = &body[light_start..];

        for (prop, value) in palette_css_pairs(&fixture_config().palette.unwrap().light) {
            assert!(
                light_block.contains(&format!("{prop}: {value};")),
                "light block missing `{prop}: {value};`:\n{light_block}"
            );
        }
        assert!(light_block.contains("--hue-weak: color-mix(in srgb, #B8441F 14%, transparent);"));
    }

    #[test]
    fn dark_and_light_selectors_have_the_expected_specificity_shape() {
        let css = render_generated_css(&fixture_config(), "test");
        assert!(
            css.contains(":root:root {\n"),
            "dark selector must be exactly `:root:root`"
        );
        assert!(
            css.contains(":root:root[data-theme=\"light\"] {\n"),
            "light selector must be `:root:root[data-theme=\"light\"]`"
        );
        // Plain `:root` (single) must not appear as its own selector -- that
        // is the (0,1,0) tie this whole module exists to avoid.
        assert!(!css.contains("\n:root {\n") && !css.starts_with(":root {\n"));
    }

    #[test]
    fn fonts_absent_emits_no_font_face_or_font_vars() {
        let mut cfg = fixture_config();
        cfg.fonts = None;
        let css = render_generated_css(&cfg, "test");
        assert!(!css.contains("@font-face"));
        assert!(!css.contains("--font-ui"));
    }

    #[test]
    fn fonts_present_emit_face_and_vars_pointing_at_fixed_dest_names() {
        let css = render_generated_css(&fixture_config(), "test");
        assert!(css.contains("font-family: \"Soehne\";"));
        assert!(css.contains("url(\"./fonts/brand-ui.woff2\") format(\"woff2\");"));
        assert!(css.contains("font-family: \"SoehneMono\";"));
        assert!(css.contains("url(\"./fonts/brand-mono.woff2\") format(\"woff2\");"));
        assert!(css.contains("--font-ui: \"Soehne\", ui-sans-serif"));
        assert!(css.contains("--font-mono: \"SoehneMono\", ui-monospace"));
    }

    #[test]
    fn palette_absent_but_fonts_present_still_emits_font_vars() {
        let mut cfg = fixture_config();
        cfg.palette = None;
        let css = render_generated_css(&cfg, "test");
        assert!(css.contains("--font-ui: \"Soehne\""));
        assert!(!css.contains("--bg:"));
    }

    #[test]
    fn palette_present_emits_the_descendant_neutralization_rule() {
        let css = render_generated_css(&fixture_config(), "test");
        assert!(
            css.contains(":root:root [data-provider] {"),
            "missing the descendant-only neutralization selector:
{css}"
        );
        let neutralize_start = css.find(":root:root [data-provider] {").unwrap();
        let neutralize_block = &css[neutralize_start..];
        for prop in ["--hue", "--hue-text", "--hue-solid", "--hue-weak"] {
            assert!(
                neutralize_block.contains(&format!("{prop}: inherit;")),
                "neutralization block missing `{prop}: inherit;`:
{neutralize_block}"
            );
        }
        // The compound <html> form must NOT be present -- see this rule's
        // own doc comment for why `inherit` there would blank --hue out at
        // the true DOM root instead of neutralizing a descendant.
        assert!(!css.contains(":root:root[data-provider]"));
    }

    #[test]
    fn palette_absent_emits_no_neutralization_rule() {
        // Nothing to neutralize toward if there is no brand palette at all --
        // an identity- or fonts-only brand leaves tokens.css's own
        // [data-provider] blocks alone entirely.
        let mut cfg = fixture_config();
        cfg.palette = None;
        let css = render_generated_css(&cfg, "test");
        assert!(!css.contains(":root:root[data-provider]"));
    }

    #[test]
    fn neutralization_rule_appears_after_both_theme_blocks() {
        // Order matters for a human reading the file even though it does not
        // matter for the cascade (the rule's own specificity already wins
        // unconditionally) -- it should read as "the palette, then the fix
        // for where the palette alone cannot reach".
        let css = render_generated_css(&fixture_config(), "test");
        let light_pos = css.find(":root:root[data-theme=\"light\"] {").unwrap();
        let neutralize_pos = css.find(":root:root [data-provider] {").unwrap();
        assert!(neutralize_pos > light_pos);
    }

    #[test]
    fn font_copy_plan_lists_only_present_roles_with_fixed_dest_names() {
        let cfg = fixture_config();
        let plan = font_copy_plan(cfg.fonts.as_ref().unwrap());
        assert_eq!(plan.len(), 2);
        assert_eq!(plan[0], (FontRole::Ui, "Soehne.woff2".to_string()));
        assert_eq!(plan[1], (FontRole::Mono, "SoehneMono.woff2".to_string()));
        assert_eq!(FontRole::Ui.dest_filename(), "brand-ui.woff2");
        assert_eq!(FontRole::Mono.dest_filename(), "brand-mono.woff2");
        assert_eq!(FontRole::Serif.dest_filename(), "brand-serif.woff2");
    }

    #[test]
    fn generated_ts_escapes_and_names_identity() {
        let ts = render_generated_ts(&fixture_config(), "test invocation");
        assert!(ts.contains("export const GENERATED_APP_NAME = \"Northwind\";"));
        assert!(ts.contains("export const GENERATED_DISPLAY_NAME = \"Northwind AI\";"));
        assert!(ts.contains("export const GENERATED_TAGLINE = \"Message Northwind...\";"));
        assert!(ts.contains("Produced by:\n *   test invocation"));
    }

    #[test]
    fn generated_ts_escapes_quotes_in_identity() {
        let mut cfg = fixture_config();
        cfg.identity.app_name = "Foo \"Bar\"".to_string();
        cfg.identity.tagline = None;
        let ts = render_generated_ts(&cfg, "test");
        assert!(ts.contains("export const GENERATED_APP_NAME = \"Foo \\\"Bar\\\"\";"));
        // No tagline -> derived default, matching `setBrand`'s own fallback
        // shape. `serde_json::to_string` escapes the quotes but leaves the
        // non-ASCII ellipsis character itself in the output (it only escapes
        // control characters, `"`, and `\`), so the literal `…` appears here.
        assert!(ts.contains("GENERATED_TAGLINE = \"Message Foo \\\"Bar\\\"\u{2026}\";"));
    }

    #[test]
    fn header_comment_names_the_invocation() {
        let css = render_generated_css(
            &fixture_config(),
            "cargo run --example apply_brand -p provider-core -- fixtures/demo",
        );
        assert!(css.contains("cargo run --example apply_brand -p provider-core -- fixtures/demo"));
    }
}
