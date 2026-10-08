//! Connector tools as workflow steps (and the editor's tool picker).
//!
//! A workflow runs unattended, so it only calls tools that declare they just
//! read (the same classification chat uses to decide what runs without
//! asking). Everything here fails in plain words: a removed or switched-off
//! connector, one that needs signing in again, a tool the connector no longer
//! has, a missing required argument. Nothing in this path ever prompts: the
//! call goes through the same execution path as chat, but a consent request
//! (a tool that stopped reading since it was checked) is denied on the spot.

use std::sync::Arc;
use std::time::Duration;

use mcp_runtime::{
    protocol::{McpTool, PermissionLevel, ToolContent},
    redact,
};
use provider_core::schema::{ConnectorRuntimeEvent, ConsentDecision, ToolCallStatus};
use serde::Serialize;
use serde_json::Value;
use uuid::Uuid;

use super::catalog::is_connector_callable;
use super::consent::{is_read_only, list_live_tools};
use super::execution::{execute_tool_call_timed, EventSink, ToolCallRequest};
use super::{ActiveConnector, ConnectorRuntimeManager};
use crate::db::repository::connectors::{self as conn_repo, ConnectorDefinition, ConnectorVersion};
use crate::state::AppState;

/// How long a connector that isn't running is given to start.
pub const START_WAIT: Duration = Duration::from_secs(20);

/// The connector a step names, resolved to the version that would run.
#[derive(Debug, Clone)]
pub struct Target {
    pub definition: ConnectorDefinition,
    pub version: ConnectorVersion,
}

/// A tool a connector offers, as the workflow editor's picker lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    pub description: Option<String>,
    /// The tool only reads, so workflows may use it. Always set here (the
    /// listing is live); `null` is left for a cached listing.
    pub read_only: Option<bool>,
    /// `readOnly`, `sideEffectful` or `sensitive`.
    pub permission_level: PermissionLevel,
    /// The tool's JSON Schema for its arguments.
    pub input_schema: Value,
}

/// What a call returned, before the step shapes it.
#[derive(Debug, Clone)]
pub struct ToolResult {
    /// The text content, joined and redacted (not yet length-capped).
    pub text: String,
    /// The structured content, else the text parsed when it is a JSON object
    /// or list; redacted.
    pub data: Option<Value>,
}

fn quoted(text: &str) -> String {
    format!("\u{201c}{text}\u{201d}")
}

fn sign_in_message(name: &str) -> String {
    format!("{name} needs you to sign in again \u{2014} open Connectors.")
}

/// Whether a failure message from a connector means its sign-in has lapsed.
fn looks_like_sign_in(message: &str) -> bool {
    let lower = message.to_lowercase();
    ["sign in", "sign-in", "authentication", "unauthorized"]
        .iter()
        .any(|needle| lower.contains(needle))
}

/// The connector with id `connector_id` and the version that would run: the
/// newest one that is switched on. Fails plainly when it was removed, is
/// switched off, or needs signing in again.
pub async fn resolve(state: &AppState, connector_id: &str) -> Result<Target, String> {
    let removed = || "The connector this step uses was removed. Choose it again.".to_string();
    let id = connector_id.trim();
    if id.is_empty() {
        return Err("Choose the connector this step uses.".to_string());
    }
    let definition = conn_repo::get(&state.db, id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(removed)?;
    let versions = conn_repo::list_versions(&state.db, id)
        .await
        .map_err(|e| e.to_string())?;
    if versions.is_empty() {
        return Err(removed());
    }
    let mut newest_blocked: Option<ConnectorVersion> = None;
    // Newest first: `list_versions` is oldest first.
    for version in versions.into_iter().rev() {
        let grants = conn_repo::list_grants_for_version(&state.db, &version.id)
            .await
            .map_err(|e| e.to_string())?;
        let grant = grants
            .iter()
            .find(|g| g.status == "active")
            .map(|g| g.status.as_str());
        if is_connector_callable(grant, version.support_state.as_deref()) {
            return Ok(Target {
                definition,
                version,
            });
        }
        newest_blocked.get_or_insert(version);
    }
    let name = &definition.name;
    let signed_out = match &newest_blocked {
        Some(version) => {
            version.support_state.as_deref() == Some("authRequired")
                || conn_repo::get_runtime_state(&state.db, &version.id)
                    .await
                    .ok()
                    .flatten()
                    .is_some_and(|s| s.health == "authRequired")
        }
        None => false,
    };
    Err(if signed_out {
        sign_in_message(name)
    } else {
        format!("{name} is turned off. Open Connectors to turn it back on.")
    })
}

/// The running connector for `target`, starting it first when it isn't (up to
/// [`START_WAIT`]).
pub async fn ensure_running(
    state: &AppState,
    mgr: &ConnectorRuntimeManager,
    target: &Target,
) -> Result<Arc<ActiveConnector>, String> {
    let version_id = &target.version.id;
    let name = &target.definition.name;
    if let Some(active) = mgr.active_connector(version_id) {
        return Ok(active);
    }
    match tokio::time::timeout(START_WAIT, mgr.start_connector(state, version_id)).await {
        Ok(Ok(_)) => {}
        Ok(Err(error)) => {
            let signed_out = looks_like_sign_in(&error)
                || conn_repo::get_runtime_state(&state.db, version_id)
                    .await
                    .ok()
                    .flatten()
                    .is_some_and(|s| s.health == "authRequired");
            return Err(if signed_out {
                sign_in_message(name)
            } else {
                format!("{name} couldn't start: {error}")
            });
        }
        Err(_) => {
            return Err(format!(
                "{name} didn't start within {} seconds.",
                START_WAIT.as_secs()
            ));
        }
    }
    mgr.active_connector(version_id)
        .ok_or_else(|| format!("{name} stopped right after it started."))
}

/// The tools the running connector offers now, minus any its version's
/// allowlist leaves out (the same set chat can use).
pub async fn live_tools(
    mgr: &ConnectorRuntimeManager,
    active: &Arc<ActiveConnector>,
    target: &Target,
) -> Result<Vec<McpTool>, String> {
    let name = &target.definition.name;
    let listed = tokio::time::timeout(mgr.call_timeout(), list_live_tools(active))
        .await
        .map_err(|_| format!("{name} didn't list its tools in time."))?
        .map_err(|e| format!("{name} couldn't list its tools: {}", e.message))?;
    Ok(listed
        .into_iter()
        .filter(|t| super::discovery::allowed_by(&target.version.capability_allowlist, &t.name))
        .collect())
}

/// The editor's tool picker: every tool `connector_id` offers right now, with
/// whether it only reads. Starts the connector when it isn't running.
pub async fn list_tools(
    state: &AppState,
    mgr: &ConnectorRuntimeManager,
    connector_id: &str,
) -> Result<Vec<ToolInfo>, String> {
    let target = resolve(state, connector_id).await?;
    let active = ensure_running(state, mgr, &target).await?;
    let mut tools: Vec<ToolInfo> = live_tools(mgr, &active, &target)
        .await?
        .into_iter()
        .map(|t| ToolInfo {
            read_only: Some(is_read_only(&t)),
            permission_level: t.effective_permission_level(),
            name: t.name,
            description: Some(t.description).filter(|d| !d.trim().is_empty()),
            input_schema: t.input_schema,
        })
        .collect();
    tools.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(tools)
}

/// The required arguments of `tool`'s schema that `arguments` lacks, in the
/// schema's order.
pub fn missing_required(tool: &McpTool, arguments: &Value) -> Vec<String> {
    tool.input_schema
        .get("required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|field| arguments.get(field).is_none_or(Value::is_null))
        .map(str::to_string)
        .collect()
}

fn list_of(fields: &[String]) -> String {
    let quoted: Vec<String> = fields.iter().map(|f| quoted(f)).collect();
    match quoted.split_last() {
        Some((last, rest)) if !rest.is_empty() => format!("{} and {last}", rest.join(", ")),
        Some((last, _)) => last.clone(),
        None => String::new(),
    }
}

/// Call `tool_name` on `target` with `arguments` (an object, already filled)
/// and return what it said. Refuses, in plain words, a tool that can change
/// things; the caller has already asked permission (when someone must be
/// asked) and checked that `arguments` is an object.
pub async fn call(
    state: &AppState,
    mgr: &ConnectorRuntimeManager,
    target: &Target,
    tool_name: &str,
    arguments: &Value,
    run_id: &str,
) -> Result<ToolResult, String> {
    let name = &target.definition.name;
    let active = ensure_running(state, mgr, target).await?;
    let tools = live_tools(mgr, &active, target).await?;
    let gone = || format!("{name} no longer has a tool called {}.", quoted(tool_name));
    let tool = tools
        .iter()
        .find(|t| t.name == tool_name)
        .ok_or_else(gone)?;
    if !is_read_only(tool) {
        return Err(not_read_only(name, tool_name));
    }
    let missing = missing_required(tool, arguments);
    if !missing.is_empty() {
        return Err(format!(
            "{} needs {}.",
            quoted(tool_name),
            list_of(&missing)
        ));
    }
    // The call runs from the capability cache; a tool the connector gained
    // since it started isn't in it yet.
    let cached = conn_repo::get_capability_by_name(&state.db, &target.version.id, tool_name)
        .await
        .map_err(|e| e.to_string())?;
    if cached.is_none() {
        mgr.discover_capabilities(state, &target.version.id).await?;
        let again = conn_repo::get_capability_by_name(&state.db, &target.version.id, tool_name)
            .await
            .map_err(|e| e.to_string())?;
        if again.is_none() {
            return Err(gone());
        }
    }

    let tool_call_id = Uuid::new_v4().to_string();
    let request_id = format!("workflow:{run_id}");
    let request = ToolCallRequest {
        connector_version_id: &target.version.id,
        tool_call_id: &tool_call_id,
        request_id: &request_id,
        tool_name,
        arguments,
        conversation_id: None,
    };
    // Nobody can answer a prompt here: if the tool stopped being read-only
    // between the check above and the call, say no at once.
    let refuser = mgr.clone();
    let sink: EventSink = Arc::new(move |event| {
        if let ConnectorRuntimeEvent::ConsentRequested { prompt } = event {
            let _ = refuser.resolve_consent(&prompt.tool_call_id, ConsentDecision::Denied);
        }
    });
    let outcome = execute_tool_call_timed(state, mgr, &request, &sink, None)
        .await
        .map_err(|error| {
            let signed_out = looks_like_sign_in(&error);
            if signed_out {
                sign_in_message(name)
            } else {
                format!("{name}: {error}")
            }
        })?;
    if outcome.record.status == ToolCallStatus::Cancelled {
        return Err(not_read_only(name, tool_name));
    }
    let output = outcome
        .output
        .ok_or_else(|| format!("{name} gave no answer."))?;

    let text = redact::redact_text(
        &output
            .content
            .iter()
            .filter_map(|c| match c {
                ToolContent::Text { text } => Some(text.as_str()),
                ToolContent::Other { .. } => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
    );
    if output.is_error {
        let reason = text.trim();
        return Err(if reason.is_empty() {
            format!("{name} reported an error from {}.", quoted(tool_name))
        } else {
            format!("{name} reported an error: {reason}")
        });
    }
    let data = match &output.structured_content {
        Some(structured) => Some(redact::redact_value(structured)),
        None => serde_json::from_str::<Value>(text.trim())
            .ok()
            .filter(|v| v.is_object() || v.is_array()),
    };
    Ok(ToolResult { text, data })
}

fn not_read_only(connector: &str, tool: &str) -> String {
    format!(
        "{} can change things in {connector}, and workflows can only use tools that just read, for now.",
        quoted(tool)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tool(schema: Value) -> McpTool {
        McpTool {
            name: "list_issues".into(),
            description: String::new(),
            input_schema: schema,
            permission_level: Some(PermissionLevel::ReadOnly),
            annotations: None,
        }
    }

    #[test]
    fn required_arguments_are_listed_in_plain_words() {
        let t = tool(json!({ "required": ["repo", "owner", "state"] }));
        let missing = missing_required(&t, &json!({ "state": "open", "owner": null }));
        assert_eq!(missing, vec!["repo", "owner"]);
        assert_eq!(
            list_of(&missing),
            "\u{201c}repo\u{201d} and \u{201c}owner\u{201d}"
        );
        assert_eq!(list_of(&["a".into()]), "\u{201c}a\u{201d}");
        assert!(missing_required(&tool(json!({})), &json!({})).is_empty());
    }

    #[test]
    fn sign_in_failures_are_recognised() {
        assert!(looks_like_sign_in(
            "MCP connector token expired; sign in again"
        ));
        assert!(looks_like_sign_in("Unauthorized"));
        assert!(!looks_like_sign_in("tool exceeded the call timeout"));
    }
}
