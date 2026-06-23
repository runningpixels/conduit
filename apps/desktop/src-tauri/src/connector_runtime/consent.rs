//! Consent *enforcement* — bridges the `mcp-runtime` consent policy with the
//! runtime's pending-decision registry and the IPC `ConsentPrompt` shape.
//!
//! Classification uses the connector's *live* tool declaration (a fresh
//! `tools/list`) so the consent tier always reflects what the connector
//! currently advertises, not a stale cache. An absent `permissionLevel` means
//! "unspecified" → read-only → auto (the runtime never silently treats a tool
//! as side-effectful, and never silently runs a declared side-effectful tool).

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

use mcp_runtime::{
    consent::{classify, expected_effect, ConsentKind},
    protocol::{McpTool, PermissionLevel},
    redact,
    McpError,
};
use provider_core::schema::{ConsentDecision, ConsentPrompt};
use tokio::sync::oneshot;

use super::ActiveConnector;
use crate::db::repository::connectors as conn_repo;

/// The outcome of a consent check for a pending tool call. `Auto` means
/// proceed immediately; `Prompt` means the caller must surface the prompt,
/// await the user's `ConsentDecision`, and only proceed on `Approved`.
pub enum ConsentRequirement {
    Auto {
        level: PermissionLevel,
    },
    Prompt {
        prompt: ConsentPrompt,
        decision: oneshot::Receiver<ConsentDecision>,
    },
}

/// Pending consent decisions keyed by `tool_call_id`. The approve/deny IPC
/// command (M4.6) resolves a waiting `request_consent` call by sending on the
/// matching channel.
pub type PendingConsents = Arc<StdMutex<HashMap<String, oneshot::Sender<ConsentDecision>>>>;

/// Look up a tool's live declaration on a running connector.
pub async fn classify_live(
    active: &Arc<ActiveConnector>,
    tool_name: &str,
) -> Result<McpTool, McpError> {
    let tools = {
        let mut t = active.transport.lock().await;
        t.list_tools(&active.cancel).await?
    };
    tools
        .into_iter()
        .find(|t| t.name == tool_name)
        .ok_or_else(|| McpError::protocol(format!("tool '{tool_name}' not discovered by connector")))
}

/// Build the prompt from an already-loaded definition (name + consent_copy).
pub fn build_prompt_with_def(
    connector_name: &str,
    consent_copy: Option<&str>,
    connector_version_id: &str,
    tool_call_id: &str,
    tool: &McpTool,
    arguments: &serde_json::Value,
) -> ConsentPrompt {
    let level = tool.permission_level.unwrap_or(PermissionLevel::ReadOnly);
    let decision = classify(tool);
    let expected = expected_effect(level, &tool.description);
    // Redact the arguments before they cross to the renderer. Truncate so a
    // huge payload can't flood the prompt.
    let redacted = redact::redact_value(arguments);
    let mut summary = redacted.to_string();
    if summary.len() > 240 {
        summary.truncate(240);
        summary.push('…');
    }
    // `decision.required` is Prompt here (caller only builds a prompt when
    // consent is required); `expected` already carries the level wording.
    let _ = decision;
    ConsentPrompt {
        tool_call_id: tool_call_id.to_string(),
        connector_version_id: connector_version_id.to_string(),
        connector_name: connector_name.to_string(),
        tool_name: tool.name.clone(),
        arguments: redacted,
        expected_effect: expected,
        data_summary: summary,
        consent_copy: consent_copy.map(|s| s.to_string()),
    }
}

/// Classify a tool call and either return `Auto` or register a pending
/// consent (storing the oneshot sender in `pending`) and return the prompt +
/// receiver. The caller awaits the receiver; `resolve_consent` fulfills it.
pub async fn request_consent(
    active: &Arc<ActiveConnector>,
    pending: &PendingConsents,
    version: &conn_repo::ConnectorVersion,
    definition: &conn_repo::ConnectorDefinition,
    tool_call_id: &str,
    tool_name: &str,
    arguments: &serde_json::Value,
) -> Result<ConsentRequirement, McpError> {
    let tool = classify_live(active, tool_name).await?;
    let decision = classify(&tool);
    match decision.required {
        ConsentKind::Auto => Ok(ConsentRequirement::Auto { level: decision.level }),
        ConsentKind::Prompt => {
            let prompt = build_prompt_with_def(
                &definition.name,
                definition.consent_copy.as_deref(),
                &version.id,
                tool_call_id,
                &tool,
                arguments,
            );
            let (tx, rx) = oneshot::channel();
            if let Ok(mut g) = pending.lock() {
                g.insert(tool_call_id.to_string(), tx);
            }
            Ok(ConsentRequirement::Prompt { prompt, decision: rx })
        }
    }
}

/// Fulfill a pending consent decision (from the approve/deny IPC command).
/// Returns Ok if a pending consent was resolved, Err if none exists (already
/// resolved, or the tool call never required consent).
pub fn resolve_consent(
    pending: &PendingConsents,
    tool_call_id: &str,
    decision: ConsentDecision,
) -> Result<(), String> {
    let tx = pending
        .lock()
        .map_err(|_| "consent registry lock poisoned".to_string())?
        .remove(tool_call_id);
    match tx {
        Some(tx) => tx.send(decision).map_err(|_| {
            "consent request was dropped before the decision arrived".to_string()
        }),
        None => Err("no pending consent for this tool call".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mcp_runtime::protocol::McpTool;
    use serde_json::json;

    fn tool(name: &str, level: Option<PermissionLevel>) -> McpTool {
        McpTool {
            name: name.into(),
            description: "desc".into(),
            input_schema: json!({}),
            permission_level: level,
        }
    }

    #[test]
    fn read_only_is_auto() {
        let t = tool("echo", Some(PermissionLevel::ReadOnly));
        assert_eq!(classify(&t).required, ConsentKind::Auto);
    }

    #[test]
    fn absent_level_defaults_to_read_only_auto() {
        let t = tool("mystery", None);
        assert_eq!(classify(&t).required, ConsentKind::Auto);
        assert_eq!(classify(&t).level, PermissionLevel::ReadOnly);
    }

    #[test]
    fn side_effectful_is_prompt() {
        let t = tool("post", Some(PermissionLevel::SideEffectful));
        assert_eq!(classify(&t).required, ConsentKind::Prompt);
    }

    #[test]
    fn prompt_redacts_arguments() {
        let t = tool("post", Some(PermissionLevel::SideEffectful));
        let args = json!({ "text": "token=Bearer sekrit", "channel": "general" });
        let prompt = build_prompt_with_def("Slack", Some("Be careful"), "v1", "tc1", &t, &args);
        assert_eq!(prompt.connector_name, "Slack");
        assert_eq!(prompt.consent_copy.as_deref(), Some("Be careful"));
        assert!(prompt.data_summary.contains("[redacted]"));
        assert!(!prompt.data_summary.contains("sekrit"));
        assert!(prompt.expected_effect.contains("Side-effectful"));
    }

    #[test]
    fn resolve_round_trips_a_decision() {
        let pending: PendingConsents = Arc::new(StdMutex::new(HashMap::new()));
        let (tx, mut rx) = oneshot::channel();
        pending.lock().unwrap().insert("tc".into(), tx);
        resolve_consent(&pending, "tc", ConsentDecision::Approved).unwrap();
        assert_eq!(rx.try_recv().unwrap(), ConsentDecision::Approved);
        // Second resolve fails (already resolved).
        assert!(resolve_consent(&pending, "tc", ConsentDecision::Denied).is_err());
    }
}