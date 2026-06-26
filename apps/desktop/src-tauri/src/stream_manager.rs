use crate::{
    credentials::CredentialStore,
    db::repository::{conversations, event_log, messages},
    state::AppState,
};
use futures::StreamExt;
use provider_core::{
    schema::{ProviderEvent, ProviderRequest},
    AdapterContext, ModelInfo,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;
use tracing::{info, warn};

/// Outcome of a single provider streaming round.
/// Used by the agent loop to decide whether to execute tools and continue.
#[derive(Debug, Clone, Default)]
pub struct RoundOutcome {
    /// Tool calls that completed during this round (correlated from Start + Complete events).
    pub completed_tool_calls: Vec<CompletedToolCall>,
    /// True if the round ended with `MessageComplete` (not an error).
    pub finished_normally: bool,
    /// Error message if the round ended due to a provider error.
    pub error_message: Option<String>,
}

/// A tool call that was requested by the provider and is ready for execution.
#[derive(Debug, Clone)]
pub struct CompletedToolCall {
    pub tool_call_id: String,
    /// Optional tool identifier from the provider (used for routing in some flows).
    pub tool_id: Option<String>,
    /// Tool name as declared in the provider's tool catalog.
    pub name: String,
    /// Arguments object for the tool invocation.
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamHandle {
    pub request_id: String,
}

pub(crate) struct ActiveStream {
    pub(crate) cancel: CancellationToken,
}

pub struct StreamManager {
    active: Arc<Mutex<HashMap<String, ActiveStream>>>,
}

impl StreamManager {
    pub fn new() -> Self {
        Self {
            active: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn build_adapter_context(
        state: &AppState,
        provider_id: &str,
    ) -> Result<AdapterContext, String> {
        let settings = state.settings()?;
        let store = CredentialStore::new("conduit");

        let api_key = if provider_id == "ollama" {
            None
        } else if store.has_provider_secret(provider_id) {
            Some(store.get_secret(provider_id)?)
        } else if provider_id == "openai_compat" {
            None
        } else {
            return Err(format!("No credential stored for provider {provider_id}"));
        };

        let base_url = settings
            .provider_endpoints
            .get(provider_id)
            .and_then(|cfg| cfg.base_url.clone());

        Ok(AdapterContext {
            api_key,
            base_url,
            http: state.http.clone(),
        })
    }

    pub async fn validate_credentials(state: &AppState, provider_id: &str) -> Result<(), String> {
        let adapter = provider_core::get_adapter(provider_id)
            .ok_or_else(|| format!("Unknown provider: {provider_id}"))?;
        let ctx = Self::build_adapter_context(state, provider_id)?;
        adapter
            .validate_credentials(&ctx)
            .await
            .map_err(|e| e.message)
    }

    pub async fn list_models(
        state: &AppState,
        provider_id: &str,
    ) -> Result<Vec<ModelInfo>, String> {
        let adapter = provider_core::get_adapter(provider_id)
            .ok_or_else(|| format!("Unknown provider: {provider_id}"))?;
        let ctx = Self::build_adapter_context(state, provider_id)?;
        let models = adapter.list_models(&ctx).await.map_err(|e| e.message)?;
        Ok(models)
    }

    pub async fn start_chat_stream(
        &self,
        state: &AppState,
        request: ProviderRequest,
        channel: Channel<ProviderEvent>,
    ) -> Result<StreamHandle, String> {
        let settings = state.settings()?;
        let provider_id = settings.active_provider.clone();
        let conversation_id = request.conversation_id.clone();
        let request_id = if request.request_id.trim().is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            request.request_id.clone()
        };

        let adapter = provider_core::get_adapter(&provider_id)
            .ok_or_else(|| format!("Unknown provider: {provider_id}"))?;

        // M4: honor `local_only` — block cloud providers when the user has opted
        // into local-only mode. Local-served adapters (ollama, openai_compat)
        // report `is_local()` and are always allowed.
        if settings.local_only && !adapter.is_local() {
            return Err(format!(
                "Cloud provider '{provider_id}' is disabled while local_only mode is on"
            ));
        }

        // Phase A: if the request declares tools, run the agent turn loop which
        // can execute multiple provider rounds. Otherwise fall through to the
        // classic single-round path.
        if !request.tool_definitions.is_empty() {
            // Note: the public command must pass the runtime manager; see commands.rs.
            // For the internal call we expect the caller to have provided it via an
            // overload or a separate method. For now, return an error indicating the
            // runtime manager is required for tool-using turns.
            return Err(
                "Tool-using turns require ConnectorRuntimeManager; wire via command layer."
                    .to_string(),
            );
        }

        let cancel = self.register_stream(&request_id)?;

        // Phase 3 cut-over: the stream persists through the SQLite event log +
        // materialized view. Ensure the conversation row exists (the request may
        // reference a not-yet-persisted id), persist the request's user/system/
        // developer messages so the conversation reloads fully, and bump the
        // conversation's updated_at so it surfaces newest-first in the rail.
        let pool = state.db.clone();
        conversations::ensure_exists(&pool, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;
        messages::persist_request_messages(&pool, &request.messages)
            .await
            .map_err(|e| e.to_string())?;
        conversations::touch(&pool, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;

        let mut provider_request = request;
        provider_request.request_id = request_id.clone();

        // Delegate to the reusable round runner. For the single-round public API
        // we surface any setup or round-level error as before.
        let outcome = self
            .run_provider_round(state, provider_request, channel, cancel)
            .await;

        if let Some(err) = outcome.error_message {
            return Err(err);
        }

        Ok(StreamHandle { request_id })
    }

    pub async fn cancel_stream(
        &self,
        state: &AppState,
        request_id: &str,
        _conversation_id: Option<&str>,
    ) -> Result<bool, String> {
        let cancelled = {
            let guard = self
                .active
                .lock()
                .map_err(|_| "Stream lock poisoned".to_string())?;
            if let Some(active) = guard.get(request_id) {
                active.cancel.cancel();
                true
            } else {
                false
            }
        };

        if cancelled {
            // Phase 3 cut-over: mark the assistant turn interrupted in the
            // materialized view. The `request_id` identifies the turn; the
            // conversation_id is no longer needed (kept in the signature for IPC
            // stability).
            let pool = state.db.clone();
            let _ = messages::mark_interrupted_by_request(&pool, request_id).await;
        }

        Ok(cancelled)
    }

    /// Registers a new active stream and returns the `CancellationToken` that
    /// drives it. Callers poll `is_cancelled()` (cooperative) or `cancel()` it.
    /// M1: the single cancellation authority — both real and mock streams
    /// register here.
    pub fn register_stream(&self, request_id: &str) -> Result<CancellationToken, String> {
        let cancel = CancellationToken::new();
        self.active
            .lock()
            .map_err(|_| "Stream lock poisoned".to_string())?
            .insert(
                request_id.to_string(),
                ActiveStream {
                    cancel: cancel.clone(),
                },
            );
        Ok(cancel)
    }

    /// Handle to the active-stream map, for spawned tasks that need to remove
    /// their own entry on completion (mirrors the chat-stream cleanup path).
    pub(crate) fn active_handle(&self) -> Arc<Mutex<HashMap<String, ActiveStream>>> {
        self.active.clone()
    }

    /// Run a single provider streaming round.
    ///
    /// This encapsulates the core streaming + persistence loop so it can be
    /// reused by the agent loop for multi-turn tool-using conversations.
    /// The caller is responsible for ensuring the conversation and request
    /// messages are already persisted (those steps happen once per user turn).
    ///
    /// Returns a `RoundOutcome` describing tool calls requested during the round
    /// and whether the round completed normally.
    pub async fn run_provider_round(
        &self,
        state: &AppState,
        request: ProviderRequest,
        channel: Channel<ProviderEvent>,
        cancel: CancellationToken,
    ) -> RoundOutcome {
        let settings = match state.settings() {
            Ok(s) => s,
            Err(e) => {
                return RoundOutcome {
                    error_message: Some(format!("settings error: {e}")),
                    ..Default::default()
                };
            }
        };
        let provider_id = settings.active_provider.clone();

        let adapter = match provider_core::get_adapter(&provider_id) {
            Some(a) => a,
            None => {
                return RoundOutcome {
                    error_message: Some(format!("Unknown provider: {provider_id}")),
                    ..Default::default()
                };
            }
        };

        let ctx = match Self::build_adapter_context(state, &provider_id) {
            Ok(c) => c,
            Err(e) => {
                return RoundOutcome {
                    error_message: Some(e),
                    ..Default::default()
                };
            }
        };

        // Ensure request carries the canonical request_id
        let request_id = request.request_id.clone();
        let conversation_id = request.conversation_id.clone();
        let pool = state.db.clone();

        let stream = match adapter.stream_chat(request, ctx, cancel.clone()).await {
            Ok(s) => s,
            Err(e) => {
                warn!(
                    provider = %provider_id,
                    request_id = %request_id,
                    error = %e.message,
                    "provider stream_chat failed in run_provider_round"
                );
                return RoundOutcome {
                    error_message: Some(e.message),
                    ..Default::default()
                };
            }
        };

        info!(provider = %provider_id, request_id = %request_id, "provider round started");

        // Track tool call correlation: tool_call_id -> (tool_id, name) from Start events
        let mut tool_start_info: HashMap<String, (Option<String>, String)> = HashMap::new();
        let mut completed_tool_calls: Vec<CompletedToolCall> = Vec::new();
        let mut finished_normally = false;
        let mut error_message: Option<String> = None;

        futures::pin_mut!(stream);
        while let Some(event) = stream.next().await {
            if let ProviderEvent::Error { error, .. } = &event {
                warn!(
                    request_id = %request_id,
                    provider = %provider_id,
                    error = %error.message,
                    "provider stream error during round"
                );
                error_message = Some(error.message.clone());
            }

            // Correlate tool start/complete for round outcome
            match &event {
                ProviderEvent::ToolCallStart {
                    tool_call_id,
                    tool_id,
                    name,
                    ..
                } => {
                    tool_start_info.insert(
                        tool_call_id.clone(),
                        (Some(tool_id.clone()), name.clone()),
                    );
                }
                ProviderEvent::ToolCallComplete {
                    tool_call_id,
                    arguments,
                    ..
                } => {
                    let (tool_id, name) = tool_start_info
                        .get(tool_call_id)
                        .cloned()
                        .unwrap_or((None, String::new()));
                    completed_tool_calls.push(CompletedToolCall {
                        tool_call_id: tool_call_id.clone(),
                        tool_id,
                        name,
                        arguments: arguments.clone(),
                    });
                }
                _ => {}
            }

            // Persist + forward
            let _ = event_log::append_and_apply(
                &pool,
                &conversation_id,
                &request_id,
                &event,
            )
            .await;

            if channel.send(event.clone()).is_err() {
                cancel.cancel();
                let _ = messages::mark_interrupted_by_request(&pool, &request_id).await;
                break;
            }

            if matches!(event, ProviderEvent::MessageComplete { .. }) {
                finished_normally = true;
                let _ = conversations::touch(&pool, &conversation_id).await;
                break;
            }

            if matches!(event, ProviderEvent::Error { .. }) {
                let _ = conversations::touch(&pool, &conversation_id).await;
                break;
            }
        }

        // Cleanup active stream entry (registered by caller via register_stream)
        let _ = self
            .active
            .lock()
            .map(|mut guard| guard.remove(&request_id));

        RoundOutcome {
            completed_tool_calls,
            finished_normally,
            error_message,
        }
    }

    /// Execute a batch of tool calls resolved from a provider round.
    /// This is the direct in-process invocation of the Phase 4 execution pipeline
    /// from the agent loop, preserving consent, redaction, and persistence.
    pub async fn execute_resolved_tool_calls(
        &self,
        _state: &AppState,
        _runtime: &crate::connector_runtime::ConnectorRuntimeManager,
        calls: &[CompletedToolCall],
        request_id: &str,
        _conversation_id: &str,
    ) {
        use tracing::info;

        for call in calls {
            // NOTE: Binding resolution (connector_version_id, tool_name) must be
            // provided by the catalog layer. Here we assume the CompletedToolCall
            // carries enough info or that a higher layer has already mapped it.
            // For the immediate compile-and-call demonstration we skip execution
            // unless a binding can be derived.
            info!(
                request_id = %request_id,
                tool_call_id = %call.tool_call_id,
                tool_name = %call.name,
                "agent loop would invoke execute_tool_call for resolved binding"
            );
            // Placeholder: real call would construct a ToolCallRequest and await
            // execution::execute_tool_call(state, runtime, &req, &sink).await;
        }
    }

    /// Build a continuation `ProviderRequest` for the next provider round.
    /// This is the single guarded path that may inject tool output (after
    /// `validate_reinjection`) into a follow-up prompt.
    pub async fn build_continuation_request(
        &self,
        state: &AppState,
        previous_request: &ProviderRequest,
        _completed_calls: &[CompletedToolCall],
    ) -> Result<ProviderRequest, String> {
        // MVP: return a clone. Full implementation loads redacted results from
        // `tool_calls` repo, calls `mcp_runtime::validate_reinjection`, and
        // appends assistant/tool message parts using `MessagePartKind::ToolResult`.
        let _ = state;
        Ok(previous_request.clone())
    }

    /// Run a multi-round agent turn when the request includes tool definitions.
    /// Enforces guardrails (max_steps, wall-clock budget) and coordinates rounds
    /// until no further tool calls are requested or a terminal condition occurs.
    ///
    /// For Phase A MVP, when tool calls are detected the loop currently stops
    /// after the first round that requests tools, because tool execution and
    /// continuation building are implemented in subsequent steps. The skeleton
    /// establishes the control flow and guardrails.
    pub async fn run_agent_turn(
        &self,
        state: &AppState,
        _runtime: &crate::connector_runtime::ConnectorRuntimeManager,
        initial_request: ProviderRequest,
        channel: Channel<ProviderEvent>,
    ) -> Result<StreamHandle, String> {
        let request_id = if initial_request.request_id.trim().is_empty() {
            uuid::Uuid::new_v4().to_string()
        } else {
            initial_request.request_id.clone()
        };
        let conversation_id = initial_request.conversation_id.clone();

        // Ensure conversation and persist the initial user/system/developer messages
        // exactly once for the whole turn (mirrors the single-round path).
        let pool = state.db.clone();
        conversations::ensure_exists(&pool, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;
        messages::persist_request_messages(&pool, &initial_request.messages)
            .await
            .map_err(|e| e.to_string())?;
        conversations::touch(&pool, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;

        let cancel = self.register_stream(&request_id)?;

        const MAX_STEPS: usize = 10;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(120);

        let mut current_request = initial_request;
        current_request.request_id = request_id.clone();

        for step in 0..MAX_STEPS {
            if cancel.is_cancelled() {
                break;
            }
            if tokio::time::Instant::now() > deadline {
                // Surface a terminal error to the UI via the channel and stop.
                let _ = channel.send(ProviderEvent::Error {
                    request_id: request_id.clone(),
                    error: provider_core::schema::ProviderError {
                        provider_code: None,
                        message: "Agent turn exceeded wall-clock budget".to_string(),
                        retryable: false,
                    },
                });
                break;
            }

            let outcome = self
                .run_provider_round(state, current_request.clone(), channel.clone(), cancel.clone())
                .await;

            if let Some(err) = outcome.error_message {
                // Error already forwarded by the round; stop the turn.
                warn!(request_id = %request_id, step, error = %err, "agent turn aborted due to round error");
                break;
            }

            if outcome.completed_tool_calls.is_empty() {
                // No tool calls requested; the assistant produced a final answer.
                break;
            }

            // Phase A MVP: tool execution and continuation building are not yet wired.
            // For now, stop after detecting the first set of tool calls. The UI will
            // still render the assistant's partial content and tool call stubs.
            // Later steps will replace this early return with actual execution + loop.
            info!(
                request_id = %request_id,
                step,
                tool_call_count = outcome.completed_tool_calls.len(),
                "agent turn detected tool calls; stopping for Phase A scaffolding"
            );
            break;
        }

        // Ensure the active entry is cleared (run_provider_round cleans per-round,
        // but guard against early exits). Safe to attempt removal.
        let _ = self.active.lock().map(|mut g| g.remove(&request_id));

        Ok(StreamHandle { request_id })
    }
}

impl Default for StreamManager {
    fn default() -> Self {
        Self::new()
    }
}
