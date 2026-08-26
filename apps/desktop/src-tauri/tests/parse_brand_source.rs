//! `commands::parse_brand_source` -- pure parse+validate of arbitrary
//! `brand.md` text, no IO and no `AppState`, so (unlike almost everything
//! else in `commands::branding`) it can be called directly as a plain
//! function rather than needing an `_impl` split or a running `tauri::App`.
//!
//! This is what a Markdown-artifact renderer uses to decide whether a given
//! artifact's content is an applicable brand theme -- see the command's doc
//! comment in `src/commands/branding.rs`.

use conduit_desktop::commands::parse_brand_source;

/// Mirrors `crates/provider-core/src/brand.rs`'s `VALID_FIXTURE`.
const VALID_SOURCE: &str = r##"+++
schemaVersion = 1

[identity]
appName     = "Northwind"
displayName = "Northwind AI"
tagline     = "Message Northwind..."

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

Warm, editorial, low-contrast.
"##;

#[test]
fn parse_brand_source_accepts_a_good_source() {
    let config = parse_brand_source(VALID_SOURCE.to_string()).expect("valid brand.md should parse");
    assert_eq!(config.identity.app_name, "Northwind");
    assert_eq!(config.identity.display_name, "Northwind AI");
    assert!(config.palette.is_some());
}

#[test]
fn parse_brand_source_rejects_a_bad_source() {
    let err = parse_brand_source("# just a markdown file\n\nno frontmatter here.".to_string())
        .expect_err("a file with no +++ frontmatter is not a brand theme");
    assert!(
        err.contains("+++"),
        "error should explain the missing frontmatter: {err}"
    );
}

#[test]
fn parse_brand_source_rejects_bad_hex_naming_the_field() {
    let bad = VALID_SOURCE.replace("bg       = \"#0F1115\"", "bg       = \"not-a-color\"");
    let err = parse_brand_source(bad).expect_err("an invalid hex value should fail validation");
    assert!(
        err.contains("palette.dark.bg"),
        "error should name the offending field: {err}"
    );
}
