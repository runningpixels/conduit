use crate::{
    agent_tools,
    db::repository::{connectors, conversations, event_log, messages, tool_calls, usage_summary},
    state::AppState,
};
use futures::StreamExt;
use mcp_runtime::validate_reinjection;
use provider_core::{
    schema::{
        ConnectorRuntimeEvent, Message, MessagePart, MessagePartKind, MessageRole, ProviderEvent,
        ProviderRequest, ToolCallRecord, ToolCallStatus,
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

/// Who is responsible for telling the UI that the turn is over.
///
/// The renderer treats `MessageComplete` as end-of-turn: it settles the stream
/// and discards every event that arrives afterwards. A multi-round agent turn
/// emits one `MessageComplete` per round, so forwarding the first one made the
/// UI drop everything the model produced after its first tool call — the final
/// answer was generated and persisted, but never displayed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompletionDelivery {
    /// Single-round path: the round forwards `MessageComplete` itself.
    Immediate,
    /// Agent loop: the round withholds `MessageComplete` and hands it back in
    /// [`RoundOutcome::completion_event`], so the loop can emit exactly one
    /// terminal event once every round is done.
    Deferred,
}

/// Persistence identity for one provider round.
///
/// Continuation HTTP requests mint a fresh `ProviderRequest.request_id`. Folding
/// under that id would split one user send into multiple assistant bubbles, so
/// the agent loop always passes the canonical turn id here.
pub struct ProviderRoundBind<'a> {
    /// Event log + assistant message row for this user turn.
    pub persist_request_id: &'a str,
    /// Remove this round from the active-stream map when it ends.
    /// Single-round callers pass true. The agent loop registers once under the
    /// canonical id and cleans up after the last round, so it passes false.
    pub release_active: bool,
}

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
    /// Whether the round already sent a terminal `ProviderEvent::Error` on the
    /// channel.
    ///
    /// Only the mid-stream error path does. Every other way a round can fail —
    /// settings unreadable, unknown provider, adapter context (missing key),
    /// and `stream_chat` returning `Err`, which covers every HTTP >= 400 —
    /// returns before touching the channel. Pass L's exit-path table recorded
    /// them all as "the round already forwarded Error"; four of the five do
    /// not, and the loop suppressed the terminal event on that word, leaving
    /// the turn to hang with nothing sent at all. The loop reads this instead
    /// of assuming.
    pub error_forwarded: bool,
    /// Whether the round emitted any assistant text.
    ///
    /// The loop's "no runnable tool calls means the assistant answered" exit is
    /// only true when there *was* an answer. A round can finish normally, emit
    /// `stop`, and produce nothing at all — see
    /// [`round_produced_nothing`] — and without this the turn ends on a blank
    /// bubble that reports no error because, as far as every other signal goes,
    /// nothing went wrong.
    pub produced_text: bool,
    /// Provider usage (tokens, cost) reported for this round, if any.
    pub usage: Option<provider_core::schema::ProviderUsage>,
    /// The round's `MessageComplete`, withheld from the channel under
    /// [`CompletionDelivery::Deferred`]. Always `None` for `Immediate`.
    pub completion_event: Option<ProviderEvent>,
    /// Concatenated assistant text emitted this round. Continuation prompts
    /// use this instead of the full folded snapshot, which would re-inject
    /// earlier rounds after they share one persist identity.
    pub round_text: String,
}

/// Split completed tool calls into the ones this request declared and the ones
/// it did not.
///
/// Tool dispatch is by *name*, against a registry far broader than any single
/// turn's declarations, and nothing downstream re-checks. Two consequences:
///
///   - A provider-hosted tool call arrives as an ordinary `ToolCallComplete`.
///     OpenAI's hosted search reports `web_search`, colliding with the local
///     builtin of the same name — so the loop re-ran a search the provider had
///     already performed, then built a continuation carrying the *hosted*
///     call's id. The Responses API rejects that id, because it never issued a
///     function call for it, and the turn died there.
///   - A model naming any registered builtin would get it executed, whether or
///     not the turn ever offered it.
///
/// Declared tools are the only ones we asked for, so they are the only ones we
/// run. Continuations carry `tool_definitions` forward, so later rounds keep
/// the same set.
pub fn partition_declared_tool_calls(
    calls: Vec<CompletedToolCall>,
    declared: &[provider_core::schema::ToolDefinition],
) -> (Vec<CompletedToolCall>, Vec<CompletedToolCall>) {
    let names: std::collections::HashSet<&str> = declared.iter().map(|t| t.name.as_str()).collect();
    calls
        .into_iter()
        .partition(|call| names.contains(call.name.as_str()))
}

/// Whether a round that ended cleanly nonetheless produced nothing the user can
/// see: no assistant text, and no tool call this turn is allowed to run.
///
/// This is the shape a provider-hosted tool leaves behind. OpenAI's hosted web
/// search is reported as an ordinary `ToolCallComplete` named `web_search` —
/// a *record* that the provider already searched, not a request for us to search
/// — and the renderer never declares the local builtin of that name, so
/// [`partition_declared_tool_calls`] correctly refuses to run it. What is left
/// is a round with two searches, zero text, and an empty runnable list, which
/// the loop's next check reads as "the assistant produced a final answer" and
/// ends the turn on.
///
/// Observed: response ends `stop` after two `ws_…` search items with no message
/// item, and the user gets a search block, no answer, and no error. The failure
/// is worse than a crash because every signal says success.
///
/// `undeclared` is a parameter rather than an implementation detail because a
/// round that produced no text and asked for *nothing at all* is a different
/// (and much rarer) event than one whose entire output we discarded; only the
/// latter is worth explaining in the provider's terms.
pub fn round_produced_nothing(
    produced_text: bool,
    runnable: &[CompletedToolCall],
    undeclared: &[CompletedToolCall],
) -> bool {
    !produced_text && runnable.is_empty() && !undeclared.is_empty()
}

/// The message shown when a turn ends having produced nothing.
///
/// Names the tools whose output was dropped, because "nothing happened" is not
/// actionable and "the provider ran web_search and then returned no answer" is.
pub fn empty_turn_message(undeclared: &[CompletedToolCall]) -> String {
    let mut names: Vec<&str> = undeclared.iter().map(|c| c.name.as_str()).collect();
    names.sort_unstable();
    names.dedup();
    let app_name = crate::brand::app_name();
    format!(
        "The model ran {} and then ended the turn without writing an answer. \
         {app_name} did not run {} — the provider reports it as one of its own hosted tools, \
         so its results stayed on the provider's side and never reached the model's next step. \
         Try turning off web search in Settings, or use a model whose hosted search returns an answer in the same turn.",
        names.join(", "),
        if names.len() == 1 { "it" } else { "them" },
    )
}

/// The terminal event the loop still owes after a round reported an error.
///
/// `None` when the round already forwarded a `ProviderEvent::Error` itself —
/// which only the mid-stream path does. The other four ways a round can fail
/// return before touching the channel, and Pass L's exit-path table recorded
/// all five as "already forwarded". Believing it meant the loop suppressed the
/// only terminal event and the turn ended having said nothing at all, leaving
/// the renderer waiting on a completion that was never coming.
pub fn terminal_event_for_round_error(
    request_id: &str,
    error_message: String,
    error_forwarded: bool,
) -> Option<ProviderEvent> {
    if error_forwarded {
        return None;
    }
    Some(ProviderEvent::Error {
        request_id: request_id.to_string(),
        error: provider_core::schema::ProviderError {
            provider_code: None,
            message: error_message,
            retryable: false,
        },
    })
}

/// Hard cap on successful `write_*_document` creates in a single agent turn.
/// Prevents create+search thrash from spawning dozens of duplicate artifacts
/// before `max_steps` fires.
pub const MAX_DOCUMENT_CREATES_PER_TURN: u32 = 2;

const PARALLEL_CREATE_REJECT: &str =
    "Only one new document per round. Use edit_*_document with the returned artifact_id to revise.";
const TURN_CREATE_CAP_REJECT: &str =
    "This turn already created the maximum number of documents. Use edit_*_document with an existing artifact_id, or stop.";

/// True when the tool name is a builtin `write_*_document` creator.
pub fn is_document_write_tool(name: &str) -> bool {
    name.starts_with("write_") && name.ends_with("_document")
}

/// True when a `write_*` call is asking to create a new document (no usable
/// `artifact_id`). Writes that pass an id are upserts and are not coalesced.
pub fn is_new_document_create(call: &CompletedToolCall) -> bool {
    if !is_document_write_tool(&call.name) {
        return false;
    }
    match call.arguments.get("artifact_id") {
        None => true,
        Some(value) if value.is_null() => true,
        Some(value) => value.as_str().map(|s| s.trim().is_empty()).unwrap_or(true),
    }
}

/// Whether a completed tool output reports a newly created document artifact.
pub fn tool_output_created_document(output: &serde_json::Value) -> bool {
    output
        .get("created")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// Decision for one tool call under document-create clamps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateClampAction {
    Run,
    RejectParallel,
    RejectTurnCap,
}

impl CreateClampAction {
    pub fn reject_message(&self) -> Option<&'static str> {
        match self {
            Self::Run => None,
            Self::RejectParallel => Some(PARALLEL_CREATE_REJECT),
            Self::RejectTurnCap => Some(TURN_CREATE_CAP_REJECT),
        }
    }
}

/// Plan create clamps for a round: at most one new `write_*` create per round,
/// and no creates once [`MAX_DOCUMENT_CREATES_PER_TURN`] successful creates
/// have already landed this turn.
pub fn classify_document_create_clamps(
    calls: &[CompletedToolCall],
    successful_creates_so_far: u32,
) -> Vec<CreateClampAction> {
    let mut actions = Vec::with_capacity(calls.len());
    let mut create_reserved = 0u32;
    for call in calls {
        if !is_new_document_create(call) {
            actions.push(CreateClampAction::Run);
            continue;
        }
        if create_reserved >= 1 {
            actions.push(CreateClampAction::RejectParallel);
            continue;
        }
        if successful_creates_so_far + create_reserved >= MAX_DOCUMENT_CREATES_PER_TURN {
            actions.push(CreateClampAction::RejectTurnCap);
            continue;
        }
        actions.push(CreateClampAction::Run);
        create_reserved += 1;
    }
    actions
}

/// After the first successful document create, later rounds must not offer
/// `write_*` again — only edit/export/utilities (and any connector tools).
pub fn narrow_tools_after_document_create(
    defs: &[provider_core::schema::ToolDefinition],
) -> Vec<provider_core::schema::ToolDefinition> {
    defs.iter()
        .filter(|t| !is_document_write_tool(&t.name))
        .cloned()
        .collect()
}

/// Hard cap on local `web_search` / `web_fetch` calls per agent turn.
/// Empty Instant Answer results otherwise train the model to binge-retry until
/// `max_steps` kills the turn with no answer.
pub const MAX_WEB_SEARCH_PER_TURN: u32 = 3;
pub const MAX_WEB_FETCH_PER_TURN: u32 = 3;

const WEB_SEARCH_CAP_REJECT: &str =
    "This turn already used the maximum number of web_search calls. Answer with the results you have (or say Instant Answer cannot cover this query). Do not call web_search again.";
const WEB_FETCH_CAP_REJECT: &str =
    "This turn already used the maximum number of web_fetch calls. Answer with the content you have. Do not call web_fetch again.";

/// Plan web-tool clamps for a round: at most [`MAX_WEB_SEARCH_PER_TURN`] /
/// [`MAX_WEB_FETCH_PER_TURN`] executions this turn (including prior rounds).
///
/// Returns one optional reject message per call (`None` = run). Non-web tools
/// always run (from this classifier's perspective).
pub fn classify_web_tool_clamps(
    calls: &[CompletedToolCall],
    web_search_so_far: u32,
    web_fetch_so_far: u32,
) -> Vec<Option<&'static str>> {
    let mut out = Vec::with_capacity(calls.len());
    let mut search_reserved = 0u32;
    let mut fetch_reserved = 0u32;
    for call in calls {
        let name = if call.name.trim().is_empty() {
            call.tool_id.as_deref().unwrap_or("")
        } else {
            call.name.as_str()
        };
        match name {
            agent_tools::WEB_SEARCH_TOOL => {
                if web_search_so_far + search_reserved >= MAX_WEB_SEARCH_PER_TURN {
                    out.push(Some(WEB_SEARCH_CAP_REJECT));
                } else {
                    out.push(None);
                    search_reserved += 1;
                }
            }
            agent_tools::WEB_FETCH_TOOL => {
                if web_fetch_so_far + fetch_reserved >= MAX_WEB_FETCH_PER_TURN {
                    out.push(Some(WEB_FETCH_CAP_REJECT));
                } else {
                    out.push(None);
                    fetch_reserved += 1;
                }
            }
            _ => out.push(None),
        }
    }
    out
}

/// Drop local `web_search` / `web_fetch` from later rounds once a per-turn cap
/// was hit so the model cannot keep requesting them.
pub fn narrow_tools_after_web_cap(
    defs: &[provider_core::schema::ToolDefinition],
    strip_search: bool,
    strip_fetch: bool,
) -> Vec<provider_core::schema::ToolDefinition> {
    defs.iter()
        .filter(|t| {
            if strip_search && t.name == agent_tools::WEB_SEARCH_TOOL {
                return false;
            }
            if strip_fetch && t.name == agent_tools::WEB_FETCH_TOOL {
                return false;
            }
            true
        })
        .cloned()
        .collect()
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
        let store = state.credential_store();

        let descriptor = provider_core::descriptor(provider_id)
            .ok_or_else(|| format!("Unknown provider: {provider_id}"))?;

        let api_key = match descriptor.credential_mode {
            provider_core::CredentialMode::None => None,
            provider_core::CredentialMode::Optional => {
                if store.has_provider_secret(provider_id) {
                    Some(store.get_secret(provider_id)?)
                } else {
                    None
                }
            }
            provider_core::CredentialMode::Required => {
                if store.has_provider_secret(provider_id) {
                    Some(store.get_secret(provider_id)?)
                } else {
                    return Err(format!("No credential stored for provider {provider_id}"));
                }
            }
        };

        let base_url = settings
            .provider_endpoints
            .get(provider_id)
            .and_then(|cfg| cfg.base_url.clone());

        Ok(AdapterContext {
            api_key,
            base_url,
            http: state.http.clone(),
            // Phase 7 / M-WebSearch: thread the user's local-only intent to
            // adapters so they can refuse hosted-search tools (and any other
            // network-bearing hosted tool) at the trust boundary, not just
            // the UI layer.
            local_only: settings.local_only,
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
        // we surface any setup or round-level error as before. There is no loop
        // behind this call, so the round's completion is the turn's completion.
        let outcome = self
            .run_provider_round(
                state,
                provider_request,
                channel,
                cancel,
                CompletionDelivery::Immediate,
                ProviderRoundBind {
                    persist_request_id: &request_id,
                    release_active: true,
                },
            )
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
        completion: CompletionDelivery,
        bind: ProviderRoundBind<'_>,
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
        let persist_id = bind.persist_request_id.to_string();
        let release_active = bind.release_active;
        let pool = state.db.clone();

        // t0-1: hydrate a clone with image bytes. The long-lived agent-loop
        // request keeps AttachmentReference parts only.
        let (hydrated_request, vision_report) = crate::vision::hydrate_request_for_vision(
            &pool,
            &state.paths.attachments,
            &state.encryption,
            &provider_id,
            &request,
        )
        .await;
        if vision_report.text_only_model {
            warn!(
                request_id = %request_id,
                provider = %provider_id,
                model = %request.model_id,
                "images were not sent — this model is treated as text-only"
            );
        }

        let stream = match adapter
            .stream_chat(hydrated_request, ctx, cancel.clone())
            .await
        {
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
        let mut round_usage: Option<provider_core::schema::ProviderUsage> = None;
        let mut completion_event: Option<ProviderEvent> = None;
        // Reasoning is deliberately not text: a round that thought and then said
        // nothing still answered nothing.
        let mut produced_text = false;
        let mut round_text = String::new();

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

            // Capture usage event for the round outcome
            if let ProviderEvent::Usage { usage, .. } = &event {
                round_usage = Some(usage.clone());
            }

            if let ProviderEvent::ContentDelta { content, .. } = &event {
                if !content.is_empty() {
                    produced_text = true;
                    round_text.push_str(content);
                }
            }

            // Correlate tool start/complete for round outcome
            match &event {
                ProviderEvent::ToolCallStart {
                    tool_call_id,
                    tool_id,
                    name,
                    ..
                } => {
                    tool_start_info
                        .insert(tool_call_id.clone(), (Some(tool_id.clone()), name.clone()));
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

            // Persist + forward. Persistence is unconditional: the event log is
            // the replay source for rebuilding a turn, so it records every round's
            // completion even when the channel does not see it. Continuation HTTP
            // requests carry a fresh id; fold under the turn's canonical id so
            // reload hydrates one assistant message.
            let _ = event_log::append_and_apply(&pool, &conversation_id, &persist_id, &event).await;

            let is_completion = matches!(event, ProviderEvent::MessageComplete { .. });
            let withhold = is_completion && completion == CompletionDelivery::Deferred;

            if withhold {
                completion_event = Some(event.clone());
            } else if channel.send(event.clone()).is_err() {
                cancel.cancel();
                let _ = messages::mark_interrupted_by_request(&pool, &persist_id).await;
                break;
            }

            if is_completion {
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
        // only when this round owns the slot. The agent loop keeps the canonical
        // id registered across continuation rounds.
        if release_active {
            let _ = self
                .active
                .lock()
                .map(|mut guard| guard.remove(&request_id));
        }

        RoundOutcome {
            // Reaching here means the stream opened, so the only way
            // `error_message` is set is the mid-stream `ProviderEvent::Error`
            // above — and that one went out on the channel with every other
            // event. The four early returns never get this far; they build
            // their outcome with `..Default::default()`, which leaves this
            // false, and the loop then owes the terminal event.
            error_forwarded: error_message.is_some(),
            completed_tool_calls,
            finished_normally,
            produced_text,
            error_message,
            usage: round_usage,
            completion_event,
            round_text,
        }
    }

    /// Execute a batch of tool calls resolved from a provider round.
    /// This is the direct in-process invocation of the Phase 4 execution pipeline
    /// from the agent loop, preserving consent, redaction, and persistence.
    ///
    /// `successful_creates_so_far` is the turn-wide count of `write_*` creates
    /// that already succeeded; it is updated in place when this round creates
    /// more. `web_search_so_far` / `web_fetch_so_far` count local web tool
    /// executions this turn (cap binge-retries on empty Instant Answer).
    /// Returns how many new documents this round created.
    #[allow(clippy::too_many_arguments)]
    pub async fn execute_resolved_tool_calls(
        &self,
        state: &AppState,
        runtime: &crate::connector_runtime::ConnectorRuntimeManager,
        calls: &[CompletedToolCall],
        request_id: &str,
        conversation_id: &str,
        runtime_channel: Option<&Channel<ConnectorRuntimeEvent>>,
        provider_channel: Option<&Channel<ProviderEvent>>,
        successful_creates_so_far: &mut u32,
        web_search_so_far: &mut u32,
        web_fetch_so_far: &mut u32,
    ) -> u32 {
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
        let settings = state.settings().unwrap_or_default();
        let conversation = conversations::get(&state.db, conversation_id)
            .await
            .ok()
            .flatten();
        let from_conversation = conversation
            .as_ref()
            .and_then(|c| c.workspace_root.as_ref())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let from_settings =
            if settings.workspace_tools_enabled && settings.workspace_tools_consent_acknowledged {
                settings
                    .workspace_root
                    .as_ref()
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
            } else {
                None
            };
        // Conversation bind wins; settings default applies when enabled + consent.
        let workspace_root = from_conversation.or(from_settings);
        let workspace_config =
            workspace_root.map(|root| crate::workspace_tools::WorkspaceToolConfig {
                root: std::path::PathBuf::from(root),
            });
        let search_backend = settings.web_search.local_backend;
        let search_api_key =
            crate::search::credential_id(search_backend).and_then(|id| {
                match state.credential_store().get_secret(id) {
                    Ok(secret) if !secret.trim().is_empty() => Some(secret),
                    _ => None,
                }
            });
        let ctx = agent_tools::AgentToolContext {
            db: &state.db,
            artifacts_dir: &state.paths.artifacts,
            exports_dir: &state.paths.exports,
            encryption: &state.encryption,
            conversation_id,
            source_message_id,
            workspace: workspace_config.as_ref(),
            search: crate::search::LocalSearchConfig {
                backend: search_backend,
                api_key: search_api_key,
                searxng_base_url: settings.web_search.searxng_base_url.clone(),
            },
        };
        let sink = runtime_channel.map(|channel| {
            let channel = channel.clone();
            std::sync::Arc::new(move |event| {
                let _ = channel.send(event);
            }) as crate::connector_runtime::execution::EventSink
        });

        let clamp_actions = classify_document_create_clamps(calls, *successful_creates_so_far);
        let web_rejects = classify_web_tool_clamps(calls, *web_search_so_far, *web_fetch_so_far);
        let mut created_this_round = 0u32;

        for (idx, (call, action)) in calls.iter().zip(clamp_actions.iter()).enumerate() {
            let tool_name = if call.name.trim().is_empty() {
                call.tool_id.clone().unwrap_or_default()
            } else {
                call.name.clone()
            };

            // Emit tool execution started event.
            if let Some(ch) = provider_channel {
                let _ = ch.send(ProviderEvent::ToolExecutionStarted {
                    request_id: request_id.to_string(),
                    tool_call_id: call.tool_call_id.clone(),
                    tool_name: tool_name.clone(),
                });
            }

            let reject_msg = action
                .reject_message()
                .or_else(|| web_rejects.get(idx).copied().flatten());
            if let Some(reject_msg) = reject_msg {
                match agent_tools::record_clamped_builtin_tool(
                    &ctx,
                    &call.tool_call_id,
                    request_id,
                    &tool_name,
                    &call.arguments,
                    reject_msg,
                )
                .await
                {
                    Ok(exec) => {
                        if let Some(channel) = runtime_channel {
                            let _ = channel.send(ConnectorRuntimeEvent::ToolCallFinished {
                                tool_call_id: exec.record.id.clone(),
                                status: exec.record.status,
                                is_error: Some(true),
                                size_bytes: 0,
                                mime_hints: Vec::new(),
                                error: exec.record.error.clone(),
                            });
                        }
                        if let Some(ch) = provider_channel {
                            let _ = ch.send(ProviderEvent::ToolExecutionFinished {
                                request_id: request_id.to_string(),
                                tool_call_id: exec.record.id.clone(),
                                tool_name: tool_name.clone(),
                                is_error: true,
                                error: exec.record.error.clone(),
                            });
                        }
                    }
                    Err(error) => {
                        warn!(
                            request_id = %request_id,
                            tool_call_id = %call.tool_call_id,
                            error = %error,
                            "failed to record clamped tool rejection"
                        );
                        if let Some(ch) = provider_channel {
                            let _ = ch.send(ProviderEvent::ToolExecutionFinished {
                                request_id: request_id.to_string(),
                                tool_call_id: call.tool_call_id.clone(),
                                tool_name: tool_name.clone(),
                                is_error: true,
                                error: Some(error),
                            });
                        }
                    }
                }
                continue;
            }

            if agent_tools::is_builtin_tool_name(&tool_name) {
                // Count toward per-turn web caps whether Instant Answer is empty
                // or the call fails — each attempt burns a slot so binge-retries stop.
                if tool_name == agent_tools::WEB_SEARCH_TOOL {
                    *web_search_so_far = web_search_so_far.saturating_add(1);
                } else if tool_name == agent_tools::WEB_FETCH_TOOL {
                    *web_fetch_so_far = web_fetch_so_far.saturating_add(1);
                }
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
                            if !exec.is_error && tool_output_created_document(&exec.output) {
                                created_this_round += 1;
                                *successful_creates_so_far =
                                    successful_creates_so_far.saturating_add(1);
                            }
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
                            // Emit tool execution finished event.
                            if let Some(ch) = provider_channel {
                                let _ = ch.send(ProviderEvent::ToolExecutionFinished {
                                    request_id: request_id.to_string(),
                                    tool_call_id: exec.record.id.clone(),
                                    tool_name: tool_name.clone(),
                                    is_error: exec.is_error,
                                    error: exec.record.error.clone(),
                                });
                            }
                        }
                        Err(error) => {
                            let _ = channel.send(ConnectorRuntimeEvent::ToolCallFinished {
                                tool_call_id: call.tool_call_id.clone(),
                                status: provider_core::schema::ToolCallStatus::Failed,
                                is_error: Some(true),
                                size_bytes: 0,
                                mime_hints: Vec::new(),
                                error: Some(error.clone()),
                            });
                            // Emit tool execution finished event with error.
                            if let Some(ch) = provider_channel {
                                let _ = ch.send(ProviderEvent::ToolExecutionFinished {
                                    request_id: request_id.to_string(),
                                    tool_call_id: call.tool_call_id.clone(),
                                    tool_name: tool_name.clone(),
                                    is_error: true,
                                    error: Some(error),
                                });
                            }
                        }
                    }
                } else if let Ok(exec) = outcome {
                    // No runtime channel (tests / single-path callers) — still
                    // count creates so turn clamps stay accurate.
                    if !exec.is_error && tool_output_created_document(&exec.output) {
                        created_this_round += 1;
                        *successful_creates_so_far = successful_creates_so_far.saturating_add(1);
                    }
                    if let Some(ch) = provider_channel {
                        let _ = ch.send(ProviderEvent::ToolExecutionFinished {
                            request_id: request_id.to_string(),
                            tool_call_id: exec.record.id.clone(),
                            tool_name: tool_name.clone(),
                            is_error: exec.is_error,
                            error: exec.record.error.clone(),
                        });
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
            let _ =
                crate::connector_runtime::execution::execute_tool_call(state, runtime, &req, &sink)
                    .await;
        }

        created_this_round
    }

    /// Build a continuation `ProviderRequest` for the next provider round.
    /// This is the single guarded path that may inject tool output (after
    /// `validate_reinjection`) into a follow-up prompt.
    ///
    /// Tests and single-round helpers call this with the previous request's
    /// id. The agent loop uses [`Self::build_continuation_request_for_turn`] so
    /// tool rows and the assistant snapshot resolve against the canonical turn
    /// id while the HTTP request still mints a fresh `request_id`.
    pub async fn build_continuation_request(
        &self,
        state: &AppState,
        previous_request: &ProviderRequest,
        completed_calls: &[CompletedToolCall],
    ) -> Result<ProviderRequest, String> {
        self.build_continuation_request_for_turn(
            state,
            previous_request,
            completed_calls,
            &previous_request.request_id,
            None,
        )
        .await
    }

    pub async fn build_continuation_request_for_turn(
        &self,
        state: &AppState,
        previous_request: &ProviderRequest,
        completed_calls: &[CompletedToolCall],
        persist_request_id: &str,
        round_text: Option<&str>,
    ) -> Result<ProviderRequest, String> {
        let pool = &state.db;

        // Prefer this round's in-memory calls so a shared persist id does not
        // re-inject earlier rounds' tools. Fall back to listing by persist id
        // for tests that seed the DB and pass an empty slice.
        let records = if !completed_calls.is_empty() {
            let mut loaded = Vec::with_capacity(completed_calls.len());
            for call in completed_calls {
                match tool_calls::get_tool_call(pool, &state.encryption, &call.tool_call_id).await {
                    Ok(Some(record)) => loaded.push(record),
                    Ok(None) => loaded.push(ToolCallRecord {
                        id: call.tool_call_id.clone(),
                        tool_id: call.tool_id.clone().unwrap_or_else(|| call.name.clone()),
                        request_id: persist_request_id.to_string(),
                        status: ToolCallStatus::Completed,
                        arguments: Some(call.arguments.clone()),
                        result: None,
                        error: None,
                        approved_at: None,
                        completed_at: None,
                    }),
                    Err(e) => {
                        return Err(format!(
                            "failed to load tool call {}: {e}",
                            call.tool_call_id
                        ));
                    }
                }
            }
            loaded
        } else {
            tool_calls::list_tool_calls_by_request(pool, persist_request_id)
                .await
                .map_err(|e| format!("failed to list tool calls: {e}"))?
        };

        // 2–3. For each tool call, load redacted result, validate reinjection.
        let mut tool_result_parts: Vec<MessagePart> = Vec::new();
        let mut tool_call_meta: Vec<serde_json::Value> = Vec::new();
        // Parallel tuples for DB persistence — mirrors tool_call_meta but as
        // typed (String, String, Value) triplets for enrich_assistant_with_tool_calls.
        let mut tool_call_tuples: Vec<(String, String, serde_json::Value)> = Vec::new();

        for record in &records {
            tool_call_tuples.push((
                record.id.clone(),
                record.tool_id.clone(),
                record.arguments.clone().unwrap_or(serde_json::Value::Null),
            ));
            tool_call_meta.push(serde_json::json!({
                "tool_call_id": record.id,
                "name": record.tool_id,
                "arguments": record.arguments,
            }));

            let result_content = match record.status {
                ToolCallStatus::Completed => {
                    match tool_calls::latest_tool_result(pool, &state.encryption, &record.id).await
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
                ToolCallStatus::Failed => record
                    .error
                    .clone()
                    .unwrap_or_else(|| "Tool call failed.".to_string()),
                ToolCallStatus::Cancelled => "Tool call was cancelled by the user.".to_string(),
                _ => "Tool call did not complete.".to_string(),
            };

            // Truncate very long tool results to save context window space.
            const MAX_TOOL_RESULT_CHARS: usize = 50_000;
            let result_content = if result_content.len() > MAX_TOOL_RESULT_CHARS {
                let mut truncated = result_content;
                truncated.truncate(MAX_TOOL_RESULT_CHARS);
                truncated.push_str("\n\n[Tool output truncated at 50,000 characters]");
                truncated
            } else {
                result_content
            };

            let mut part_metadata = serde_json::json!({ "name": record.tool_id });
            if matches!(
                record.status,
                ToolCallStatus::Failed | ToolCallStatus::Cancelled
            ) {
                part_metadata["is_error"] = serde_json::json!(true);
            }

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
                metadata: Some(part_metadata),
                created_at: crate::time::now_iso8601(),
            });
        }

        // 4. Persist tool-call metadata on the event-folded assistant message
        // so tool calls survive conversation reload (R1 of the Phase A plan).
        if !tool_call_tuples.is_empty() {
            match messages::get_message_id_by_request(pool, persist_request_id).await {
                Ok(Some(assistant_msg_id)) => {
                    if let Err(e) = messages::enrich_assistant_with_tool_calls(
                        pool,
                        &assistant_msg_id,
                        &tool_call_tuples,
                    )
                    .await
                    {
                        eprintln!("DEBUG_R1: enrich error: {}", e);
                        warn!(
                            request_id = %persist_request_id,
                            error = %e,
                            "failed to enrich assistant message with tool-call metadata"
                        );
                    }
                }
                Ok(None) => {
                    warn!(
                        request_id = %persist_request_id,
                        "no message row found for request; cannot enrich with tool-call metadata"
                    );
                }
                Err(e) => {
                    warn!(
                        request_id = %persist_request_id,
                        error = %e,
                        "failed to look up message for request"
                    );
                }
            }
        }

        // 5. Build assistant message parts for the continuation request.
        // The assistant message is already persisted by the event fold.
        // We build an in-memory version enriched with tool-call metadata
        // for the adapters to serialize correctly.
        let turn_now = crate::time::now_iso8601();
        let mut assistant_parts: Vec<MessagePart> = Vec::new();

        // Prefer this round's streamed text so a shared persist identity does
        // not re-inject earlier rounds into the next provider prompt.
        if let Some(text) = round_text.filter(|s| !s.is_empty()) {
            assistant_parts.push(MessagePart {
                id: format!("{persist_request_id}/round-text-{}", Uuid::new_v4()),
                message_id: String::new(),
                index: 0,
                kind: MessagePartKind::Text,
                content: Some(text.to_string()),
                mime_type: None,
                tool_call_id: None,
                artifact_id: None,
                attachment_id: None,
                blob_ref: None,
                metadata: None,
                created_at: turn_now.clone(),
            });
        } else if let Ok(Some(snapshot)) =
            messages::snapshot_view_for_request(pool, persist_request_id).await
        {
            for part in &snapshot.parts {
                if matches!(
                    part.kind,
                    MessagePartKind::Text | MessagePartKind::Reasoning
                ) {
                    if let Some(ref content) = part.content {
                        if !content.is_empty() {
                            assistant_parts.push(MessagePart {
                                id: part.id.clone(),
                                message_id: String::new(),
                                index: assistant_parts.len() as u32,
                                kind: MessagePartKind::Text,
                                content: Some(content.clone()),
                                mime_type: None,
                                tool_call_id: None,
                                artifact_id: None,
                                attachment_id: None,
                                blob_ref: None,
                                metadata: None,
                                created_at: turn_now.clone(),
                            });
                        }
                    }
                }
            }
        }

        // Add ToolCall-kind parts (one per tool call) so the adapters can
        // serialize them directly without digging into metadata.
        for tc in &tool_call_meta {
            let tc_id = tc
                .get("tool_call_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let tc_name = tc.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let tc_args = tc
                .get("arguments")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let idx = assistant_parts.len() as u32;
            assistant_parts.push(MessagePart {
                id: format!("{}/tc-{}", previous_request.request_id, tc_id),
                message_id: String::new(),
                index: idx,
                kind: MessagePartKind::ToolCall,
                content: Some(tc_args.to_string()),
                mime_type: None,
                tool_call_id: Some(tc_id.to_string()),
                artifact_id: None,
                attachment_id: None,
                blob_ref: None,
                metadata: Some(serde_json::json!({"name": tc_name})),
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
                author_label: None,
                provider_message_id: None,
                request_id: None,
                interrupted_at: None,
                metadata: None,
                parts: tool_result_parts
                    .iter()
                    .enumerate()
                    .map(|(i, p)| {
                        let mut part = p.clone();
                        part.message_id = tool_msg_id.clone();
                        part.index = i as u32;
                        part
                    })
                    .collect(),
                created_at: turn_now.clone(),
            };
            let _ = messages::insert_message(pool, &msg).await;
        }

        // 7. Build the continuation ProviderRequest with fresh request_id.
        let assistant_msg_id = format!("{}/assistant", previous_request.request_id);
        let mut continuation_messages = previous_request.messages.clone();

        if !assistant_parts.is_empty() {
            continuation_messages.push(Message {
                id: assistant_msg_id.clone(),
                conversation_id: previous_request.conversation_id.clone(),
                role: MessageRole::Assistant,
                author_label: None,
                provider_message_id: None,
                request_id: None,
                interrupted_at: None,
                metadata: None,
                parts: assistant_parts
                    .into_iter()
                    .enumerate()
                    .map(|(i, mut p)| {
                        p.index = i as u32;
                        p.message_id = assistant_msg_id.clone();
                        p
                    })
                    .collect(),
                created_at: turn_now.clone(),
            });
        }

        if !tool_result_parts.is_empty() {
            continuation_messages.push(Message {
                id: tool_msg_id.clone(),
                conversation_id: previous_request.conversation_id.clone(),
                role: MessageRole::Tool,
                author_label: None,
                provider_message_id: None,
                request_id: None,
                interrupted_at: None,
                metadata: None,
                parts: tool_result_parts
                    .into_iter()
                    .enumerate()
                    .map(|(i, mut p)| {
                        p.index = i as u32;
                        p.message_id = tool_msg_id.clone();
                        p
                    })
                    .collect(),
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
            // Continuation rounds carry forward the original turn's web-search
            // intent. `web_search` is a per-turn, per-request knob; if the
            // user enabled search for the first round, the agent loop should
            // not silently drop it on continuation rounds.
            web_search: previous_request.web_search.clone(),
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

        let guardrails = state.settings().map_err(|e| e.to_string())?.agent;
        let max_steps = guardrails.max_steps as usize;
        let wall_clock_secs = guardrails.wall_clock_budget_secs;
        let deadline =
            tokio::time::Instant::now() + std::time::Duration::from_secs(wall_clock_secs as u64);

        let active_model_id = initial_request.model_id.clone();
        let mut current_request = initial_request;
        current_request.request_id = request_id.clone();
        let mut ended_with_pending_tools = false;
        let mut cumulative_usage: Option<provider_core::schema::ProviderUsage> = None;
        let mut successful_document_creates: u32 = 0;
        let mut web_search_calls: u32 = 0;
        let mut web_fetch_calls: u32 = 0;

        // Exactly one terminal event reaches the UI per turn, emitted after the
        // loop so the cumulative usage lands first. `terminal` holds the event
        // still owed; `terminal_forwarded` records the case where a round has
        // already sent one itself (rounds forward `Error` immediately, since an
        // errored round ends the turn).
        let mut terminal: Option<ProviderEvent> = None;
        let mut terminal_forwarded = false;

        for step in 0..max_steps {
            if cancel.is_cancelled() {
                break;
            }
            if tokio::time::Instant::now() > deadline {
                // Terminal error, emitted below so it lands after the usage total.
                terminal = Some(ProviderEvent::Error {
                    request_id: request_id.clone(),
                    error: provider_core::schema::ProviderError {
                        provider_code: None,
                        message: format!(
                            "Agent turn exceeded wall-clock budget ({wall_clock_secs}s). Increase it in Settings → Agent."
                        ),
                        retryable: false,
                    },
                });
                break;
            }

            // Emit agent phase event before each provider round.
            let total = max_steps as u32;
            let round_num = (step + 1) as u32;
            let (label, sub_phase) = if step == 0 {
                ("Thinking".to_string(), "thinking".to_string())
            } else {
                ("Continuing".to_string(), "thinking".to_string())
            };
            let _ = channel.send(ProviderEvent::AgentPhase {
                request_id: request_id.clone(),
                label,
                round: round_num,
                total_rounds: total,
                sub_phase,
            });

            // Bounded by whatever is left of the wall-clock budget.
            //
            // The check at the top of this loop can only fire *between* rounds,
            // so it cannot rescue a round that never returns — and nothing
            // downstream bounds one either: the HTTP client sets a connect
            // timeout but no read timeout, so a stream that opens and then goes
            // quiet parks in `stream.next().await` forever. Observed in the
            // wild at 368s against a 300s budget, still counting.
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let round = self.run_provider_round(
                state,
                current_request.clone(),
                channel.clone(),
                cancel.clone(),
                CompletionDelivery::Deferred,
                ProviderRoundBind {
                    persist_request_id: &request_id,
                    release_active: false,
                },
            );
            let mut outcome = match tokio::time::timeout(remaining, round).await {
                Ok(outcome) => outcome,
                Err(_) => {
                    warn!(
                        request_id = %request_id,
                        step,
                        "provider round exceeded the remaining wall-clock budget"
                    );
                    terminal = Some(ProviderEvent::Error {
                        request_id: request_id.clone(),
                        error: provider_core::schema::ProviderError {
                            provider_code: None,
                            message: format!(
                                "Agent turn exceeded wall-clock budget ({wall_clock_secs}s) waiting on the provider. Increase it in Settings → Agent."
                            ),
                            retryable: false,
                        },
                    });
                    break;
                }
            };

            // Accumulate usage across rounds.
            if let Some(ref round_usage) = outcome.usage {
                cumulative_usage = Some(match cumulative_usage.take() {
                    Some(acc) => provider_core::schema::ProviderUsage {
                        input_tokens: acc
                            .input_tokens
                            .zip(round_usage.input_tokens)
                            .map(|(a, b)| a + b)
                            .or(acc.input_tokens.or(round_usage.input_tokens)),
                        output_tokens: acc
                            .output_tokens
                            .zip(round_usage.output_tokens)
                            .map(|(a, b)| a + b)
                            .or(acc.output_tokens.or(round_usage.output_tokens)),
                        cache_tokens: acc
                            .cache_tokens
                            .zip(round_usage.cache_tokens)
                            .map(|(a, b)| a + b)
                            .or(acc.cache_tokens.or(round_usage.cache_tokens)),
                        cache_read_tokens: acc
                            .cache_read_tokens
                            .zip(round_usage.cache_read_tokens)
                            .map(|(a, b)| a + b)
                            .or(acc.cache_read_tokens.or(round_usage.cache_read_tokens)),
                        cache_write_tokens: acc
                            .cache_write_tokens
                            .zip(round_usage.cache_write_tokens)
                            .map(|(a, b)| a + b)
                            .or(acc.cache_write_tokens.or(round_usage.cache_write_tokens)),
                        cost_hint: round_usage.cost_hint.clone(),
                    },
                    None => round_usage.clone(),
                });
            }

            // The round withheld its `MessageComplete`; carry it forward. If the
            // loop continues, the next round's replaces it, so what survives is
            // the completion of whichever round turned out to be last.
            if outcome.completion_event.is_some() {
                terminal = outcome.completion_event;
            }

            if let Some(err) = outcome.error_message.take() {
                warn!(request_id = %request_id, step, error = %err, "agent turn aborted due to round error");
                match terminal_event_for_round_error(&request_id, err, outcome.error_forwarded) {
                    Some(event) => terminal = Some(event),
                    None => terminal_forwarded = true,
                }
                break;
            }

            let (runnable, undeclared) = partition_declared_tool_calls(
                std::mem::take(&mut outcome.completed_tool_calls),
                &current_request.tool_definitions,
            );
            for call in &undeclared {
                warn!(
                    request_id = %request_id,
                    step,
                    tool = %call.name,
                    tool_call_id = %call.tool_call_id,
                    "ignoring a completed tool call this request never declared"
                );
            }

            // A round can end cleanly and still leave the user with nothing: no
            // text, and every tool call it made discarded as undeclared. The
            // check below reads an empty runnable list as "the assistant
            // produced a final answer", which is true when the model answered
            // and false here — so this turn would finalize on a blank bubble
            // with `stop` and no error, the exact shape the in-band error branch
            // in `adapters/openai.rs` already exists to prevent.
            if round_produced_nothing(outcome.produced_text, &runnable, &undeclared) {
                warn!(
                    request_id = %request_id,
                    step,
                    dropped = undeclared.len(),
                    "turn produced no text and no runnable tool calls; reporting instead of ending silently"
                );
                terminal = Some(ProviderEvent::Error {
                    request_id: request_id.clone(),
                    error: provider_core::schema::ProviderError {
                        provider_code: None,
                        message: empty_turn_message(&undeclared),
                        retryable: false,
                    },
                });
                break;
            }

            outcome.completed_tool_calls = runnable;

            if outcome.completed_tool_calls.is_empty() {
                // No tool calls requested; the assistant produced a final answer.
                break;
            }

            // Emit executing_tools phase before executing tools.
            let total = max_steps as u32;
            let round_num = (step + 1) as u32;
            let _ = channel.send(ProviderEvent::AgentPhase {
                request_id: request_id.clone(),
                label: format!(
                    "Running {} tool{}",
                    outcome.completed_tool_calls.len(),
                    if outcome.completed_tool_calls.len() == 1 {
                        ""
                    } else {
                        "s"
                    }
                ),
                round: round_num,
                total_rounds: total,
                sub_phase: "executing_tools".to_string(),
            });

            let created_this_round = self
                .execute_resolved_tool_calls(
                    state,
                    runtime,
                    &outcome.completed_tool_calls,
                    &request_id,
                    &conversation_id,
                    Some(&runtime_channel),
                    Some(&channel),
                    &mut successful_document_creates,
                    &mut web_search_calls,
                    &mut web_fetch_calls,
                )
                .await;

            // After the first successful create, later rounds must not offer
            // write_* — revisions go through edit_* with the returned id.
            if created_this_round > 0 || successful_document_creates > 0 {
                current_request.tool_definitions =
                    narrow_tools_after_document_create(&current_request.tool_definitions);
            }

            // Once a local web-tool cap is hit, strip both web tools so the
            // model answers instead of binge-retrying empty Instant Answer hits.
            let strip_search = web_search_calls >= MAX_WEB_SEARCH_PER_TURN;
            let strip_fetch = web_fetch_calls >= MAX_WEB_FETCH_PER_TURN;
            if strip_search || strip_fetch {
                current_request.tool_definitions = narrow_tools_after_web_cap(
                    &current_request.tool_definitions,
                    strip_search || strip_fetch,
                    strip_search || strip_fetch,
                );
            }

            // Emit reviewing phase after tool execution, before continuation.
            let _ = channel.send(ProviderEvent::AgentPhase {
                request_id: request_id.clone(),
                label: "Reviewing results".to_string(),
                round: round_num,
                total_rounds: total,
                sub_phase: "reviewing".to_string(),
            });

            info!(
                request_id = %request_id,
                step,
                tool_call_count = outcome.completed_tool_calls.len(),
                "agent turn executed tool calls; building continuation request"
            );

            // Build a continuation request and loop for the next round.
            match self
                .build_continuation_request_for_turn(
                    state,
                    &current_request,
                    &outcome.completed_tool_calls,
                    &request_id,
                    Some(outcome.round_text.as_str()).filter(|s| !s.is_empty()),
                )
                .await
            {
                Ok(continuation) => {
                    current_request = continuation;
                    if step == max_steps - 1 {
                        ended_with_pending_tools = true;
                    }
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

        if ended_with_pending_tools {
            // Supersedes any withheld completion: the turn did not finish, it ran
            // out of steps, and that is what the reader needs to be told.
            terminal = Some(ProviderEvent::Error {
                request_id: request_id.clone(),
                error: provider_core::schema::ProviderError {
                    provider_code: None,
                    message: format!(
                        "Agent turn exceeded max steps ({max_steps}). Increase it in Settings → Agent."
                    ),
                    retryable: false,
                },
            });
        }

        // Emit cumulative usage across all rounds.
        if let Some(usage) = cumulative_usage {
            let _ = channel.send(ProviderEvent::Usage {
                request_id: request_id.clone(),
                usage: usage.clone(),
            });

            // Persist usage for analytics. Best-effort: analytics must never
            // break a chat turn, so failures are logged and swallowed.
            if let Ok(settings) = state.settings() {
                let provider_id = settings.active_provider;
                let model_id = active_model_id.clone();
                if let Ok(Some(message_id)) =
                    messages::get_message_id_by_request(&pool, &request_id).await
                {
                    let pricing = provider_core::catalog::lookup_pricing(&provider_id, &model_id);
                    let cost = provider_core::catalog::estimate_cost_cents(&usage, &pricing);
                    if let Err(e) = usage_summary::insert_usage_summary(
                        &pool,
                        usage_summary::UsageSummaryRow {
                            message_id: &message_id,
                            conversation_id: &conversation_id,
                            provider_id: &provider_id,
                            model_id: &model_id,
                            input_tokens: usage.input_tokens.unwrap_or(0) as i64,
                            output_tokens: usage.output_tokens.unwrap_or(0) as i64,
                            cache_read_tokens: usage.cache_read_tokens.unwrap_or(0) as i64,
                            cache_write_tokens: usage.cache_write_tokens.unwrap_or(0) as i64,
                            cost_estimate: cost.as_deref(),
                        },
                    )
                    .await
                    {
                        warn!(
                            request_id = %request_id,
                            error = %e,
                            "usage analytics persistence failed (non-fatal)"
                        );
                    }
                }
            }
        }

        // Close the turn — last, so every content, tool and usage event has
        // already reached the UI. The UI settles the stream here and ignores
        // anything that follows, which is precisely why nothing may be emitted
        // after this point.
        //
        // A turn can legitimately end with nothing owed: cancellation breaks the
        // loop mid-round, so no completion was ever produced and the cancel path
        // owns the UI state.
        if !terminal_forwarded {
            if let Some(event) = terminal {
                let event = match event {
                    // Re-stamp with the turn's canonical id. Continuation rounds
                    // carry a fresh request_id (see `build_continuation_request`),
                    // and every other turn-level event uses the original.
                    ProviderEvent::MessageComplete {
                        index,
                        finish_reason,
                        ..
                    } => ProviderEvent::MessageComplete {
                        request_id: request_id.clone(),
                        index,
                        finish_reason,
                    },
                    other => other,
                };
                let _ = channel.send(event);
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

    Ok(build_connector_tool_catalog(
        &snapshots,
        &capabilities_by_version,
    ))
}

impl Default for StreamManager {
    fn default() -> Self {
        Self::new()
    }
}
