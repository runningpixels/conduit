//! Phase 4 M4.5: tool execution orchestration.
//!
//! `execute_tool_call` walks one MCP tool call end-to-end through the trust
//! boundary:
//!
//! 1. **Resolve** the cached `ConnectorCapability` by `(version, tool_name)`.
//!    A tool not in the cache (e.g. filtered out by the tenant allowlist) is
//!    refused — the renderer cannot reach a tool the runtime never discovered.
//! 2. **Persist** the call as `Pending`.
//! 3. **Consent** (M4.4): `Auto` proceeds; `Prompt` emits a `ConsentRequested`
//!    event and awaits the user's decision. `Denied` → `Cancelled`, no invoke.
//! 4. **Invoke** via the supervisor's `invoke_tool` (per-call timeout + cancel).
//! 5. **Size-cap** the output (inline default: 1 MiB). Oversized → `Failed`.
//! 6. **Redact** the output (`mcp_runtime::redact`) before it is persisted or
//!    surfaced. Tool output is untrusted data throughout.
//! 7. **Persist** the final `ToolCallRecord` + a `tool_results` row (direct
//!    write, not via `event_log`) and emit `ToolCallFinished`.
//!
//! No-reinjection invariant (§6): the redacted output is stored in
//! `tool_results` and rendered through a separate display path. It is **never**
//! appended to `messages` or folded into a follow-up `ProviderRequest` here.
//! `mcp_runtime::validate_reinjection` is the gate any future prompt-reinjector
//! must call; this module runs it best-effort to warn on injection-shaped
//! output, but never lets the content reach prompt construction.

use std::sync::Arc;

use mcp_runtime::{redact, validate_reinjection, ErrorCategory, ToolOutput};
use provider_core::schema::{
    ConnectorRuntimeEvent, ConsentDecision, ToolCallRecord, ToolCallStatus,
};
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::db::repository::{connectors as conn_repo, tool_calls};
use crate::state::AppState;
use crate::time::now_iso8601;

use super::consent::ConsentRequirement;
use super::ConnectorRuntimeManager;

/// Inline-default per-call output size cap. Oversized output → `Failed`.
pub const MAX_OUTPUT_BYTES: u64 = 1024 * 1024;

/// Sink for runtime events streamed to the renderer over the per-request
/// `Channel<ConnectorRuntimeEvent>`. The M4.6 IPC command supplies a closure
/// that forwards into the Tauri channel; tests supply one that records events.
pub type EventSink = Arc<dyn Fn(ConnectorRuntimeEvent) + Send + Sync>;

/// The final state of an executed tool call.
#[derive(Debug)]
pub struct ExecutionOutcome {
    pub record: ToolCallRecord,
    /// The raw (un-redacted) tool output on success. `None` for cancelled /
    /// failed calls. Never persisted in this form — the persisted row is redacted.
    pub output: Option<ToolOutput>,
}

/// Orchestrate one MCP tool call end-to-end. See the module docs for the
/// ordered trust-boundary steps. Errors are returned as human-readable strings
/// for the IPC layer; the persisted record + emitted event reflect the
/// terminal status regardless.
pub async fn execute_tool_call(
    state: &AppState,
    mgr: &ConnectorRuntimeManager,
    connector_version_id: &str,
    tool_call_id: &str,
    request_id: &str,
    tool_name: &str,
    arguments: &serde_json::Value,
    sink: &EventSink,
) -> Result<ExecutionOutcome, String> {
    // 1. Resolve capability — refuse tools the runtime never discovered
    //    (allowlist-filtered or absent).
    let cap = conn_repo::get_capability_by_name(&state.db, connector_version_id, tool_name)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            format!("tool '{tool_name}' is not available on connector {connector_version_id}")
        })?;
    if cap.kind != "tool" {
        return Err(format!(
            "'{}' is not a tool (kind: {})",
            tool_name, cap.kind
        ));
    }

    // 2. Persist the call as Pending.
    let pending = ToolCallRecord {
        id: tool_call_id.to_string(),
        tool_id: tool_name.to_string(),
        request_id: request_id.to_string(),
        status: ToolCallStatus::Pending,
        arguments: Some(arguments.clone()),
        result: None,
        error: None,
        approved_at: None,
        completed_at: None,
    };
    tool_calls::insert_tool_call(&state.db, &pending)
        .await
        .map_err(|e| e.to_string())?;

    // 3. Consent.
    let requirement = mgr
        .request_consent(
            state,
            connector_version_id,
            tool_call_id,
            tool_name,
            arguments,
        )
        .await?;
    let decision = match requirement {
        ConsentRequirement::Auto { .. } => ConsentDecision::Approved,
        ConsentRequirement::Prompt { prompt, decision } => {
            sink(ConnectorRuntimeEvent::ConsentRequested { prompt });
            match decision.await {
                Ok(d) => d,
                // The waiting request was dropped (connector stopped / app
                // exit). Treat as a cancellation, not a denial.
                Err(_) => {
                    return finish_cancelled(
                        state,
                        tool_call_id,
                        "consent request was cancelled",
                        sink,
                    )
                    .await;
                }
            }
        }
    };
    if matches!(decision, ConsentDecision::Denied) {
        return finish_cancelled(state, tool_call_id, "user denied consent", sink).await;
    }

    // Approved → mark Approved then Running.
    tool_calls::update_tool_call_status(&state.db, tool_call_id, ToolCallStatus::Approved, None)
        .await
        .map_err(|e| e.to_string())?;
    tool_calls::update_tool_call_status(&state.db, tool_call_id, ToolCallStatus::Running, None)
        .await
        .map_err(|e| e.to_string())?;

    // 4. Invoke.
    let cancel = CancellationToken::new();
    let invoked = mgr
        .invoke_tool(connector_version_id, tool_name, arguments, &cancel)
        .await;

    match invoked {
        Ok(output) => {
            // 5. Size cap.
            if output.size_bytes > MAX_OUTPUT_BYTES {
                let msg = format!(
                    "tool output exceeded the {} byte limit (got {})",
                    MAX_OUTPUT_BYTES, output.size_bytes
                );
                return finish_failed(state, tool_call_id, &msg, sink).await;
            }

            // 6. Redact for persistence/display.
            let raw_value = serde_json::to_value(&output).unwrap_or_default();
            let redacted = redact::redact_value(&raw_value);

            // Best-effort injection-shape warning. Never blocks; the content is
            // still persisted as untrusted data and never reaches prompts here.
            if let Err(risk) = validate_reinjection(&redacted) {
                warn!(
                    target: "mcp_connector",
                    %tool_call_id, reason = risk.reason(),
                    "tool output matched an injection-shape marker; stored as untrusted data"
                );
            }

            // 7. Persist the completed record + a tool_results row.
            let completed = ToolCallRecord {
                id: tool_call_id.to_string(),
                tool_id: tool_name.to_string(),
                request_id: request_id.to_string(),
                status: ToolCallStatus::Completed,
                arguments: Some(arguments.clone()),
                result: Some(redacted.clone()),
                error: None,
                approved_at: None,
                completed_at: Some(now_iso8601()),
            };
            tool_calls::insert_tool_call(&state.db, &completed)
                .await
                .map_err(|e| e.to_string())?;
            tool_calls::insert_tool_result(
                &state.db,
                &state.encryption,
                tool_call_id,
                &redacted,
                output.is_error,
            )
            .await
            .map_err(|e| e.to_string())?;

            sink(ConnectorRuntimeEvent::ToolCallFinished {
                tool_call_id: tool_call_id.to_string(),
                status: ToolCallStatus::Completed,
                is_error: Some(output.is_error),
                size_bytes: output.size_bytes,
                mime_hints: output.mime_hints.clone(),
                error: None,
            });

            Ok(ExecutionOutcome {
                record: completed,
                output: Some(output),
            })
        }
        Err(err) => {
            let status = match err.category {
                ErrorCategory::Cancelled => ToolCallStatus::Cancelled,
                _ => ToolCallStatus::Failed,
            };
            let is_cancel = matches!(status, ToolCallStatus::Cancelled);
            let _ = tool_calls::update_tool_call_status(
                &state.db,
                tool_call_id,
                status,
                Some(&err.message),
            )
            .await;
            sink(ConnectorRuntimeEvent::ToolCallFinished {
                tool_call_id: tool_call_id.to_string(),
                status,
                is_error: Some(!is_cancel),
                size_bytes: 0,
                mime_hints: Vec::new(),
                error: Some(err.message.clone()),
            });
            Err(err.message)
        }
    }
}

/// Record a cancellation (denied / dropped consent) and emit the terminal event.
async fn finish_cancelled(
    state: &AppState,
    tool_call_id: &str,
    reason: &str,
    sink: &EventSink,
) -> Result<ExecutionOutcome, String> {
    tool_calls::update_tool_call_status(
        &state.db,
        tool_call_id,
        ToolCallStatus::Cancelled,
        Some(reason),
    )
    .await
    .map_err(|e| e.to_string())?;
    sink(ConnectorRuntimeEvent::ToolCallFinished {
        tool_call_id: tool_call_id.to_string(),
        status: ToolCallStatus::Cancelled,
        is_error: Some(false),
        size_bytes: 0,
        mime_hints: Vec::new(),
        error: Some(reason.to_string()),
    });
    Ok(ExecutionOutcome {
        record: ToolCallRecord {
            id: tool_call_id.to_string(),
            tool_id: String::new(),
            request_id: String::new(),
            status: ToolCallStatus::Cancelled,
            arguments: None,
            result: None,
            error: Some(reason.to_string()),
            approved_at: None,
            completed_at: Some(now_iso8601()),
        },
        output: None,
    })
}

/// Record a failure (oversized output) and emit the terminal event.
async fn finish_failed(
    state: &AppState,
    tool_call_id: &str,
    reason: &str,
    sink: &EventSink,
) -> Result<ExecutionOutcome, String> {
    tool_calls::update_tool_call_status(
        &state.db,
        tool_call_id,
        ToolCallStatus::Failed,
        Some(reason),
    )
    .await
    .map_err(|e| e.to_string())?;
    sink(ConnectorRuntimeEvent::ToolCallFinished {
        tool_call_id: tool_call_id.to_string(),
        status: ToolCallStatus::Failed,
        is_error: Some(true),
        size_bytes: 0,
        mime_hints: Vec::new(),
        error: Some(reason.to_string()),
    });
    Err(reason.to_string())
}
