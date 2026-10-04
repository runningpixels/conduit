//! Writing export: a draft as a Markdown file or a standalone HTML page.
//!
//! The HTML is rendered here with pulldown-cmark, never by the renderer, and is
//! safe to open anywhere: raw HTML in the Markdown is shown as text (escaped),
//! links and images keep only http(s), mailto and relative targets, and the
//! front matter is left out. The page carries a small readable stylesheet that
//! also prints well.

use std::path::Path;

use provider_core::schema::DraftExportFormat;
use pulldown_cmark::{html, CowStr, Event, LinkType, Parser, Tag, TagEnd};

use crate::draft_blocks;

const STYLE: &str = "\
:root{color-scheme:light}\
*{box-sizing:border-box}\
body{max-width:72ch;margin:3rem auto;padding:0 1.25rem;background:#fff;color:#1f1f23;\
font:18px/1.65 Charter,\"Bitstream Charter\",Georgia,\"Times New Roman\",serif}\
h1,h2,h3,h4,h5,h6{font-family:system-ui,-apple-system,\"Segoe UI\",Roboto,sans-serif;\
line-height:1.25;margin:2em 0 .6em}\
h1{font-size:2.1em;margin-top:0}h2{font-size:1.5em}h3{font-size:1.2em}\
p,ul,ol,blockquote,pre,table{margin:0 0 1.1em}\
a{color:#2851a3}\
blockquote{padding-left:1em;border-left:3px solid #d4d4da;color:#4a4a52}\
code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,\"Liberation Mono\",monospace;font-size:.88em}\
code{background:#f3f3f6;padding:.1em .3em;border-radius:4px}\
pre{background:#f3f3f6;padding:.9em 1em;border-radius:6px;overflow:auto}\
pre code{background:none;padding:0}\
table{border-collapse:collapse;width:100%}\
th,td{border:1px solid #d4d4da;padding:.4em .6em;text-align:left;vertical-align:top}\
img{max-width:100%;height:auto}\
hr{border:0;border-top:1px solid #d4d4da;margin:2em 0}\
@media print{body{max-width:none;margin:0;padding:0;font-size:11pt}\
a{color:inherit}pre{white-space:pre-wrap}\
h1,h2,h3,h4{break-after:avoid}pre,blockquote,table,img{break-inside:avoid}}";

/// The file extension for a format.
pub fn extension(format: DraftExportFormat) -> &'static str {
    match format {
        DraftExportFormat::Markdown => "md",
        DraftExportFormat::Html => "html",
    }
}

/// The file contents for a draft in `format`, with a Sources section listing
/// the pages it links to (see [`with_sources`]).
pub fn render(title: &str, markdown: &str, format: DraftExportFormat) -> String {
    let markdown = with_sources(markdown);
    match format {
        DraftExportFormat::Markdown => markdown_file(&markdown),
        DraftExportFormat::Html => html_page(title, &markdown),
    }
}

/// Every distinct http(s) link in the draft, in order of first appearance,
/// with the text of its first appearance (empty for an autolink).
pub fn web_links(markdown: &str) -> Vec<(String, String)> {
    let body = match draft_blocks::front_matter_end(markdown) {
        Some(end) => &markdown[end..],
        None => markdown,
    };
    let mut links: Vec<(String, String)> = Vec::new();
    // The link being read: its address, its text so far, and whether it is new.
    let mut open: Option<(String, String, bool)> = None;
    for event in Parser::new_ext(body, draft_blocks::markdown_options()) {
        match event {
            Event::Start(Tag::Link {
                link_type,
                dest_url,
                ..
            }) => {
                let url = dest_url.trim().to_string();
                let lower = url.to_ascii_lowercase();
                let web = (lower.starts_with("http://") || lower.starts_with("https://"))
                    && url.len() > lower.find("://").unwrap_or(0) + 3;
                let new = web && !links.iter().any(|(u, _)| *u == url);
                if new && matches!(link_type, LinkType::Autolink) {
                    // Its text is the address itself.
                    links.push((url.clone(), String::new()));
                    open = Some((url, String::new(), false));
                } else {
                    open = Some((url, String::new(), new));
                }
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some((_, label, _)) = open.as_mut() {
                    label.push_str(&text);
                }
            }
            Event::SoftBreak | Event::HardBreak => {
                if let Some((_, label, _)) = open.as_mut() {
                    label.push(' ');
                }
            }
            Event::End(TagEnd::Link) => {
                if let Some((url, label, true)) = open.take() {
                    links.push((url, label.split_whitespace().collect::<Vec<_>>().join(" ")));
                }
            }
            _ => {}
        }
    }
    links
}

/// The host of an http(s) address, without `www.`.
fn host_of(url: &str) -> String {
    match url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
    {
        Some(host) => host.strip_prefix("www.").unwrap_or(&host).to_string(),
        None => url.to_string(),
    }
}

/// Link text with the characters that would end or break it escaped.
fn escape_link_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '[' | ']' | '*' | '_' | '`' | '<' | '>') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// A link target that survives Markdown: wrapped in `<…>` when it holds
/// spaces or parentheses.
fn link_target(url: &str) -> String {
    if url.contains(|c: char| c.is_whitespace() || c == '(' || c == ')') {
        format!("<{}>", url.replace('<', "%3C").replace('>', "%3E"))
    } else {
        url.to_string()
    }
}

/// True when the draft's last `##` (or `#`) section is headed "Sources".
fn ends_with_sources(markdown: &str) -> bool {
    draft_blocks::split(markdown)
        .iter()
        .rev()
        .find(|s| s.kind == draft_blocks::KIND_HEADING && s.level <= 2)
        .is_some_and(|s| draft_blocks::heading_key(&markdown[s.range()]) == "sources")
}

/// The draft with a `## Sources` section appended listing every distinct
/// http(s) link (first appearance order, `[link text or host](url)`), unless
/// it links nowhere or already ends with a Sources section.
pub fn with_sources(markdown: &str) -> String {
    let links = web_links(markdown);
    if links.is_empty() || ends_with_sources(markdown) {
        return markdown.to_string();
    }
    let mut out = markdown.trim_end().to_string();
    out.push_str("\n\n## Sources\n\n");
    for (url, text) in links {
        let label = if text.trim().is_empty() || text.trim() == url {
            host_of(&url)
        } else {
            text
        };
        out.push_str(&format!(
            "- [{}]({})\n",
            escape_link_text(&label),
            link_target(&url)
        ));
    }
    out
}

/// The Markdown as written, ending with one line break.
pub fn markdown_file(markdown: &str) -> String {
    let mut out = markdown.trim_end().to_string();
    out.push('\n');
    out
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// A link or image target the page may keep: http(s), mailto, or a relative
/// or fragment URL. Anything else (`javascript:`, `data:`, `file:`) becomes `#`.
fn safe_url(url: CowStr<'_>) -> CowStr<'_> {
    let trimmed = url.trim();
    let scheme_end = trimmed.find([':', '/', '?', '#']);
    let has_scheme = scheme_end.is_some_and(|i| trimmed[i..].starts_with(':'));
    if !has_scheme {
        return url;
    }
    let scheme = trimmed[..scheme_end.unwrap_or(0)].to_ascii_lowercase();
    if matches!(scheme.as_str(), "http" | "https" | "mailto") {
        url
    } else {
        CowStr::Borrowed("#")
    }
}

/// The draft's body as HTML: raw HTML escaped, unsafe URLs dropped, front
/// matter left out.
pub fn body_html(markdown: &str) -> String {
    let body = match draft_blocks::front_matter_end(markdown) {
        Some(end) => &markdown[end..],
        None => markdown,
    };
    let events = Parser::new_ext(body, draft_blocks::markdown_options()).map(|event| match event {
        Event::Html(text) | Event::InlineHtml(text) => Event::Text(text),
        Event::Start(Tag::HtmlBlock) => Event::Start(Tag::Paragraph),
        Event::End(TagEnd::HtmlBlock) => Event::End(TagEnd::Paragraph),
        Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Link {
            link_type,
            dest_url: safe_url(dest_url),
            title,
            id,
        }),
        Event::Start(Tag::Image {
            link_type,
            dest_url,
            title,
            id,
        }) => Event::Start(Tag::Image {
            link_type,
            dest_url: safe_url(dest_url),
            title,
            id,
        }),
        other => other,
    });
    let mut out = String::with_capacity(body.len() * 3 / 2);
    html::push_html(&mut out, events);
    out
}

/// A standalone HTML page for the draft, titled `title`.
pub fn html_page(title: &str, markdown: &str) -> String {
    format!(
        "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <title>{}</title>\n<style>{STYLE}</style>\n</head>\n<body>\n<article>\n{}</article>\n</body>\n</html>\n",
        escape(title.trim()),
        body_html(markdown)
    )
}

/// Write the export to the path the user picked.
pub fn write(path: &Path, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents.as_bytes()).map_err(|e| format!("Couldn't save the file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_export_is_the_draft() {
        assert_eq!(markdown_file("# T\n\nBody.\n\n\n"), "# T\n\nBody.\n");
    }

    #[test]
    fn html_escapes_raw_html_and_unsafe_links() {
        let md = "# Title & more\n\n<script>alert(1)</script>\n\nText with <b onclick=\"x\">tag</b>.\n\n\
                  [ok](https://example.com) [rel](./a.md) [bad](javascript:alert(1)) [mail](mailto:a@b.c)\n\n\
                  ![img](data:image/png;base64,AAAA)";
        let page = html_page("A <draft>", md);
        assert!(page.contains("<title>A &lt;draft&gt;</title>"), "{page}");
        assert!(!page.contains("<script>"), "{page}");
        assert!(
            page.contains("&lt;script&gt;alert(1)&lt;/script&gt;"),
            "{page}"
        );
        assert!(!page.contains("<b onclick"), "{page}");
        assert!(
            page.contains("&lt;b onclick=\"x\"&gt;tag&lt;/b&gt;"),
            "{page}"
        );
        assert!(page.contains("href=\"https://example.com\""));
        assert!(page.contains("href=\"./a.md\""));
        assert!(page.contains("href=\"mailto:a@b.c\""));
        assert!(!page.contains("javascript:"), "{page}");
        assert!(!page.contains("data:image"), "{page}");
        assert!(page.contains("<h1>Title &amp; more</h1>"));
        assert!(page.contains("@media print"));
    }

    #[test]
    fn exports_list_every_distinct_web_link_under_sources() {
        let md = "## Moss\n\nMoss holds [water](https://example.org/water) and \
                  [grows](https://www.moss.example/a) slowly; see <https://www.moss.example/b>.\n\n\
                  - Again: [same page](https://example.org/water)\n\
                  - [local](./notes.md), [mail](mailto:a@b.c), ![pic](https://img.example/p.png)\n\n\
                  [ref link][r]\n\n[r]: https://ref.example/x \"T\"\n";
        let out = with_sources(md);
        assert!(
            out.ends_with(
                "\n\n## Sources\n\n\
                 - [water](https://example.org/water)\n\
                 - [grows](https://www.moss.example/a)\n\
                 - [moss.example](https://www.moss.example/b)\n\
                 - [ref link](https://ref.example/x)\n"
            ),
            "{out}"
        );
        assert!(out.starts_with("## Moss\n\nMoss holds"));
        // Both formats carry it.
        assert!(render("T", md, DraftExportFormat::Markdown).contains("## Sources"));
        let html = render("T", md, DraftExportFormat::Html);
        assert!(html.contains("<h2>Sources</h2>"), "{html}");
        assert!(html.contains("<a href=\"https://ref.example/x\">ref link</a>"));
    }

    #[test]
    fn no_sources_section_without_links_or_when_one_ends_the_draft() {
        let plain = "## Moss\n\nNo links here, only ![a picture](https://img.example/p.png).\n";
        assert_eq!(with_sources(plain), plain);
        let has =
            "## Moss\n\nSee [a](https://a.example).\n\n## sources\n\n- [a](https://a.example)\n";
        assert_eq!(with_sources(has), has);
        // A Sources section earlier in the draft does not count.
        let earlier = "## Sources\n\nTBD.\n\n## Moss\n\nSee [a](https://a.example).";
        assert!(with_sources(earlier).ends_with("## Sources\n\n- [a](https://a.example)\n"));
    }

    #[test]
    fn source_entries_escape_text_and_awkward_targets() {
        let md = "See [*the* [old] page](https://a.example/x_(y)) and [](https://b.example).";
        let out = with_sources(md);
        assert!(
            out.ends_with(
                "- [the \\[old\\] page](<https://a.example/x_(y)>)\n- [b.example](https://b.example)\n"
            ),
            "{out}"
        );
    }

    #[test]
    fn html_renders_tables_code_and_skips_front_matter() {
        let md = "---\nsecret: yes\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n<x>\n```";
        let body = body_html(md);
        assert!(!body.contains("secret"), "{body}");
        assert!(
            body.contains("<table>") && body.contains("<td>1</td>"),
            "{body}"
        );
        assert!(
            body.contains("<pre><code>&lt;x&gt;\n</code></pre>"),
            "{body}"
        );
    }
}
