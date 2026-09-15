//! Resolving an MCP prompt template into composer draft text.
//!
//! Unlike [`resources`](super::resources), this needs no reinjection gate. A
//! resolved prompt does not enter the instruction context: it lands in the
//! composer as ordinary editable text, so the user reads verbatim what will be
//! sent and can change or discard it before sending. Anything a hostile server
//! puts here is visible in the composer first.
//!
//! It is still redacted, because a template can interpolate server-side values
//! and the composer draft is persisted with the conversation.

use mcp_runtime::{redact, ToolContent};
use provider_core::schema::PromptArguments;
use tokio_util::sync::CancellationToken;

use crate::db::repository::connectors as conn_repo;
use crate::state::AppState;

use super::ConnectorRuntimeManager;

/// Resolve a prompt and flatten it to text for the composer.
pub async fn get_prompt(
    state: &AppState,
    mgr: &ConnectorRuntimeManager,
    args: &PromptArguments,
) -> Result<String, String> {
    // Resolve against the capability cache, as tool calls and resource reads
    // do — the renderer cannot invoke a prompt discovery never surfaced.
    let cap = conn_repo::get_capability_by_name(&state.db, &args.connector_version_id, &args.name)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("prompt '{}' is not available on this connector", args.name))?;
    if cap.kind != "prompt" {
        return Err(format!(
            "'{}' is not a prompt (kind: {})",
            args.name, cap.kind
        ));
    }

    let cancel = CancellationToken::new();
    let messages = mgr
        .get_prompt(
            &args.connector_version_id,
            &args.name,
            &args.arguments,
            &cancel,
        )
        .await
        .map_err(|e| e.message)?;

    let mut parts: Vec<String> = Vec::new();
    let mut skipped = 0usize;
    for m in &messages {
        match &m.content {
            ToolContent::Text { text } if !text.trim().is_empty() => {
                parts.push(text.clone());
            }
            // A non-text part (image, embedded resource) is noted rather than
            // interpreted, so a multimodal template still yields usable text.
            _ => skipped += 1,
        }
    }

    if parts.is_empty() {
        return Err(if skipped > 0 {
            format!("this prompt returned only non-text content ({skipped} part(s))")
        } else {
            "this prompt returned no content".to_string()
        });
    }

    let mut out = redact::redact_text(&parts.join("\n\n"));
    if skipped > 0 {
        out.push_str(&format!(
            "\n\n[{skipped} non-text part(s) of this prompt were left out]"
        ));
    }
    Ok(out)
}
