//! Turn a fetched HTML page into the readable text a workflow step (or the
//! model reasoning over it) actually wants, instead of raw tag soup.
//!
//! This is hand-rolled rather than pulling in an HTML/DOM crate: workflows
//! only need "strip the chrome, keep the article, list the links" — not a
//! spec-compliant parser — and the project's policy for this change is no
//! new dependencies (`serde_json` and `url` are already here; `url` does the
//! link resolution). The algorithm is deliberately tolerant of messy,
//! unclosed, real-world HTML: it never panics on malformed input, it just
//! does its best and moves on.

use url::Url;

/// The readable content pulled out of a page.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Extracted {
    pub title: Option<String>,
    pub text: String,
    /// Absolute http(s) links, deduplicated, in page order, at most 100.
    pub links: Vec<String>,
    /// The same links with the words they were shown as, for a reader that
    /// has to choose which one to follow. Absolute http(s), no fragment,
    /// deduplicated by URL (the distinct texts of one URL are joined with
    /// " | "), in page order, at most [`MAX_ANCHORS`].
    pub anchors: Vec<Link>,
}

/// One link on a page and the text it was shown as (empty for an image link
/// with no `title` or `aria-label`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Link {
    pub url: String,
    pub text: String,
}

/// Most anchors [`extract_readable`] keeps; callers cap further.
pub const MAX_ANCHORS: usize = 500;

/// Longest joined text kept for one anchor URL.
const MAX_ANCHOR_TEXT_CHARS: usize = 200;

/// Tags whose entire subtree (tag + contents) contributes nothing readable
/// and is dropped outright.
const DROP_TAGS: &[&str] = &[
    "script", "style", "noscript", "svg", "template", "iframe", "head", "nav", "footer", "header",
    "aside", "form",
];

/// Tags that force a line break when rendered to text. `li` and `h1`-`h3`
/// also get a text prefix (handled in [`render_region`]).
const BLOCK_TAGS: &[&str] = &[
    "p",
    "div",
    "section",
    "br",
    "li",
    "ul",
    "ol",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "tr",
    "table",
    "blockquote",
    "pre",
    "hr",
];

/// A page "looked empty" (JS-rendered shell, nothing crawlable) when there's
/// not enough text to plausibly be the real content.
const MIN_CONTENT_CHARS: usize = 400;

/// A region only counts as "the article" if it has enough text to be more
/// than a stub `<article>` wrapper around an empty JS mount point.
const MIN_REGION_CHARS: usize = 200;

/// Extract the readable text of an HTML page. `base_url` resolves relative
/// links.
pub fn extract_readable(html: &str, base_url: &str) -> Extracted {
    let title = extract_title(html);
    let cleaned = remove_dropped(html);
    let region = choose_region(&cleaned);

    let rendered = render_region(region);
    let text = normalize_whitespace(&rendered.text);
    let links = resolve_links(&rendered.hrefs, base_url);
    let anchors = resolve_anchors(&rendered.anchors, base_url);

    Extracted {
        title,
        text,
        links,
        anchors,
    }
}

/// True when the extracted text is too thin to be the page's content — the
/// usual sign of a page that builds itself with JavaScript. Threshold: fewer
/// than 400 non-whitespace characters.
pub fn looked_empty(text: &str) -> bool {
    non_ws_count(text) < MIN_CONTENT_CHARS
}

fn non_ws_count(s: &str) -> usize {
    s.chars().filter(|c| !c.is_whitespace()).count()
}

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

fn extract_title(html: &str) -> Option<String> {
    let (start, end) = find_element(html, "title")?;
    let text = collapse_all_whitespace(&decode_entities(&strip_tags(&html[start..end])));
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while i < html.len() {
        match html[i..].find('<') {
            None => {
                out.push_str(&html[i..]);
                break;
            }
            Some(off) => {
                let lt = i + off;
                out.push_str(&html[i..lt]);
                i = skip_tag_end(html, lt);
            }
        }
    }
    out
}

fn collapse_all_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_ws = false;
    for c in s.chars() {
        if c.is_whitespace() {
            if !last_ws {
                out.push(' ');
            }
            last_ws = true;
        } else {
            out.push(c);
            last_ws = false;
        }
    }
    out.trim().to_string()
}

// ---------------------------------------------------------------------------
// Tag scanning primitives
// ---------------------------------------------------------------------------

/// Read a tag name starting right after `<` or `</`. Lowercased.
fn read_tag_name(html: &str, start: usize) -> String {
    html[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect::<String>()
        .to_ascii_lowercase()
}

/// Given the index of a tag's opening `<`, find the index right after its
/// closing `>`, respecting quoted attribute values. Tolerant: if there's no
/// closing `>` at all, the "tag" runs to the end of the document.
fn skip_tag_end(html: &str, lt: usize) -> usize {
    let bytes = html.as_bytes();
    let mut i = lt + 1;
    let mut in_quote: Option<u8> = None;
    while i < bytes.len() {
        let c = bytes[i];
        match in_quote {
            Some(q) => {
                if c == q {
                    in_quote = None;
                }
            }
            None => {
                if c == b'"' || c == b'\'' {
                    in_quote = Some(c);
                } else if c == b'>' {
                    return i + 1;
                }
            }
        }
        i += 1;
    }
    html.len()
}

/// Skip past an HTML comment starting at `lt` (which must point at `<!--`).
/// Returns the index right after `-->`, or the end of the document if the
/// comment is never closed.
fn skip_comment(html: &str, lt: usize) -> usize {
    match html[lt + 4..].find("-->") {
        Some(end) => lt + 4 + end + 3,
        None => html.len(),
    }
}

/// Find the matching close of the element named `name` (case-insensitive)
/// whose open tag ends at `from`, tracking same-name nesting depth. Returns
/// `(close_tag_start, index_after_close_tag)`. Tolerant: if no matching close
/// is found, both are the end of the document, i.e. "the rest of the page is
/// this element's contents".
fn skip_element(html: &str, mut i: usize, name: &str) -> (usize, usize) {
    let mut depth = 1usize;
    while i < html.len() {
        match html[i..].find('<') {
            None => return (html.len(), html.len()),
            Some(off) => {
                let lt = i + off;
                if html[lt..].starts_with("<!--") {
                    i = skip_comment(html, lt);
                    continue;
                }
                let closing = html.as_bytes().get(lt + 1) == Some(&b'/');
                let name_start = if closing { lt + 2 } else { lt + 1 };
                let tag_name = read_tag_name(html, name_start);
                let tag_end = skip_tag_end(html, lt);
                if tag_name == name {
                    if closing {
                        depth -= 1;
                        if depth == 0 {
                            return (lt, tag_end);
                        }
                    } else {
                        depth += 1;
                    }
                }
                i = tag_end;
            }
        }
    }
    (html.len(), html.len())
}

/// Find the first `<name>...</name>` element (case-insensitive) in `html`.
/// Returns the byte range of its contents (excluding the tags themselves).
/// Tolerant of an unclosed element: its contents then run to the end of the
/// document.
fn find_element(html: &str, name: &str) -> Option<(usize, usize)> {
    let mut i = 0;
    while i < html.len() {
        let off = html[i..].find('<')?;
        let lt = i + off;
        if html[lt..].starts_with("<!--") {
            i = skip_comment(html, lt);
            continue;
        }
        let closing = html.as_bytes().get(lt + 1) == Some(&b'/');
        let name_start = if closing { lt + 2 } else { lt + 1 };
        let tag_name = read_tag_name(html, name_start);
        let tag_end = skip_tag_end(html, lt);
        if !closing && tag_name == name {
            let (close_start, _) = skip_element(html, tag_end, name);
            return Some((tag_end, close_start));
        }
        i = tag_end;
    }
    None
}

/// Remove every `DROP_TAGS` element (tag and contents) and every HTML
/// comment, leaving other markup untouched for [`render_region`] to walk.
fn remove_dropped(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while i < html.len() {
        match html[i..].find('<') {
            None => {
                out.push_str(&html[i..]);
                break;
            }
            Some(off) => {
                let lt = i + off;
                out.push_str(&html[i..lt]);
                if html[lt..].starts_with("<!--") {
                    i = skip_comment(html, lt);
                    continue;
                }
                let closing = html.as_bytes().get(lt + 1) == Some(&b'/');
                let name_start = if closing { lt + 2 } else { lt + 1 };
                let name = read_tag_name(html, name_start);
                let tag_end = skip_tag_end(html, lt);
                if !closing && DROP_TAGS.contains(&name.as_str()) {
                    let (_, after_close) = skip_element(html, tag_end, &name);
                    i = after_close;
                } else {
                    out.push_str(&html[lt..tag_end]);
                    i = tag_end;
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Region selection
// ---------------------------------------------------------------------------

/// Prefer `<article>`, then `<main>`, when either has enough text to be real
/// content; otherwise fall back to `<body>`, or the whole (cleaned) document.
fn choose_region(cleaned: &str) -> &str {
    for tag in ["article", "main"] {
        if let Some((s, e)) = find_element(cleaned, tag) {
            let region = &cleaned[s..e];
            if non_ws_count(&render_region(region).text) >= MIN_REGION_CHARS {
                return region;
            }
        }
    }
    if let Some((s, e)) = find_element(cleaned, "body") {
        &cleaned[s..e]
    } else {
        cleaned
    }
}

// ---------------------------------------------------------------------------
// Rendering a region to text + links
// ---------------------------------------------------------------------------

/// A region rendered to text, with its links as found.
struct Rendered {
    text: String,
    /// Raw (unresolved, undecoded) `href` values, in document order.
    hrefs: Vec<String>,
    /// Raw `href` values with the text each `<a>` wrapped (whitespace
    /// collapsed; the `title`/`aria-label` when it wrapped no text).
    anchors: Vec<(String, String)>,
}

/// An `<a>` whose text is still being collected.
struct OpenAnchor {
    href: String,
    label: Option<String>,
    text_start: usize,
}

fn close_anchor(open: &mut Option<OpenAnchor>, text: &str, anchors: &mut Vec<(String, String)>) {
    if let Some(anchor) = open.take() {
        let shown = collapse_all_whitespace(&text[anchor.text_start..]);
        let shown = if shown.is_empty() {
            anchor.label.unwrap_or_default()
        } else {
            shown
        };
        anchors.push((anchor.href, shown));
    }
}

/// Render one HTML region to text, collecting raw (unresolved, undecoded)
/// `href` values from `<a>` tags in document order along the way.
fn render_region(html: &str) -> Rendered {
    let mut text = String::new();
    let mut links = Vec::new();
    let mut anchors = Vec::new();
    let mut open: Option<OpenAnchor> = None;
    let mut i = 0;
    while i < html.len() {
        match html[i..].find('<') {
            None => {
                text.push_str(&decode_entities(&html[i..]));
                break;
            }
            Some(off) => {
                let lt = i + off;
                text.push_str(&decode_entities(&html[i..lt]));
                if html[lt..].starts_with("<!--") {
                    i = skip_comment(html, lt);
                    continue;
                }
                let closing = html.as_bytes().get(lt + 1) == Some(&b'/');
                let name_start = if closing { lt + 2 } else { lt + 1 };
                let name = read_tag_name(html, name_start);
                let tag_end = skip_tag_end(html, lt);

                if name == "a" {
                    // An `<a>` inside an open one (invalid, but real pages do
                    // it) ends the first.
                    close_anchor(&mut open, &text, &mut anchors);
                    if !closing {
                        let tag = &html[lt..tag_end];
                        if let Some(href) = get_attr(tag, "href") {
                            links.push(href.clone());
                            let label = get_attr(tag, "aria-label")
                                .or_else(|| get_attr(tag, "title"))
                                .map(|l| collapse_all_whitespace(&decode_entities(&l)));
                            open = Some(OpenAnchor {
                                href,
                                label,
                                text_start: text.len(),
                            });
                        }
                    }
                }

                if BLOCK_TAGS.contains(&name.as_str()) {
                    if closing {
                        text.push('\n');
                    } else {
                        match name.as_str() {
                            "li" => text.push_str("\n- "),
                            "h1" => text.push_str("\n# "),
                            "h2" => text.push_str("\n## "),
                            "h3" => text.push_str("\n### "),
                            _ => text.push('\n'),
                        }
                    }
                }

                i = tag_end;
            }
        }
    }
    close_anchor(&mut open, &text, &mut anchors);
    Rendered {
        text,
        hrefs: links,
        anchors,
    }
}

/// Read an attribute's raw value out of a tag's raw text (`<a href="...">`).
/// Handles quoted and unquoted values; tolerant of a dangling unterminated
/// quote (falls through to "not found" rather than panicking).
fn get_attr(tag_html: &str, attr: &str) -> Option<String> {
    let lower = tag_html.to_ascii_lowercase();
    let needle = format!("{attr}=");
    let mut from = 0;
    while let Some(pos) = lower[from..].find(&needle) {
        let abs = from + pos;
        let preceded_by_boundary = abs == 0
            || matches!(
                lower.as_bytes()[abs - 1],
                b' ' | b'\t' | b'\n' | b'\r' | b'/'
            );
        let val_start = abs + needle.len();
        if preceded_by_boundary {
            let rest = &tag_html[val_start..];
            match rest.chars().next() {
                Some(q @ ('"' | '\'')) => {
                    if let Some(end) = rest[q.len_utf8()..].find(q) {
                        return Some(rest[q.len_utf8()..q.len_utf8() + end].to_string());
                    }
                    return None;
                }
                Some(_) => {
                    let end = rest
                        .find(|c: char| c.is_whitespace() || c == '>')
                        .unwrap_or(rest.len());
                    return Some(rest[..end].to_string());
                }
                None => return None,
            }
        }
        from = abs + needle.len();
    }
    None
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/// Longest entity name/reference we bother trying to decode (`&#x1F600;` is
/// 8 chars between `&` and `;`); anything longer is treated as a lone `&`.
const MAX_ENTITY_LEN: usize = 10;

pub(crate) fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if s.as_bytes()[i] == b'&' {
            if let Some(rel) = s[i + 1..].find(';') {
                if rel <= MAX_ENTITY_LEN {
                    let entity = &s[i + 1..i + 1 + rel];
                    if let Some(decoded) = decode_one_entity(entity) {
                        out.push(decoded);
                        i = i + 1 + rel + 1;
                        continue;
                    }
                }
            }
            out.push('&');
            i += 1;
        } else {
            let ch = s[i..].chars().next().expect("valid utf8 boundary");
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

fn decode_one_entity(entity: &str) -> Option<char> {
    match entity {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some('\u{00A0}'),
        _ => {
            if let Some(hex) = entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
            {
                u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
            } else if let Some(dec) = entity.strip_prefix('#') {
                dec.parse::<u32>().ok().and_then(char::from_u32)
            } else {
                None
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Whitespace normalization
// ---------------------------------------------------------------------------

fn normalize_whitespace(text: &str) -> String {
    let lines: Vec<String> = text
        .lines()
        .map(|line| {
            let mut out = String::with_capacity(line.len());
            let mut last_was_space = false;
            for c in line.chars() {
                if c == ' ' || c == '\t' {
                    if !last_was_space {
                        out.push(' ');
                    }
                    last_was_space = true;
                } else {
                    out.push(c);
                    last_was_space = false;
                }
            }
            out.trim().to_string()
        })
        .collect();

    let joined = lines.join("\n");

    let mut result = String::with_capacity(joined.len());
    let mut newline_run = 0usize;
    for c in joined.chars() {
        if c == '\n' {
            newline_run += 1;
            if newline_run <= 2 {
                result.push(c);
            }
        } else {
            newline_run = 0;
            result.push(c);
        }
    }
    result.trim().to_string()
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

fn resolve_links(raw_hrefs: &[String], base_url: &str) -> Vec<String> {
    let base = Url::parse(base_url).ok();
    let mut out = Vec::new();
    for href in raw_hrefs {
        let decoded = decode_entities(href);
        let resolved = match &base {
            Some(b) => b.join(&decoded).ok(),
            None => Url::parse(&decoded).ok(),
        };
        let Some(mut url) = resolved else { continue };
        if url.scheme() != "http" && url.scheme() != "https" {
            continue;
        }
        url.set_fragment(None);
        let s = url.to_string();
        if !out.contains(&s) {
            out.push(s);
            if out.len() >= 100 {
                break;
            }
        }
    }
    out
}

fn resolve_anchors(raw: &[(String, String)], base_url: &str) -> Vec<Link> {
    let base = Url::parse(base_url).ok();
    let mut out: Vec<Link> = Vec::new();
    let mut index: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (href, text) in raw {
        let decoded = decode_entities(href);
        let resolved = match &base {
            Some(b) => b.join(decoded.trim()).ok(),
            None => Url::parse(decoded.trim()).ok(),
        };
        let Some(mut url) = resolved else { continue };
        if url.scheme() != "http" && url.scheme() != "https" {
            continue;
        }
        url.set_fragment(None);
        let url = url.to_string();
        match index.get(&url) {
            Some(&at) => {
                let existing = &mut out[at].text;
                let already = existing.split(" | ").any(|t| t == text);
                if !text.is_empty()
                    && !already
                    && existing.chars().count() + text.chars().count() + 3 <= MAX_ANCHOR_TEXT_CHARS
                {
                    if !existing.is_empty() {
                        existing.push_str(" | ");
                    }
                    existing.push_str(text);
                }
            }
            None => {
                if out.len() >= MAX_ANCHORS {
                    continue;
                }
                index.insert(url.clone(), out.len());
                out.push(Link {
                    url,
                    text: text.chars().take(MAX_ANCHOR_TEXT_CHARS).collect(),
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_title() {
        let html = "<html><head><title>  Hello &amp; World  </title></head><body>x</body></html>";
        let out = extract_readable(html, "https://example.com");
        assert_eq!(out.title.as_deref(), Some("Hello & World"));
    }

    #[test]
    fn missing_title_is_none() {
        let html = "<html><body>x</body></html>";
        assert_eq!(extract_readable(html, "https://example.com").title, None);
    }

    #[test]
    fn removes_script_style_and_nav() {
        let html = "<body><nav>Home | About</nav><script>evil()</script><style>.x{}</style><p>Real content that is visible.</p></body>";
        let out = extract_readable(html, "https://example.com");
        assert!(!out.text.contains("Home"));
        assert!(!out.text.contains("evil"));
        assert!(!out.text.contains(".x"));
        assert!(out.text.contains("Real content that is visible."));
    }

    #[test]
    fn html_comments_are_removed() {
        let html = "<body><!-- a comment with <p>fake tags</p> --><p>Kept text</p></body>";
        let out = extract_readable(html, "https://example.com");
        assert!(!out.text.contains("fake tags"));
        assert!(out.text.contains("Kept text"));
    }

    #[test]
    fn prefers_article_when_long_enough() {
        let long_para = "word ".repeat(60); // well over 200 non-ws chars
        let html = format!(
            "<body><nav>menu</nav><article><p>{long_para}</p></article><div>other stuff not in article</div></body>"
        );
        let out = extract_readable(&html, "https://example.com");
        assert!(out.text.contains("word"));
        assert!(!out.text.contains("other stuff not in article"));
    }

    #[test]
    fn falls_back_to_body_when_article_too_short() {
        let html = "<body><article>Too short</article><p>The real body content that is long enough to matter here for sure.</p></body>";
        let out = extract_readable(html, "https://example.com");
        assert!(out.text.contains("The real body content"));
    }

    #[test]
    fn formats_lists_and_headings() {
        let html = "<body><h1>Title</h1><h2>Sub</h2><ul><li>One</li><li>Two</li></ul></body>";
        let out = extract_readable(html, "https://example.com");
        assert!(out.text.contains("# Title"));
        assert!(out.text.contains("## Sub"));
        assert!(out.text.contains("- One"));
        assert!(out.text.contains("- Two"));
    }

    #[test]
    fn decodes_named_numeric_and_invalid_entities() {
        let html = "<body><p>A &amp; B &lt;tag&gt; &quot;q&quot; &#39;s&#39; &nbsp;n &#65; &#x41; &bogus;</p></body>";
        let out = extract_readable(html, "https://example.com");
        assert!(out.text.contains("A & B <tag> \"q\" 's'"));
        assert!(out.text.contains("A"));
        // Invalid entity is left as literal text.
        assert!(out.text.contains("&bogus;"));
    }

    #[test]
    fn resolves_relative_links_dedups_and_drops_non_http() {
        let html = r#"<body>
            <a href="/a">A</a>
            <a href="/a">A again</a>
            <a href="https://other.example/b#frag">B</a>
            <a href="mailto:x@example.com">mail</a>
            <a href="javascript:void(0)">js</a>
        </body>"#;
        let out = extract_readable(html, "https://example.com/base/");
        assert_eq!(
            out.links,
            vec![
                "https://example.com/a".to_string(),
                "https://other.example/b".to_string(),
            ]
        );
    }

    #[test]
    fn anchors_keep_their_text_and_merge_duplicates() {
        let html = r##"<body>
            <a href="/item?id=1">3 hours ago</a>
            <a href="/item?id=1">142&nbsp;comments</a>
            <a href="/item?id=1#c">142&nbsp;comments</a>
            <a href="https://other.example/story">A <b>bold</b>
               story</a>
            <a href="/logo"><img src="x.png"></a>
            <a href="/labelled" aria-label="Go home"><img src="y.png"></a>
            <a href="javascript:void(0)">js</a>
            <a href="/open">never closed
        </body>"##;
        let out = extract_readable(html, "https://news.example/");
        let pairs: Vec<(&str, &str)> = out
            .anchors
            .iter()
            .map(|l| (l.url.as_str(), l.text.as_str()))
            .collect();
        assert_eq!(
            pairs,
            vec![
                (
                    "https://news.example/item?id=1",
                    "3 hours ago | 142 comments"
                ),
                ("https://other.example/story", "A bold story"),
                ("https://news.example/logo", ""),
                ("https://news.example/labelled", "Go home"),
                ("https://news.example/open", "never closed"),
            ]
        );
    }

    #[test]
    fn looked_empty_threshold() {
        assert!(looked_empty("short"));
        assert!(!looked_empty(&"x".repeat(400)));
        assert!(looked_empty(&"x".repeat(399)));
    }

    #[test]
    fn tolerates_unclosed_tags() {
        let html =
            "<body><p>First paragraph<p>Second paragraph without a close<div>Div text</body>";
        let out = extract_readable(html, "https://example.com");
        assert!(out.text.contains("First paragraph"));
        assert!(out.text.contains("Second paragraph without a close"));
        assert!(out.text.contains("Div text"));
    }

    #[test]
    fn tolerates_unclosed_article_running_to_end() {
        let long_para = "word ".repeat(60);
        let html = format!("<body><article><p>{long_para}</p>");
        let out = extract_readable(&html, "https://example.com");
        assert!(out.text.contains("word"));
    }
}
