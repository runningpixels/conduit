use crate::{
    agent_tools,
    credentials::CredentialStore,
    db::repository::{connectors, conversations, event_log, messages, tool_calls},
    state::AppState,
};
use futures::StreamExt;
use mcp_runtime::validate_reinjection;
use provider_core::{
    schema::{
        ConnectorRuntimeEvent, Message, MessagePart, MessagePartKind, MessageRole, ProviderEvent,
        ProviderRequest, ToolCallStatus,
    },
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
use uuid::Uuid;

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
        state: &AppState,
        runtime: &crate::connector_runtime::ConnectorRuntimeManager,
        calls: &[CompletedToolCall],
        request_id: &str,
        conversation_id: &str,
        runtime_channel: Option<&Channel<ConnectorRuntimeEvent>>,
    ) {
        let catalog = match build_connector_tool_catalog(state).await {
            Ok(c) => c,
            Err(err) => {
                warn!(request_id = %request_id, error = %err, "failed to build connector tool catalog");
                crate::connector_runtime::catalog::ConnectorToolCatalog::default()
            }
        };
        let source_message_id = messages::get_message_id_by_request(&state.db, request_id)
            .await
            .unwrap_or(None);
        let ctx = agent_tools::AgentToolContext {
            db: &state.db,
            artifacts_dir: &state.paths.artifacts,
            exports_dir: &state.paths.exports,
            encryption: &state.encryption,
            conversation_id,
            source_message_id,
        };
        let sink = runtime_channel.map(|channel| {
            let channel = channel.clone();
            std::sync::Arc::new(move |event| {
                let _ = channel.send(event);
            }) as crate::connector_runtime::execution::EventSink
        });

        for call in calls {
            let tool_name = if call.name.trim().is_empty() {
                call.tool_id.clone().unwrap_or_default()
            } else {
                call.name.clone()
            };

            if agent_tools::is_builtin_tool_name(&tool_name) {
                let outcome = agent_tools::execute_builtin_tool(
                    &ctx,
                    &call.tool_call_id,
                    request_id,
                    &tool_name,
                    &call.arguments,
                )
                .await;
                if let Some(channel) = runtime_channel {
                    match outcome {
                        Ok(exec) => {
                            let size = serde_json::to_vec(&exec.output)
                                .map(|bytes| bytes.len() as u64)
                                .unwrap_or(0);
                            let _ = channel.send(ConnectorRuntimeEvent::ToolCallFinished {
                                tool_call_id: exec.record.id.clone(),
                                status: exec.record.status,
                                is_error: Some(exec.is_error),
                                size_bytes: size,
                                mime_hints: Vec::new(),
                                error: exec.record.error.clone(),
                            });
                        }
                        Err(error) => {
                            let _ = channel.send(ConnectorRuntimeEvent::ToolCallFinished {
                                tool_call_id: call.tool_call_id.clone(),
                                status: provider_core::schema::ToolCallStatus::Failed,
                                is_error: Some(true),
                                size_bytes: 0,
                                mime_hints: Vec::new(),
                                error: Some(error),
                            });
                        }
                    }
                }
                continue;
            }

            let Some(binding) = catalog.bindings.get(&tool_name) else {
                warn!(
                    request_id = %request_id,
                    tool_call_id = %call.tool_call_id,
                    tool_name = %tool_name,
                    "no tool binding found for provider tool"
                );
                continue;
            };
            let req = crate::connector_runtime::execution::ToolCallRequest {
                connector_version_id: &binding.connector_version_id,
                tool_call_id: &call.tool_call_id,
                request_id,
                tool_name: &binding.tool_name,
                arguments: &call.arguments,
            };
            let sink = sink
                .clone()
                .unwrap_or_else(|| std::sync::Arc::new(|_| {}) as _);
            let _ = crate::connector_runtime::execution::execute_tool_call(state, runtime, &req, &sink)
                .await;
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
        let pool = &state.db;

        // 1. Load all tool calls for this round's request_id.
        let records = tool_calls::list_tool_calls_by_request(pool, &previous_request.request_id)
            .await
            .map_err(|e| format!("failed to list tool calls: {e}"))?;

        // 2–3. For each tool call, load redacted result, validate reinjection.
        let mut tool_result_parts: Vec<MessagePart> = Vec::new();
        let mut tool_call_meta: Vec<serde_json::Value> = Vec::new();

        for record in &records {
            tool_call_meta.push(serde_json::json!({
                "tool_call_id": record.id,
                "name": record.tool_id,
                "arguments": record.arguments,
            }));

            let result_content = match record.status {
                ToolCallStatus::Completed => {
                    match tool_calls::latest_tool_result(pool, &state.encryption, &record.id)
                        .await
                    {
                        Ok(Some((value, _is_error))) => {
                            let raw = value.to_string();
                            match validate_reinjection(&value) {
                                Ok(()) => raw,
                                Err(risk) => {
                                    warn!(
                                        tool_call_id = %record.id,
                                        risk = %risk.reason(),
                                        "tool output failed reinjection validation"
                                    );
                                    "Tool output blocked: content resembles a prompt injection attempt.".to_string()
                                }
                            }
                        }
                        _ => "Tool executed but no output was recorded.".to_string(),
                    }
                }
                ToolCallStatus::Failed => {
                    record.error.clone().unwrap_or_else(|| "Tool call failed.".to_string())
                }
                ToolCallStatus::Cancelled => "Tool call was cancelled by the user.".to_string(),
                _ => "Tool call did not complete.".to_string(),
            };

            tool_result_parts.push(MessagePart {
                id: format!("{}/tr-{}", previous_request.request_id, record.id),
                message_id: String::new(),
                index: tool_result_parts.len() as u32,
                kind: MessagePartKind::ToolResult,
                content: Some(result_content),
                mime_type: None,
                tool_call_id: Some(record.id.clone()),
                artifact_id: None,
                attachment_id: None,
                blob_ref: None,
                metadata: None,
                created_at: crate::time::now_iso8601(),
            });
        }

        // 4. Build assistant message parts for the continuation request.
        // Note: the assistant message is already persisted by the event fold
        // in run_provider_round(). We build an in-memory version enriched with
        // tool-call metadata for the adapters to serialize correctly.
        let turn_now = crate::time::now_iso8601();
        let mut assistant_parts: Vec<MessagePart> = Vec::new();

        // Load text from the event-folded assistant message
        if let Ok(Some(snapshot)) =
            messages::snapshot_view_for_request(pool, &previous_request.request_id).await
        {
            for part in &snapshot.parts {
                if matches!(part.kind, MessagePartKind::Text | MessagePartKind::Reasoning) {
                    if let Some(ref content) = part.content {
                        if !content.is_empty() {
                            assistant_parts.push(MessagePart {
                                id: part.id.clone(),
                                message_id: String::new(),
                                index: assistant_parts.len() as u32,
                                kind: MessagePartKind::Text,
                                content: Some(content.clone()),
                                mime_type: None, tool_call_id: None,
                                artifact_id: None, attachment_id: None,
                                blob_ref: None, metadata: None,
                                created_at: turn_now.clone(),
                            });
                        }
                    }
                }
            }
        }

        // Add tool-call metadata part (adapters inspect metadata.tool_calls)
        if !tool_call_meta.is_empty() {
            let idx = assistant_parts.len() as u32;
            assistant_parts.push(MessagePart {
                id: format!("{}/tc-meta-{}", previous_request.request_id, Uuid::new_v4()),
                message_id: String::new(), index: idx,
                kind: MessagePartKind::Text, content: None,
                mime_type: None, tool_call_id: None, artifact_id: None,
                attachment_id: None, blob_ref: None,
                metadata: Some(serde_json::json!({ "tool_calls": tool_call_meta })),
                created_at: turn_now.clone(),
            });
        }

        // 5–6. Persist the tool message for transcript reload.
        // (The assistant message is already persisted by the event fold.)
        let tool_msg_id = Uuid::new_v4().to_string();

        if !tool_result_parts.is_empty() {
            let msg = Message {
                id: tool_msg_id.clone(),
                conversation_id: previous_request.conversation_id.clone(),
                role: MessageRole::Tool,
                author_label: None, provider_message_id: None,
                interrupted_at: None, metadata: None,
                parts: tool_result_parts.iter().enumerate().map(|(i, p)| {
                    let mut part = p.clone();
                    part.message_id = tool_msg_id.clone();
                    part.index = i as u32;
                    part
                }).collect(),
                created_at: turn_now.clone(),
            };
            let _ = messages::insert_message(pool, &msg).await;
        }

        // 7. Build the continuation ProviderRequest with fresh request_id.
        let assistant_msg_id = format!("{}/assistant", previous_request.request_id);
        let mut continuation_messages = previous_request.messages.clone();

        if !assistant_parts.is_empty() {
            continuation_messages.push(Message {
                id: assistant_msg_id,
                conversation_id: previous_request.conversation_id.clone(),
                role: MessageRole::Assistant,
                author_label: None, provider_message_id: None,
                interrupted_at: None, metadata: None,
                parts: assistant_parts.into_iter().enumerate().map(|(i, mut p)| {
                    p.index = i as u32; p
                }).collect(),
                created_at: turn_now.clone(),
            });
        }

        if !tool_result_parts.is_empty() {
            continuation_messages.push(Message {
                id: tool_msg_id,
                conversation_id: previous_request.conversation_id.clone(),
                role: MessageRole::Tool,
                author_label: None, provider_message_id: None,
                interrupted_at: None, metadata: None,
                parts: tool_result_parts.into_iter().enumerate().map(|(i, mut p)| {
                    p.index = i as u32; p
                }).collect(),
                created_at: turn_now,
            });
        }

        Ok(ProviderRequest {
            request_id: Uuid::new_v4().to_string(),
            conversation_id: previous_request.conversation_id.clone(),
            model_id: previous_request.model_id.clone(),
            messages: continuation_messages,
            system_prompt: previous_request.system_prompt.clone(),
            developer_prompt: previous_request.developer_prompt.clone(),
            attachments: previous_request.attachments.clone(),
            tool_definitions: previous_request.tool_definitions.clone(),
            generation_controls: previous_request.generation_controls.clone(),
            response_format: previous_request.response_format.clone(),
        })
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
        runtime: &crate::connector_runtime::ConnectorRuntimeManager,
        initial_request: ProviderRequest,
        channel: Channel<ProviderEvent>,
        runtime_channel: Channel<ConnectorRuntimeEvent>,
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

            self.execute_resolved_tool_calls(
                state,
                runtime,
                &outcome.completed_tool_calls,
                &request_id,
                &conversation_id,
                Some(&runtime_channel),
            )
            .await;

            info!(
                request_id = %request_id,
                step,
                tool_call_count = outcome.completed_tool_calls.len(),
                "agent turn executed tool calls; building continuation request"
            );

            // Build a continuation request and loop for the next round.
            match self
                .build_continuation_request(
                    state,
                    &current_request,
                    &outcome.completed_tool_calls,
                )
                .await
            {
                Ok(continuation) => {
                    current_request = continuation;
                    // Continue to next iteration of the loop
                }
                Err(e) => {
                    warn!(
                        request_id = %request_id,
                        step,
                        error = %e,
                        "failed to build continuation request; ending agent turn"
                    );
                    break;
                }
            }
        }

        // Ensure the active entry is cleared (run_provider_round cleans per-round,
        // but guard against early exits). Safe to attempt removal.
        let _ = self.active.lock().map(|mut g| g.remove(&request_id));

        Ok(StreamHandle { request_id })
    }
}

async fn build_connector_tool_catalog(
    state: &AppState,
) -> Result<crate::connector_runtime::catalog::ConnectorToolCatalog, String> {
    use crate::connector_runtime::catalog::{build_connector_tool_catalog, ConnectorToolSnapshot};
    use std::collections::HashMap;

    let pool = &state.db;
    let defs = connectors::list_definitions(pool)
        .await
        .map_err(|e| e.to_string())?;
    let grants = connectors::list_grants(pool, None)
        .await
        .map_err(|e| e.to_string())?;
    let mut grant_by_version: HashMap<String, String> = HashMap::new();
    for grant in grants {
        match grant_by_version.get(&grant.connector_version_id) {
            Some(existing) if existing == "active" => {}
            _ => {
                grant_by_version.insert(grant.connector_version_id.clone(), grant.status.clone());
            }
        }
    }

    let mut snapshots = Vec::new();
    let mut capabilities_by_version = HashMap::new();
    for def in defs {
        let versions = connectors::list_versions(pool, &def.id)
            .await
            .map_err(|e| e.to_string())?;
        for version in versions {
            let caps = connectors::list_capabilities(pool, &version.id)
                .await
                .map_err(|e| e.to_string())?;
            capabilities_by_version.insert(version.id.clone(), caps);
            snapshots.push(ConnectorToolSnapshot {
                connector_version_id: version.id.clone(),
                connector_id: def.id.clone(),
                connector_name: def.name.clone(),
                grant_status: grant_by_version.get(&version.id).cloned(),
                support_state: version.support_state.clone(),
            });
        }
    }

    Ok(build_connector_tool_catalog(&snapshots, &capabilities_by_version))
}

impl Default for StreamManager {
    fn default() -> Self {
        Self::new()
    }
}
