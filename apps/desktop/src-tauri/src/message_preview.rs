//! Artifact-aware message preview summarization for history rails.
//!
//! Mirrors the fence parsing and summary format in
//! `apps/desktop/src/chat/messageSegments.ts` so backend `last_message_preview`
//! values stay compact instead of dumping full artifact bodies.

use std::collections::HashMap;

const MIN_UNLABELED_BODY: usize = 200;
const TITLE_MAX: usize = 60;
const PREVIEW_MAX_CHARS: usize = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArtifactKind {
    Markdown,
    Text,
    Json,
    Html,
    Code,
}

impl ArtifactKind {
    fn label(self) -> &'static str {
        match self {
            Self::Markdown => "Markdown",
            Self::Text => "Text",
            Self::Json => "JSON",
            Self::Html => "HTML",
            Self::Code => "Code",
        }
    }
}

#[derive(Debug, Clone)]
struct ArtifactCandidate {
    #[allow(dead_code)]
    info: String,
    body: String,
    kind: ArtifactKind,
    title: String,
}

#[derive(Debug, Clone)]
enum MessageSegment {
    Prose { text: String },
    Fence { candidate: ArtifactCandidate },
}

fn kind_from_lang_table() -> HashMap<&'static str, ArtifactKind> {
    [
        ("markdown", ArtifactKind::Markdown),
        ("md", ArtifactKind::Markdown),
        ("text", ArtifactKind::Text),
        ("txt", ArtifactKind::Text),
        ("plain", ArtifactKind::Text),
        ("plaintext", ArtifactKind::Text),
        ("json", ArtifactKind::Json),
        ("jsonc", ArtifactKind::Json),
        ("html", ArtifactKind::Html),
        ("htm", ArtifactKind::Html),
    ]
    .into_iter()
    .collect()
}

fn first_info_token(info: &str) -> &str {
    info.split_whitespace().next().unwrap_or("")
}

fn looks_like_json(body: &str) -> bool {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return false;
    }
    let first = trimmed.chars().next().unwrap_or(' ');
    let last = trimmed.chars().last().unwrap_or(' ');
    if !((first == '{' || first == '[') && (last == '}' || last == ']')) {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(trimmed).is_ok()
}

fn resolve_kind(info: &str, body: &str) -> Option<ArtifactKind> {
    let lang = first_info_token(info).to_lowercase();
    let table = kind_from_lang_table();
    if !lang.is_empty() {
        if let Some(mapped) = table.get(lang.as_str()) {
            return Some(*mapped);
        }
        return Some(ArtifactKind::Code);
    }
    if body.trim().is_empty() {
        return None;
    }
    if looks_like_json(body) {
        return Some(ArtifactKind::Json);
    }
    let trimmed = body.trim();
    if trimmed.starts_with('<')
        && (trimmed.to_lowercase().starts_with("<!doctype")
            || trimmed.to_lowercase().starts_with("<html")
            || trimmed
                .chars()
                .nth(1)
                .map(|c| c.is_ascii_alphabetic())
                .unwrap_or(false))
    {
        return Some(ArtifactKind::Html);
    }
    if body.len() > MIN_UNLABELED_BODY {
        return Some(ArtifactKind::Markdown);
    }
    None
}

fn extract_html_title(body: &str) -> Option<String> {
    let lower = body.to_lowercase();
    let start = lower.find("<title")?;
    let after_open = &body[start..];
    let gt = after_open.find('>')?;
    let rest = &after_open[gt + 1..];
    let end = rest.to_lowercase().find("</title>")?;
    let title = rest[..end].split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return None;
    }
    Some(truncate_chars(&title, TITLE_MAX))
}

fn extract_markdown_heading(body: &str) -> Option<String> {
    for line in body.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix('#') {
            let rest = rest.trim_start_matches('#').trim();
            if !rest.is_empty() {
                return Some(truncate_chars(rest, TITLE_MAX));
            }
        }
    }
    None
}

fn derive_title(kind: ArtifactKind, info: &str, body: &str) -> String {
    if kind == ArtifactKind::Html {
        if let Some(t) = extract_html_title(body) {
            return t;
        }
    }
    if kind == ArtifactKind::Markdown {
        if let Some(t) = extract_markdown_heading(body) {
            return t;
        }
    }
    if let Some(line) = body.lines().map(str::trim).find(|l| !l.is_empty()) {
        return truncate_chars(line, TITLE_MAX);
    }
    let lang = first_info_token(info);
    if !lang.is_empty() {
        return format!("{lang} snippet");
    }
    match kind {
        ArtifactKind::Markdown => "Markdown artifact".to_string(),
        _ => "Text artifact".to_string(),
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max).collect();
    format!("{truncated}…")
}

fn match_open_fence(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim_start();
    let fence_chars: Vec<char> = trimmed.chars().take_while(|c| *c == '`' || *c == '~').collect();
    if fence_chars.len() < 3 {
        return None;
    }
    let fence: String = fence_chars.iter().collect();
    let open_char = fence_chars[0];
    if !fence.chars().all(|c| c == open_char) {
        return None;
    }
    let rest = trimmed[fence.len()..].trim();
    Some((fence, rest.to_string()))
}

fn is_close_fence(line: &str, open_char: char) -> bool {
    let trimmed = line.trim();
    let fence_chars: Vec<char> = trimmed.chars().take_while(|c| *c == '`' || *c == '~').collect();
    if fence_chars.len() < 3 {
        return false;
    }
    fence_chars[0] == open_char
}

fn parse_message_segments(content: &str) -> Vec<MessageSegment> {
    let src = content.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = src.split('\n').collect();
    let mut segments = Vec::new();
    let mut prose_lines: Vec<String> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if let Some((fence, info)) = match_open_fence(lines[i]) {
            let open_char = fence.chars().next().unwrap_or('`');
            let mut body_lines: Vec<String> = Vec::new();
            let mut j = i + 1;
            while j < lines.len() {
                if is_close_fence(lines[j], open_char) {
                    break;
                }
                body_lines.push(lines[j].to_string());
                j += 1;
            }
            let body = body_lines.join("\n");
            if let Some(kind) = resolve_kind(&info, &body) {
                if !prose_lines.is_empty() {
                    segments.push(MessageSegment::Prose {
                        text: prose_lines.join("\n"),
                    });
                    prose_lines.clear();
                }
                let title = derive_title(kind, &info, &body);
                segments.push(MessageSegment::Fence {
                    candidate: ArtifactCandidate {
                        info,
                        body,
                        kind,
                        title,
                    },
                });
                i = j;
            } else {
                prose_lines.push(lines[i].to_string());
                for k in (i + 1)..=j.min(lines.len().saturating_sub(1)) {
                    prose_lines.push(lines[k].to_string());
                }
                i = j;
            }
        } else {
            prose_lines.push(lines[i].to_string());
        }
        i += 1;
    }
    if !prose_lines.is_empty() {
        segments.push(MessageSegment::Prose {
            text: prose_lines.join("\n"),
        });
    }
    segments
}

fn normalize_preview_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn summarize_fence_for_preview(candidate: &ArtifactCandidate) -> String {
    let label = candidate.kind.label();
    let line_count = candidate.body.lines().count().max(1);
    let title = candidate.title.trim();
    let generic_title = title == "Markdown artifact"
        || title == "Text artifact"
        || title.ends_with(" snippet");
    if !title.is_empty() && !generic_title {
        return format!("{label} artifact · {title} · {line_count} lines");
    }
    format!("{label} artifact · {line_count} lines")
}

/// Produce a compact, artifact-aware preview for history rails.
pub fn summarize_message_content_for_preview(content: &str) -> Option<String> {
    summarize_message_content_for_preview_with_max(content, PREVIEW_MAX_CHARS)
}

pub fn summarize_message_content_for_preview_with_max(
    content: &str,
    max_chars: usize,
) -> Option<String> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return None;
    }

    let segments = parse_message_segments(trimmed);
    let mut parts: Vec<String> = Vec::new();
    for seg in segments {
        match seg {
            MessageSegment::Prose { text } => {
                let prose = normalize_preview_whitespace(&text);
                if !prose.is_empty() {
                    parts.push(prose);
                }
            }
            MessageSegment::Fence { candidate } => {
                parts.push(summarize_fence_for_preview(&candidate));
            }
        }
    }

    let joined = normalize_preview_whitespace(&parts.join(" "));
    if joined.is_empty() {
        return None;
    }
    Some(truncate_chars(&joined, max_chars))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_fence_becomes_compact_summary() {
        let body = "```html\n<!DOCTYPE html><html><head><title>Python overview</title></head><body><p>lots</p></body></html>\n```";
        let preview = summarize_message_content_for_preview(body).unwrap();
        assert!(preview.contains("HTML artifact"));
        assert!(preview.contains("Python overview"));
        assert!(!preview.contains("<!DOCTYPE"));
    }

    #[test]
    fn mixed_prose_and_artifact_keeps_prose() {
        let body = "Here is the artifact.\n```html\n<div>hi</div>\n```";
        let preview = summarize_message_content_for_preview(body).unwrap();
        assert!(preview.starts_with("Here is the artifact."));
        assert!(preview.contains("HTML artifact"));
        assert!(preview.contains("lines"));
        assert!(!preview.contains("```"));
    }

    #[test]
    fn long_preview_is_truncated() {
        let prose = "word ".repeat(80);
        let preview = summarize_message_content_for_preview(&prose).unwrap();
        assert!(preview.ends_with('…'));
        assert!(preview.chars().count() <= PREVIEW_MAX_CHARS + 1);
    }
}
