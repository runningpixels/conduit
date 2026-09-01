//! Conversation export (t0-4): Markdown / JSON dump of a chat.
//!
//! Rendering and redaction live here so the clipboard preview and the native
//! save-dialog write cannot drift. The OS picker itself lives on the command
//! (ADR-008: the renderer never supplies a path).

use std::path::{Path, PathBuf};

use provider_core::schema::{Conversation, Message, MessagePartKind, MessageRole};
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::{
    brand,
    db::repository::{attachments, conversations, messages},
    encryption::Encryption,
    time::now_iso8601,
    workspace_tools::secret_redact,
};

const SCHEMA_VERSION: u32 = 1;
const FILENAME_MAX_CHARS: usize = 80;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    Markdown,
    Json,
}

impl ExportFormat {
    pub fn extension(self) -> &'static str {
        match self {
            ExportFormat::Markdown => "md",
            ExportFormat::Json => "json",
        }
    }

    pub fn dialog_filter_name(self) -> &'static str {
        match self {
            ExportFormat::Markdown => "Markdown",
            ExportFormat::Json => "JSON",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationExportResult {
    pub exported_to: String,
    pub bytes_written: u64,
}

#[derive(Debug, Clone)]
pub struct PreparedExport {
    pub body: String,
    pub suggested_filename: String,
}

/// Scrub secrets the same way tool output is scrubbed before it crosses the
/// trust boundary, then run the workspace scanner for key-shaped tokens
/// (AWS/GitHub/PEM, …) that the connector redactor does not cover.
pub fn redact_export_text(input: &str) -> String {
    let once = mcp_runtime::redact::redact_text(input);
    secret_redact::redact_text(&once)
}

pub fn suggested_filename(title: Option<&str>, format: ExportFormat) -> String {
    let base = sanitize_filename(title.unwrap_or(""), "conversation");
    format!("{base}.{}", format.extension())
}

/// Load, filter, redact, and render. Fails with a user-safe message when the
/// conversation is missing or has nothing visible to export.
pub async fn prepare(
    pool: &SqlitePool,
    conversation_id: &str,
    format: ExportFormat,
) -> Result<PreparedExport, String> {
    let conversation = conversations::get(pool, conversation_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Conversation not found.".to_string())?;
    let messages = messages::load_conversation_messages(pool, conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    let exportable: Vec<&Message> = messages
        .iter()
        .filter(|m| is_exportable_role(&m.role))
        .collect();
    if exportable.is_empty() {
        return Err("This chat has nothing to export.".to_string());
    }
    let body = match format {
        ExportFormat::Markdown => render_markdown(&conversation, &exportable),
        ExportFormat::Json => render_json(&conversation, &exportable)?,
    };
    Ok(PreparedExport {
        body,
        suggested_filename: suggested_filename(conversation.title.as_deref(), format),
    })
}

pub async fn preview(
    pool: &SqlitePool,
    conversation_id: &str,
    format: ExportFormat,
) -> Result<String, String> {
    Ok(prepare(pool, conversation_id, format).await?.body)
}

/// Write a prepared (or freshly built) export to `dest`. When
/// `include_attachments` is set, active attachment blobs are copied into
/// `{stem}-attachments/` next to the file — never next to the DB.
pub async fn export_to_path(
    pool: &SqlitePool,
    attachments_dir: &Path,
    enc: &Encryption,
    conversation_id: &str,
    format: ExportFormat,
    include_attachments: bool,
    dest: &Path,
) -> Result<ConversationExportResult, String> {
    let prepared = prepare(pool, conversation_id, format).await?;
    let result = write_export(dest, &prepared.body)?;
    if include_attachments {
        copy_attachments(pool, attachments_dir, enc, conversation_id, dest).await?;
    }
    Ok(result)
}

pub fn write_export(dest: &Path, body: &str) -> Result<ConversationExportResult, String> {
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create the export folder: {e}"))?;
        }
    }
    std::fs::write(dest, body.as_bytes())
        .map_err(|e| format!("Could not write the export: {e}"))?;
    Ok(ConversationExportResult {
        exported_to: dest.display().to_string(),
        bytes_written: body.len() as u64,
    })
}

fn is_exportable_role(role: &MessageRole) -> bool {
    matches!(
        role,
        MessageRole::User | MessageRole::Assistant | MessageRole::Tool
    )
}

fn render_markdown(conversation: &Conversation, messages: &[&Message]) -> String {
    let title = conversation
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Untitled chat");
    let exported_at = now_iso8601();
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", title));
    out.push_str(&format!(
        "_Exported from {} on {exported_at}_\n\n",
        brand::app_name()
    ));
    out.push_str(&format!("- Created: {}\n", conversation.created_at));
    out.push_str(&format!("- Updated: {}\n\n", conversation.updated_at));

    for (i, message) in messages.iter().enumerate() {
        if let Some(block) = render_message_markdown(message) {
            if i > 0 {
                out.push('\n');
            }
            out.push_str(&block);
            if !out.ends_with('\n') {
                out.push('\n');
            }
        }
    }
    out
}

fn render_message_markdown(message: &Message) -> Option<String> {
    let heading = match message.role {
        MessageRole::User => "You",
        MessageRole::Assistant => "Assistant",
        MessageRole::Tool => "Tool",
        MessageRole::System | MessageRole::Developer => return None,
    };
    let mut text_chunks: Vec<String> = Vec::new();
    let mut extras: Vec<String> = Vec::new();

    for part in &message.parts {
        match part.kind {
            MessagePartKind::Text => {
                if let Some(content) = part
                    .content
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    text_chunks.push(redact_export_text(content));
                }
            }
            MessagePartKind::Reasoning => {}
            MessagePartKind::ToolCall => {
                let body = part.content.as_deref().unwrap_or("").trim();
                if !body.is_empty() {
                    let summary = tool_summary("Tool call", body);
                    extras.push(details_block(&summary, &redact_export_text(body)));
                }
            }
            MessagePartKind::ToolResult => {
                let body = part.content.as_deref().unwrap_or("").trim();
                if !body.is_empty() {
                    extras.push(details_block("Tool result", &redact_export_text(body)));
                }
            }
            MessagePartKind::ArtifactReference => {
                let id = part.artifact_id.as_deref().unwrap_or("unknown");
                extras.push(format!("[artifact {id}]"));
            }
            MessagePartKind::AttachmentReference => {
                let id = part.attachment_id.as_deref().unwrap_or("unknown");
                extras.push(format!("[attachment {id}]"));
            }
            MessagePartKind::Image => extras.push("[image]".to_string()),
            MessagePartKind::File => extras.push("[file]".to_string()),
        }
    }

    if text_chunks.is_empty() && extras.is_empty() {
        return None;
    }

    let mut out = format!("## {heading} · {}\n\n", message.created_at);
    out.push_str(&text_chunks.join("\n\n"));
    if !text_chunks.is_empty() && !extras.is_empty() {
        out.push_str("\n\n");
    }
    out.push_str(&extras.join("\n\n"));
    Some(out)
}

fn tool_summary(kind: &str, body: &str) -> String {
    const PREFIX: &str = "Tool call: ";
    if let Some(name) = body.strip_prefix(PREFIX) {
        let name = name.split(['\n', '{']).next().unwrap_or(name).trim();
        if !name.is_empty() {
            return format!("{kind}: {name}");
        }
    }
    kind.to_string()
}

fn details_block(summary: &str, body: &str) -> String {
    format!(
        "<details>\n<summary>{}</summary>\n\n{}\n\n</details>",
        escape_html(summary),
        fenced(body)
    )
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Fence the body with one more backtick than the longest run that starts a line,
/// so nested markdown fences in the chat cannot break the export.
fn fenced(body: &str) -> String {
    let mut longest = 2usize;
    for line in body.lines() {
        let n = line.chars().take_while(|&c| c == '`').count();
        if n > longest {
            longest = n;
        }
    }
    let ticks = "`".repeat(longest + 1);
    format!("{ticks}\n{body}\n{ticks}")
}

fn render_json(conversation: &Conversation, messages: &[&Message]) -> Result<String, String> {
    let doc = serde_json::json!({
        "schemaVersion": SCHEMA_VERSION,
        "exportedAt": now_iso8601(),
        "conversation": {
            "id": conversation.id,
            "title": conversation.title,
            "createdAt": conversation.created_at,
            "updatedAt": conversation.updated_at,
        },
        "messages": messages.iter().map(|m| export_message_json(m)).collect::<Vec<_>>(),
    });
    serde_json::to_string_pretty(&doc).map_err(|e| format!("Could not serialize the export: {e}"))
}

fn export_message_json(message: &Message) -> serde_json::Value {
    let parts: Vec<serde_json::Value> = message
        .parts
        .iter()
        .map(|part| {
            let kind = match part.kind {
                MessagePartKind::Text => "text",
                MessagePartKind::ToolCall => "toolCall",
                MessagePartKind::ToolResult => "toolResult",
                MessagePartKind::ArtifactReference => "artifactReference",
                MessagePartKind::AttachmentReference => "attachmentReference",
                MessagePartKind::Reasoning => "reasoning",
                MessagePartKind::Image => "image",
                MessagePartKind::File => "file",
            };
            serde_json::json!({
                "kind": kind,
                "content": part.content.as_deref().map(redact_export_text),
                "toolCallId": part.tool_call_id,
                "artifactId": part.artifact_id,
                "attachmentId": part.attachment_id,
                "mimeType": part.mime_type,
            })
        })
        .collect();
    serde_json::json!({
        "id": message.id,
        "role": role_json(&message.role),
        "createdAt": message.created_at,
        "interruptedAt": message.interrupted_at,
        "parts": parts,
    })
}

fn role_json(role: &MessageRole) -> &'static str {
    match role {
        MessageRole::System => "system",
        MessageRole::Developer => "developer",
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::Tool => "tool",
    }
}

async fn copy_attachments(
    pool: &SqlitePool,
    attachments_dir: &Path,
    enc: &Encryption,
    conversation_id: &str,
    dest: &Path,
) -> Result<(), String> {
    let rows = attachments::list_for_conversation(pool, conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    let active: Vec<_> = rows
        .into_iter()
        .filter(|a| a.retention_state == "active")
        .collect();
    if active.is_empty() {
        return Ok(());
    }
    let folder = attachment_folder(dest);
    std::fs::create_dir_all(&folder)
        .map_err(|e| format!("Could not create the attachments folder: {e}"))?;
    for att in active {
        let bytes = attachments::read_bytes(attachments_dir, enc, &att.path)
            .map_err(|e| format!("Could not read attachment {}: {e}", att.id))?;
        let name = attachment_export_name(&att);
        let path = unique_path(&folder, &name);
        std::fs::write(&path, bytes)
            .map_err(|e| format!("Could not write attachment {}: {e}", att.id))?;
    }
    Ok(())
}

fn attachment_folder(dest: &Path) -> PathBuf {
    let stem = dest
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "conversation".to_string());
    match dest.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            parent.join(format!("{stem}-attachments"))
        }
        _ => PathBuf::from(format!("{stem}-attachments")),
    }
}

fn attachment_export_name(att: &attachments::Attachment) -> String {
    if let Some(origin) = att.origin.as_deref() {
        if let Some(name) = Path::new(origin).file_name() {
            let name = name.to_string_lossy();
            if !name.trim().is_empty() {
                return sanitize_filename(&name, &att.id);
            }
        }
    }
    sanitize_filename(&att.id, "attachment")
}

fn sanitize_filename(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 32 => '_',
            c => c,
        })
        .take(FILENAME_MAX_CHARS)
        .collect();
    let cleaned = cleaned.trim_matches('.').trim();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned.to_string()
    }
}

fn unique_path(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let stem = Path::new(filename)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| filename.to_string());
    let ext = Path::new(filename)
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    for n in 2usize.. {
        let next = dir.join(format!("{stem}-{n}{ext}"));
        if !next.exists() {
            return next;
        }
    }
    dir.join(filename)
}

#[cfg(test)]
mod tests {
    use super::*;
    use provider_core::schema::MessagePart;

    fn part(kind: MessagePartKind, content: &str) -> MessagePart {
        MessagePart {
            id: "p".into(),
            message_id: "m".into(),
            index: 0,
            kind,
            content: Some(content.into()),
            mime_type: None,
            tool_call_id: None,
            artifact_id: None,
            attachment_id: None,
            blob_ref: None,
            metadata: None,
            created_at: "2026-08-31T00:00:00.000Z".into(),
        }
    }

    fn msg(role: MessageRole, parts: Vec<MessagePart>) -> Message {
        Message {
            id: "m1".into(),
            conversation_id: "c1".into(),
            role,
            author_label: None,
            provider_message_id: None,
            request_id: None,
            interrupted_at: None,
            metadata: None,
            parts,
            created_at: "2026-08-31T12:00:00.000Z".into(),
        }
    }

    fn conv(title: Option<&str>) -> Conversation {
        Conversation {
            id: "c1".into(),
            title: title.map(|s| s.to_string()),
            created_at: "2026-08-31T11:00:00.000Z".into(),
            updated_at: "2026-08-31T12:00:00.000Z".into(),
            cloud_id: None,
            metadata: None,
            workspace_root: Some("C:\\secret\\project".into()),
            generation_controls: None,
            user_instructions: None,
        }
    }

    #[test]
    fn markdown_includes_title_and_roles() {
        let user = msg(
            MessageRole::User,
            vec![part(MessagePartKind::Text, "Hello")],
        );
        let asst = msg(
            MessageRole::Assistant,
            vec![part(MessagePartKind::Text, "Hi there")],
        );
        let md = render_markdown(&conv(Some("Triage")), &[&user, &asst]);
        assert!(md.starts_with("# Triage\n"));
        assert!(md.contains("## You · 2026-08-31T12:00:00.000Z"));
        assert!(md.contains("Hello"));
        assert!(md.contains("## Assistant"));
        assert!(md.contains("Hi there"));
        assert!(!md.contains("C:\\secret\\project"));
    }

    #[test]
    fn markdown_skips_system_and_reasoning() {
        let sys = msg(
            MessageRole::System,
            vec![part(MessagePartKind::Text, "you are a bot")],
        );
        let asst = msg(
            MessageRole::Assistant,
            vec![
                part(MessagePartKind::Reasoning, "secret chain of thought"),
                part(MessagePartKind::Text, "Visible answer"),
            ],
        );
        let md = render_markdown(&conv(None), &[&sys, &asst]);
        assert!(md.contains("# Untitled chat"));
        assert!(!md.contains("you are a bot"));
        assert!(!md.contains("secret chain of thought"));
        assert!(md.contains("Visible answer"));
    }

    #[test]
    fn markdown_redacts_secrets_and_nests_fences() {
        let user = msg(
            MessageRole::User,
            vec![part(MessagePartKind::Text, "token=sekrit123")],
        );
        let asst = msg(
            MessageRole::Assistant,
            vec![part(
                MessagePartKind::ToolResult,
                "```\ninner fence\nBearer abc.def\n```",
            )],
        );
        let md = render_markdown(&conv(Some("Secrets")), &[&user, &asst]);
        assert!(!md.contains("sekrit123"), "got {md}");
        assert!(!md.contains("abc.def"), "got {md}");
        assert!(md.contains("[redacted]") || md.contains("[REDACTED]"));
        assert!(md.contains("<details>"));
        assert!(md.contains("Tool result"));
        // Tool output is fenced with one more backtick than the nested fence.
        assert!(md.contains("````\n"));
    }

    #[test]
    fn json_omits_workspace_root_and_redacts() {
        let user = msg(
            MessageRole::User,
            vec![part(MessagePartKind::Text, "password=hunter2")],
        );
        let json = render_json(&conv(Some("Keys")), &[&user]).unwrap();
        assert!(!json.contains("hunter2"), "got {json}");
        assert!(!json.contains("workspaceRoot"));
        assert!(!json.contains("C:\\\\secret\\\\project"));
        assert!(json.contains("\"schemaVersion\": 1"));
        assert!(json.contains("\"role\": \"user\""));
    }

    #[test]
    fn suggested_filename_sanitizes() {
        assert_eq!(
            suggested_filename(Some("foo/bar:baz"), ExportFormat::Markdown),
            "foo_bar_baz.md"
        );
        assert_eq!(
            suggested_filename(Some("   "), ExportFormat::Json),
            "conversation.json"
        );
    }

    #[test]
    fn write_export_creates_parent_and_counts_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("out").join("chat.md");
        let result = write_export(&dest, "# hi\n").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "# hi\n");
        assert_eq!(result.bytes_written, 5);
        assert!(result.exported_to.ends_with("chat.md"));
    }
}
