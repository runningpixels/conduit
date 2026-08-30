//! Byte-level validation for a white-label logo upload -- Phase 2 of
//! `docs/private/white-label-plan.md` §4 (items 10-13).
//!
//! This module answers exactly one question: *given raw bytes and the
//! filename the renderer claims for them, is this a logo Conduit is willing
//! to store and later serve back as a `data:` URI?* It has no knowledge of
//! where the brand directory is or how `brand.md` names its logo -- that is
//! `commands::branding`'s job. Keeping this IO-free (like
//! `provider_core::brand`) is what makes [`validate`] cheap to call twice:
//! once when a logo is written, and again every time one is read back (see
//! `commands::branding::get_brand_logo`'s doc comment for why the second
//! call matters).
//!
//! ## The cap is enforced here, not just in the picker UI
//!
//! `commands::artifacts::ATTACHMENT_INLINE_CAP_BYTES` already established the
//! pattern this mirrors: a renderer-side size check is advice, not a
//! boundary, because nothing stops a modified renderer (or a direct IPC
//! call, which any process with access to the Tauri bridge can make) from
//! sending more bytes than the picker would ever have offered. [`LOGO_MAX_BYTES`]
//! is the actual boundary; it is checked in Rust before anything else in
//! this module runs.
//!
//! ## Closing the gap `save_attachment` leaves open
//!
//! `docs/private/white-label-plan.md` §3 calls this out directly:
//! `save_attachment` (`commands::artifacts`) takes `mime_type` verbatim from
//! the renderer and never checks it against the bytes it is paired with, so
//! a caller can label arbitrary bytes with any MIME string it likes. A logo
//! is the app's first rendered-image path (nothing today builds an `<img>`,
//! a blob URL, or a data URI from user content), so this is also the first
//! place that gap would actually matter -- a mislabeled logo becomes
//! whatever the browser's MIME-sniffing decides to do with it once it hits
//! an `<img src>`. [`validate`] closes it for logos specifically: the
//! returned [`LogoMime`] always comes from sniffing the actual bytes
//! ([`infer`]) for raster formats, or from parsing the actual markup for
//! SVG, never from trusting the claimed extension on its own.

use std::fmt;

/// 2 MiB. A logo is a small, single UI asset, not a general attachment --
/// the same order-of-magnitude discipline as
/// `commands::artifacts::ATTACHMENT_INLINE_CAP_BYTES` (25 MiB, for arbitrary
/// user attachments), just tuned down for what this asset actually needs to
/// be.
pub const LOGO_MAX_BYTES: usize = 2 * 1024 * 1024;

/// The closed set of logo formats Conduit will store and serve. Deliberately
/// not a `String` MIME type anywhere in this module's public API: every
/// value that reaches [`commands::branding::get_brand_logo`]'s data-URI
/// assembly comes from this enum, never from a free-form string that
/// crossed IPC, which is what makes that assembly safe against a MIME value
/// that could otherwise break out of the `data:` URI it is embedded in --
/// see that command's doc comment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogoMime {
    Png,
    Jpeg,
    Webp,
    Svg,
}

impl LogoMime {
    /// The IANA MIME type, exactly as it must appear in `data:<mime>;base64,...`.
    pub fn mime_type(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Webp => "image/webp",
            Self::Svg => "image/svg+xml",
        }
    }

    /// The extension the stored file is named with (`logo.<ext>`). Chosen
    /// from the *sniffed* type by the caller, never the claimed one --
    /// see `commands::branding::save_brand_logo`.
    pub fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Webp => "webp",
            Self::Svg => "svg",
        }
    }

    fn from_infer_mime(mime: &str) -> Option<Self> {
        match mime {
            "image/png" => Some(Self::Png),
            "image/jpeg" => Some(Self::Jpeg),
            "image/webp" => Some(Self::Webp),
            _ => None,
        }
    }

    /// The raster [`LogoMime`] a claimed extension names, or `None` if it
    /// isn't one of the raster extensions this module accepts. `"jpg"` and
    /// `"jpeg"` both map to [`Self::Jpeg`] -- they are the same format under
    /// two conventional spellings, not a mismatch to reject.
    fn from_raster_extension(ext: &str) -> Option<Self> {
        match ext {
            "png" => Some(Self::Png),
            "jpg" | "jpeg" => Some(Self::Jpeg),
            "webp" => Some(Self::Webp),
            _ => None,
        }
    }
}

impl fmt::Display for LogoMime {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.mime_type())
    }
}

/// Validate raw logo bytes against the claimed filename's extension and
/// return the decided [`LogoMime`], or an error naming why the bytes were
/// rejected.
///
/// The claimed extension and the sniffed content type must agree. This is
/// deliberate in both directions: trusting the extension alone is exactly
/// the `save_attachment` gap this module exists to close, and trusting the
/// sniffed bytes alone would let a `.png` upload silently become a `.jpg`
/// file on disk with no indication to the user that anything changed.
/// Disagreement is a hard rejection, not a "trust the sniffed type and
/// proceed" fallback.
pub fn validate(bytes: &[u8], claimed_file_name: &str) -> Result<LogoMime, String> {
    if bytes.is_empty() {
        return Err("logo file is empty".to_string());
    }
    if bytes.len() > LOGO_MAX_BYTES {
        return Err(format!(
            "logo file is too large ({} bytes; the limit is {LOGO_MAX_BYTES} bytes / 2 MiB)",
            bytes.len()
        ));
    }

    let claimed_ext = claimed_file_name
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();

    match claimed_ext.as_str() {
        "png" | "jpg" | "jpeg" | "webp" => validate_raster(bytes, &claimed_ext),
        "svg" => validate_svg(bytes),
        other => Err(format!(
            "unsupported logo file type `.{other}` -- accepted formats are PNG, JPEG, WebP, and SVG"
        )),
    }
}

/// PNG/JPEG/WebP, decided by magic-byte sniffing via `infer` rather than
/// trusted from the claimed extension. `infer::get` returns `None` for
/// anything it doesn't recognize (including a claimed-raster file that is
/// actually garbage, truncated, or some other format entirely) -- that is
/// folded into the same rejection path as a positive-but-different sniff,
/// since either way the claimed extension did not describe the bytes.
fn validate_raster(bytes: &[u8], claimed_ext: &str) -> Result<LogoMime, String> {
    // `claimed_ext` only ever reaches this function via the match arm in
    // `validate` that already constrains it to png/jpg/jpeg/webp, so this is
    // always `Some`.
    let claimed = LogoMime::from_raster_extension(claimed_ext)
        .expect("validate_raster is only called for a recognized raster extension");

    match infer::get(bytes).and_then(|kind| LogoMime::from_infer_mime(kind.mime_type())) {
        Some(sniffed) if sniffed == claimed => Ok(sniffed),
        Some(sniffed) => Err(format!(
            "logo file is named as .{claimed_ext} but its magic bytes identify it as {sniffed} \
             -- rejecting rather than trusting either the filename or the content alone"
        )),
        None => Err(format!(
            "logo file is named as .{claimed_ext} but its magic bytes do not match any accepted \
             image format"
        )),
    }
}

/// `infer` sniffs magic *bytes*; SVG is text, so it has none, and `infer`
/// deliberately does not attempt to detect it. This function is the
/// separate path SVG needs: a structural check that the content is
/// plausibly XML/SVG at all, followed by a closed set of byte-level
/// rejections for the markup patterns that turn "displaying an image" into
/// "running a script."
///
/// ## Why these checks are defence-in-depth, not the only barrier
///
/// The stored logo is only ever meant to reach the DOM as
/// `<img src="data:image/svg+xml;base64,...">`. An SVG loaded through
/// `<img>` (as opposed to inlined via `dangerouslySetInnerHTML`, an
/// `<object>`, or navigation) is script-inert per spec -- `<script>`
/// elements do not execute, `onload`/`onclick`-style event handler
/// attributes are not wired up, and external resource references are not
/// fetched in that context. So these rejections are not what makes a logo
/// safe to render; the renderer never inlining the SVG into the DOM is what
/// makes it safe. What this function buys is protection against every other
/// consumer of the stored bytes that might not honor that context -- a
/// future code path, a different renderer surface, an export/import round
/// trip through Mode B, or simply a human opening the file directly -- and
/// against relying on a single security boundary for something this cheap
/// to also check up front.
fn validate_svg(bytes: &[u8]) -> Result<LogoMime, String> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| "SVG logo is not valid UTF-8 text".to_string())?;
    let trimmed = text.trim_start_matches('\u{FEFF}').trim_start();
    if !(trimmed.starts_with("<?xml") || trimmed.starts_with("<svg")) {
        return Err(
            "SVG logo does not start with an XML prolog or an <svg> root element after \
             leading whitespace/BOM -- this does not look like SVG"
                .to_string(),
        );
    }

    let lower = text.to_ascii_lowercase();

    if lower.contains("<script") {
        return Err("SVG logo rejected: contains a <script> element".to_string());
    }
    if lower.contains("foreignobject") {
        return Err("SVG logo rejected: contains a foreignObject element".to_string());
    }
    if lower.contains("javascript:") {
        return Err("SVG logo rejected: contains a javascript: URI".to_string());
    }
    if lower.contains("<!entity") {
        return Err("SVG logo rejected: contains an <!ENTITY declaration (XXE vector)".to_string());
    }
    if let Some(doctype_pos) = lower.find("<!doctype") {
        let doctype_end = lower[doctype_pos..]
            .find('>')
            .map(|i| doctype_pos + i)
            .unwrap_or(lower.len());
        if lower[doctype_pos..doctype_end].contains('[') {
            return Err(
                "SVG logo rejected: <!DOCTYPE declares an internal subset (XXE vector)".to_string(),
            );
        }
    }
    if contains_event_handler_attribute(&lower) {
        return Err("SVG logo rejected: contains an on<event>= handler attribute".to_string());
    }

    Ok(LogoMime::Svg)
}

/// Scans already-lowercased text for an `on<word>=` pattern (`onclick=`,
/// `onload =`, ...), the shape of every SVG/HTML event-handler attribute.
/// Hand-written rather than a `regex` dependency for the same reason
/// `provider_core::brand`'s hex-colour grammar is hand-written: this is one
/// small, closed pattern, not a place that benefits from a general regex
/// engine.
///
/// Requires the character before `on` to not be alphanumeric, so this does
/// not misfire on `on` appearing inside an ordinary word (`button=`,
/// `position=`) -- those are not event-handler attributes and a false
/// rejection there would be a worse failure mode than a slightly narrower
/// match.
fn contains_event_handler_attribute(lower: &str) -> bool {
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i + 2 <= bytes.len() {
        if &bytes[i..i + 2] == b"on" {
            let prev_is_word_char = i > 0 && bytes[i - 1].is_ascii_alphanumeric();
            if !prev_is_word_char {
                let mut j = i + 2;
                while j < bytes.len() && bytes[j].is_ascii_alphabetic() {
                    j += 1;
                }
                let had_event_name = j > i + 2;
                if had_event_name {
                    let mut k = j;
                    while k < bytes.len() && (bytes[k] as char).is_ascii_whitespace() {
                        k += 1;
                    }
                    if k < bytes.len() && bytes[k] == b'=' {
                        return true;
                    }
                }
            }
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    // A minimal, valid 1x1 PNG (the standard test fixture magic bytes).
    const PNG_MAGIC: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52,
    ];
    const JPEG_MAGIC: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46];
    const WEBP_MAGIC: &[u8] = b"RIFF\x00\x00\x00\x00WEBPVP8 ";

    #[test]
    fn over_cap_is_rejected() {
        let bytes = vec![0u8; LOGO_MAX_BYTES + 1];
        let err = validate(&bytes, "logo.png").unwrap_err();
        assert!(err.contains("too large"), "error: {err}");
    }

    #[test]
    fn empty_bytes_are_rejected() {
        let err = validate(&[], "logo.png").unwrap_err();
        assert!(err.contains("empty"), "error: {err}");
    }

    #[test]
    fn valid_png_is_accepted() {
        let mime = validate(PNG_MAGIC, "logo.png").unwrap();
        assert_eq!(mime, LogoMime::Png);
        assert_eq!(mime.mime_type(), "image/png");
        assert_eq!(mime.extension(), "png");
    }

    #[test]
    fn valid_jpeg_is_accepted_for_both_extensions() {
        assert_eq!(validate(JPEG_MAGIC, "logo.jpg").unwrap(), LogoMime::Jpeg);
        assert_eq!(validate(JPEG_MAGIC, "logo.jpeg").unwrap(), LogoMime::Jpeg);
    }

    #[test]
    fn valid_webp_is_accepted() {
        assert_eq!(validate(WEBP_MAGIC, "logo.webp").unwrap(), LogoMime::Webp);
    }

    #[test]
    fn extension_magic_mismatch_is_rejected() {
        // Real PNG bytes, claimed as a .jpg.
        let err = validate(PNG_MAGIC, "logo.jpg").unwrap_err();
        assert!(err.contains("magic bytes"), "error: {err}");
        assert!(err.to_lowercase().contains("png"), "error: {err}");
    }

    #[test]
    fn claimed_raster_extension_with_unrecognizable_bytes_is_rejected() {
        let err = validate(b"not an image at all, just text", "logo.png").unwrap_err();
        assert!(err.contains("magic bytes"), "error: {err}");
    }

    #[test]
    fn unsupported_extension_is_rejected_naming_accepted_formats() {
        let err = validate(PNG_MAGIC, "logo.gif").unwrap_err();
        assert!(err.contains("PNG"), "error: {err}");
        assert!(err.contains("SVG"), "error: {err}");
    }

    // -------------------------------------------------------------------
    // SVG
    // -------------------------------------------------------------------

    const CLEAN_SVG: &str = r##"<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="#E4572E"/></svg>"##;

    #[test]
    fn clean_svg_is_accepted() {
        let mime = validate(CLEAN_SVG.as_bytes(), "logo.svg").unwrap();
        assert_eq!(mime, LogoMime::Svg);
        assert_eq!(mime.mime_type(), "image/svg+xml");
    }

    #[test]
    fn svg_root_without_xml_prolog_is_accepted() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>"#;
        assert_eq!(validate(svg.as_bytes(), "logo.svg").unwrap(), LogoMime::Svg);
    }

    #[test]
    fn svg_with_leading_whitespace_and_bom_is_accepted() {
        let svg = format!("\u{FEFF}\n  \t{CLEAN_SVG}");
        assert_eq!(validate(svg.as_bytes(), "logo.svg").unwrap(), LogoMime::Svg);
    }

    #[test]
    fn non_svg_content_claimed_as_svg_is_rejected() {
        let err = validate(b"just some text, not xml at all", "logo.svg").unwrap_err();
        assert!(err.contains("does not look like SVG"), "error: {err}");
    }

    #[test]
    fn svg_script_tag_is_rejected() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#;
        let err = validate(svg.as_bytes(), "logo.svg").unwrap_err();
        assert!(err.contains("<script>"), "error: {err}");
    }

    #[test]
    fn svg_script_tag_is_rejected_case_insensitively() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg"><SCRIPT>alert(1)</SCRIPT></svg>"#;
        assert!(validate(svg.as_bytes(), "logo.svg").is_err());
    }

    #[test]
    fn svg_foreign_object_is_rejected() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml">hi</body></foreignObject></svg>"#;
        let err = validate(svg.as_bytes(), "logo.svg").unwrap_err();
        assert!(err.contains("foreignObject"), "error: {err}");
    }

    #[test]
    fn svg_event_handler_attribute_is_rejected() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect/></svg>"#;
        let err = validate(svg.as_bytes(), "logo.svg").unwrap_err();
        assert!(err.contains("event"), "error: {err}");
    }

    #[test]
    fn svg_event_handler_attribute_is_rejected_case_insensitively_and_with_whitespace() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg" OnClick = "evil()"><rect/></svg>"#;
        assert!(validate(svg.as_bytes(), "logo.svg").is_err());
    }

    #[test]
    fn svg_javascript_uri_is_rejected() {
        let svg = r#"<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>"#;
        let err = validate(svg.as_bytes(), "logo.svg").unwrap_err();
        assert!(err.contains("javascript:"), "error: {err}");
    }

    #[test]
    fn svg_entity_declaration_is_rejected() {
        let svg = r#"<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><!ENTITY xxe "oops"><rect/></svg>"#;
        let err = validate(svg.as_bytes(), "logo.svg").unwrap_err();
        assert!(err.contains("ENTITY"), "error: {err}");
    }

    #[test]
    fn svg_doctype_with_internal_subset_is_rejected() {
        let svg = r#"<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>"#;
        let err = validate(svg.as_bytes(), "logo.svg").unwrap_err();
        assert!(
            err.contains("DOCTYPE") || err.contains("ENTITY"),
            "error: {err}"
        );
    }

    #[test]
    fn svg_doctype_without_internal_subset_is_allowed() {
        // A plain external DOCTYPE (no `[`) is not the XXE shape being
        // guarded against.
        let svg = r#"<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>"#;
        assert_eq!(validate(svg.as_bytes(), "logo.svg").unwrap(), LogoMime::Svg);
    }

    #[test]
    fn ordinary_word_containing_on_is_not_a_false_positive() {
        assert!(!contains_event_handler_attribute(
            r#"<svg><rect button="x" position="1"/></svg>"#
        ));
    }
}
