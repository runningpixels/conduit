//! End-to-end tests for `StreamManager::run_agent_turn`.
//!
//! The loop runs for real — rounds, tool execution, persistence, the turn time
//! limit — against a scripted provider adapter instead of the network. Each
//! scripted round is a list of provider events (with optional pauses), played
//! back in order; the adapter records every request it receives, so a test
//! can assert how many provider rounds the loop started.

mod common;

use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use conduit_desktop::{
    connector_runtime::ConnectorRuntimeManager,
    credentials,
    db::repository::conversations,
    event_sink::{self, EventSink},
    paths::AppPaths,
    state::AppState,
    stream_manager::StreamManager,
};
use futures::stream::{Stream, StreamExt};
use provider_core::schema::{
    AgentGuardrails, AppSettings, ConnectorRuntimeEvent, GenerationControls, KeychainMode, Message,
    MessagePart, MessagePartKind, MessageRole, PermissionLevel, ProviderError, ProviderEvent,
    ProviderRequest, ToolDefinition,
};
use provider_core::{AdapterContext, ModelInfo, ProviderAdapter};
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

// ── Scripted provider ────────────────────────────────────────────────────────

enum Step {
    Event(ProviderEvent),
    Pause(Duration),
}

/// Builds one round's steps from the request id the loop sent.
type Round = Arc<dyn Fn(&str) -> Vec<Step> + Send + Sync>;

#[derive(Clone)]
struct Script {
    rounds: Arc<Vec<Round>>,
    requests: Arc<Mutex<Vec<ProviderRequest>>>,
}

impl Script {
    fn new(rounds: Vec<Round>) -> Self {
        Self {
            rounds: Arc::new(rounds),
            requests: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn rounds_started(&self) -> usize {
        self.requests.lock().unwrap().len()
    }
}

struct ScriptedAdapter(Script);

#[async_trait]
impl ProviderAdapter for ScriptedAdapter {
    fn id(&self) -> &'static str {
        "ollama"
    }

    fn display_name(&self) -> &'static str {
        "Scripted"
    }

    // Presents as ollama, so it is a local provider: `local_only` (on by
    // default) must let it through.
    fn is_local(&self) -> bool {
        true
    }

    async fn validate_credentials(&self, _ctx: &AdapterContext) -> Result<(), ProviderError> {
        Ok(())
    }

    async fn list_models(&self, _ctx: &AdapterContext) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(Vec::new())
    }

    async fn stream_chat(
        &self,
        request: ProviderRequest,
        _ctx: AdapterContext,
        _cancel: CancellationToken,
    ) -> Result<Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>, ProviderError> {
        let index = {
            let mut requests = self.0.requests.lock().unwrap();
            requests.push(request.clone());
            requests.len() - 1
        };
        let steps = match self.0.rounds.get(index) {
            Some(round) => round(&request.request_id),
            None => text_round("(script exhausted)")(&request.request_id),
        };
        let stream = futures::stream::iter(steps)
            .then(|step| async move {
                match step {
                    Step::Pause(duration) => {
                        tokio::time::sleep(duration).await;
                        None
                    }
                    Step::Event(event) => Some(event),
                }
            })
            .filter_map(|event| async move { event });
        Ok(Box::pin(stream))
    }
}

/// The same scripted rounds from a cloud provider — what `local_only` exists to
/// refuse.
struct CloudScriptedAdapter(Script);

#[async_trait]
impl ProviderAdapter for CloudScriptedAdapter {
    fn id(&self) -> &'static str {
        "openrouter"
    }

    fn display_name(&self) -> &'static str {
        "Scripted cloud"
    }

    async fn validate_credentials(&self, _ctx: &AdapterContext) -> Result<(), ProviderError> {
        Ok(())
    }

    async fn list_models(&self, _ctx: &AdapterContext) -> Result<Vec<ModelInfo>, ProviderError> {
        Ok(Vec::new())
    }

    async fn stream_chat(
        &self,
        request: ProviderRequest,
        ctx: AdapterContext,
        cancel: CancellationToken,
    ) -> Result<Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>, ProviderError> {
        ScriptedAdapter(self.0.clone())
            .stream_chat(request, ctx, cancel)
            .await
    }
}

fn text_round(text: &'static str) -> Round {
    Arc::new(move |rid: &str| {
        let r = rid.to_string();
        vec![
            Step::Event(ProviderEvent::MessageStart {
                request_id: r.clone(),
                index: 0,
            }),
            Step::Event(ProviderEvent::ContentBlockStart {
                request_id: r.clone(),
                block_id: "block-0".into(),
                index: 1,
                block_kind: "text".into(),
            }),
            Step::Event(ProviderEvent::ContentDelta {
                request_id: r.clone(),
                block_id: "block-0".into(),
                index: 2,
                content: text.into(),
            }),
            Step::Event(ProviderEvent::ContentBlockStop {
                request_id: r.clone(),
                block_id: "block-0".into(),
                index: 3,
            }),
            Step::Event(ProviderEvent::MessageComplete {
                request_id: r,
                index: 4,
                finish_reason: "stop".into(),
            }),
        ]
    })
}

/// A round that calls each `(name, arguments)` tool, with `pause` between the
/// tool call starting and its arguments completing.
fn tool_round(calls: Vec<(&'static str, Value)>, pause: Duration) -> Round {
    Arc::new(move |rid: &str| {
        let r = rid.to_string();
        let mut steps = vec![Step::Event(ProviderEvent::MessageStart {
            request_id: r.clone(),
            index: 0,
        })];
        for (n, (name, arguments)) in calls.iter().enumerate() {
            let id = format!("call-{n}-{r}");
            steps.push(Step::Event(ProviderEvent::ToolCallStart {
                request_id: r.clone(),
                tool_call_id: id.clone(),
                index: 1,
                tool_id: (*name).into(),
                name: (*name).into(),
            }));
            if !pause.is_zero() {
                steps.push(Step::Pause(pause));
            }
            steps.push(Step::Event(ProviderEvent::ToolCallComplete {
                request_id: r.clone(),
                tool_call_id: id,
                index: 2,
                arguments: arguments.clone(),
            }));
        }
        steps.push(Step::Event(ProviderEvent::MessageComplete {
            request_id: r,
            index: 3,
            finish_reason: "tool_calls".into(),
        }));
        steps
    })
}

/// `round` with its closing `MessageComplete` reporting `finish_reason`.
fn finishing_with(round: Round, finish_reason: &'static str) -> Round {
    Arc::new(move |rid: &str| {
        round(rid)
            .into_iter()
            .map(|step| match step {
                Step::Event(ProviderEvent::MessageComplete {
                    request_id, index, ..
                }) => Step::Event(ProviderEvent::MessageComplete {
                    request_id,
                    index,
                    finish_reason: finish_reason.into(),
                }),
                other => other,
            })
            .collect()
    })
}

fn reasoning_round(thought: &'static str) -> Round {
    Arc::new(move |rid: &str| {
        let r = rid.to_string();
        vec![
            Step::Event(ProviderEvent::MessageStart {
                request_id: r.clone(),
                index: 0,
            }),
            Step::Event(ProviderEvent::ReasoningDelta {
                request_id: r.clone(),
                block_id: "reasoning-0".into(),
                index: 1,
                content: thought.into(),
            }),
            Step::Event(ProviderEvent::MessageComplete {
                request_id: r,
                index: 2,
                finish_reason: "stop".into(),
            }),
        ]
    })
}

// ── Harness ──────────────────────────────────────────────────────────────────

/// OpenRouter needs a stored key before a round reaches the adapter. The
/// default store is the OS keychain, so this test used to pass only on a
/// machine that happened to have a real OpenRouter key saved, and failed in CI
/// with no round started. The cloud cases now keep a fake key in a file-mode
/// store under the test's own temp directory; the keychain is never read.
///
/// The file key comes from a process-wide variable. Every caller sets the same
/// value, and nothing else in this binary uses file mode, so there is nothing
/// to restore.
fn give_the_cloud_provider_a_test_key(root: &Path) {
    use base64::{engine::general_purpose::STANDARD, Engine};
    std::env::set_var(credentials::FILE_KEY_ENV, STANDARD.encode([7u8; 32]));
    credentials::CredentialStore::default_service()
        .with_mode(KeychainMode::File)
        .with_data_dir(root)
        .save_provider_secret("openrouter", "sk-test-not-a-real-key")
        .expect("the fake key is saved");
}

fn test_paths(root: &Path) -> AppPaths {
    AppPaths {
        root: root.to_path_buf(),
        settings_file: root.join("settings.json"),
        database: root.join("conduit.sqlite"),
        attachments: root.join("attachments"),
        artifacts: root.join("artifacts"),
        logs: root.join("logs"),
        diagnostics: root.join("diagnostics"),
        updates: root.join("updates"),
        streams: root.join("streams"),
        connectors: root.join("connectors"),
        exports: root.join("exports"),
        branding: root.join("branding"),
    }
}

fn tool(name: &str, display_group: &str) -> ToolDefinition {
    ToolDefinition {
        tool_id: name.into(),
        name: name.into(),
        description: name.into(),
        input_schema: json!({ "type": "object", "properties": {} }),
        kind: None,
        host_config: None,
        permission_level: Some(PermissionLevel::SideEffectful),
        display_group: Some(display_group.into()),
        tenant_scope: None,
    }
}

struct Turn {
    events: Vec<ProviderEvent>,
    rounds_started: usize,
    requests: Vec<ProviderRequest>,
}

impl Turn {
    fn terminal(&self) -> &ProviderEvent {
        self.events
            .iter()
            .rev()
            .find(|e| {
                matches!(
                    e,
                    ProviderEvent::MessageComplete { .. } | ProviderEvent::Error { .. }
                )
            })
            .expect("the turn ends with a terminal event")
    }

    fn tool_executions(&self) -> Vec<(String, bool)> {
        self.events
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::ToolExecutionFinished {
                    tool_name,
                    is_error,
                    ..
                } => Some((tool_name.clone(), *is_error)),
                _ => None,
            })
            .collect()
    }
}

async fn run_turn(rounds: Vec<Round>, agent: AgentGuardrails) -> Turn {
    run_turn_with(rounds, agent, None, &[]).await
}

async fn run_turn_with_max_tokens(
    rounds: Vec<Round>,
    agent: AgentGuardrails,
    max_tokens: Option<u32>,
) -> Turn {
    run_turn_with(rounds, agent, max_tokens, &[]).await
}

/// Also declares `patch_document` and `read_document`.
async fn run_turn_with_patching(rounds: Vec<Round>, agent: AgentGuardrails) -> Turn {
    run_turn_with(rounds, agent, None, &["patch_document", "read_document"]).await
}

async fn run_turn_with(
    rounds: Vec<Round>,
    agent: AgentGuardrails,
    max_tokens: Option<u32>,
    extra_tools: &[&str],
) -> Turn {
    let (result, turn) = run_turn_configured(
        rounds,
        agent,
        max_tokens,
        extra_tools,
        Provider::Local,
        true,
    )
    .await;
    result.expect("turn runs");
    turn
}

#[derive(Clone, Copy)]
enum Provider {
    Local,
    Cloud,
}

async fn run_turn_configured(
    rounds: Vec<Round>,
    agent: AgentGuardrails,
    max_tokens: Option<u32>,
    extra_tools: &[&str],
    provider: Provider,
    local_only: bool,
) -> (Result<(), String>, Turn) {
    run_turn_via(
        rounds,
        agent,
        max_tokens,
        extra_tools,
        provider,
        local_only,
        Sink::Webview,
    )
    .await
}

/// How the turn's events leave `run_agent_turn`.
#[derive(Clone, Copy)]
enum Sink {
    /// A `tauri::ipc::Channel`, as the chat window passes.
    Webview,
    /// A headless `EventSink` collector, as a workflow run will pass.
    Headless,
    /// A headless sink whose listener is already gone.
    Closed,
    /// A webview `Channel` whose window is already gone.
    ClosedWebview,
}

async fn run_turn_via(
    rounds: Vec<Round>,
    agent: AgentGuardrails,
    max_tokens: Option<u32>,
    extra_tools: &[&str],
    provider: Provider,
    local_only: bool,
    sink_kind: Sink,
) -> (Result<(), String>, Turn) {
    run_turn_with_settings(
        rounds,
        agent,
        max_tokens,
        extra_tools,
        provider,
        local_only,
        sink_kind,
        |_| {},
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_turn_with_settings(
    rounds: Vec<Round>,
    agent: AgentGuardrails,
    max_tokens: Option<u32>,
    extra_tools: &[&str],
    provider: Provider,
    local_only: bool,
    sink_kind: Sink,
    tweak: fn(&mut AppSettings),
) -> (Result<(), String>, Turn) {
    let pool = common::setup_pool().await;
    let conversation = conversations::create(&pool, None).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let keychain_mode = match provider {
        Provider::Local => KeychainMode::default(),
        Provider::Cloud => {
            give_the_cloud_provider_a_test_key(dir.path());
            KeychainMode::File
        }
    };
    let mut settings = AppSettings {
        active_provider: match provider {
            Provider::Local => "ollama".into(),
            Provider::Cloud => "openrouter".into(),
        },
        active_model: "scripted".into(),
        agent,
        local_only,
        keychain_mode,
        ..AppSettings::default()
    };
    tweak(&mut settings);
    let state = AppState::test_instance_with_settings(pool, test_paths(dir.path()), settings);
    let runtime =
        ConnectorRuntimeManager::new_with(Duration::from_millis(80), Duration::from_millis(800));

    let script = Script::new(rounds);
    let resolver_script = script.clone();
    let manager = StreamManager::with_adapter_resolver(Arc::new(move |_id: &str| {
        Some(match provider {
            Provider::Local => {
                Box::new(ScriptedAdapter(resolver_script.clone())) as Box<dyn ProviderAdapter>
            }
            Provider::Cloud => Box::new(CloudScriptedAdapter(resolver_script.clone())),
        })
    }));

    let events = Arc::new(Mutex::new(Vec::<ProviderEvent>::new()));
    let sink = events.clone();
    let channel: Channel<ProviderEvent> = Channel::new(move |body| {
        let event: ProviderEvent = body.deserialize().expect("provider event");
        sink.lock().unwrap().push(event);
        Ok(())
    });
    let runtime_channel: Channel<ConnectorRuntimeEvent> = Channel::new(|_| Ok(()));

    let request = ProviderRequest {
        request_id: "turn-1".into(),
        conversation_id: conversation.id.clone(),
        model_id: "scripted".into(),
        messages: vec![Message {
            id: "user-1".into(),
            conversation_id: conversation.id.clone(),
            role: MessageRole::User,
            author_label: None,
            provider_message_id: None,
            request_id: None,
            interrupted_at: None,
            metadata: None,
            parts: vec![MessagePart {
                id: "user-1/p0".into(),
                message_id: "user-1".into(),
                index: 0,
                kind: MessagePartKind::Text,
                content: Some("make me a document".into()),
                mime_type: None,
                tool_call_id: None,
                artifact_id: None,
                attachment_id: None,
                blob_ref: None,
                metadata: None,
                created_at: "2026-09-14T00:00:00Z".into(),
            }],
            created_at: "2026-09-14T00:00:00Z".into(),
        }],
        system_prompt: None,
        developer_prompt: None,
        attachments: None,
        tool_definitions: [
            tool("write_html_document", "Documents"),
            tool("current_time", "Utilities"),
        ]
        .into_iter()
        .chain(extra_tools.iter().map(|name| tool(name, "Documents")))
        .collect(),
        generation_controls: max_tokens.map(|max_tokens| GenerationControls {
            temperature: None,
            top_p: None,
            max_tokens: Some(max_tokens),
            stop_sequences: None,
            tool_choice: None,
            reasoning_effort: None,
            parallel_tool_calls: None,
        }),
        response_format: None,
        web_search: None,
    };

    let (result, events) = match sink_kind {
        Sink::Webview => {
            let result = manager
                .run_agent_turn(&state, &runtime, request, channel, runtime_channel)
                .await
                .map(|_| ());
            (result, events.lock().unwrap().clone())
        }
        Sink::Headless => {
            let (sink, collected) = event_sink::collector::<ProviderEvent>();
            let result = manager
                .run_agent_turn(&state, &runtime, request, sink, EventSink::discard())
                .await
                .map(|_| ());
            let collected = collected.lock().unwrap().clone();
            (result, collected)
        }
        Sink::ClosedWebview => {
            let gone: Channel<ProviderEvent> = Channel::new(|_| Err(tauri::Error::WebviewNotFound));
            let result = manager
                .run_agent_turn(&state, &runtime, request, gone, runtime_channel)
                .await
                .map(|_| ());
            (result, Vec::new())
        }
        Sink::Closed => {
            let closed = EventSink::<ProviderEvent>::from_fn(|_| Err(event_sink::SinkClosed));
            let result = manager
                .run_agent_turn(&state, &runtime, request, closed, EventSink::discard())
                .await
                .map(|_| ());
            (result, Vec::new())
        }
    };
    let requests = script.requests.lock().unwrap().clone();
    (
        result,
        Turn {
            events,
            rounds_started: script.rounds_started(),
            requests,
        },
    )
}

fn guardrails(max_steps: u32, wall_clock_budget_secs: u32) -> AgentGuardrails {
    AgentGuardrails {
        max_steps,
        wall_clock_budget_secs,
        finish_after_document_write: None,
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

// Local-only mode. Requests that declare tools (the default) run through
// `run_agent_turn`; before the fix only the tool-less path checked
// `local_only`, so a cloud provider answered with local-only mode on.

#[tokio::test]
async fn local_only_refuses_a_cloud_provider_before_any_round_starts() {
    let (result, turn) = run_turn_configured(
        vec![text_round("should never be sent")],
        guardrails(4, 30),
        None,
        &[],
        Provider::Cloud,
        true,
    )
    .await;

    let error = result.expect_err("a cloud provider is refused under local_only");
    assert!(
        error.contains("local_only"),
        "error names the setting: {error}"
    );
    assert_eq!(turn.rounds_started, 0, "nothing reached the provider");
}

#[tokio::test]
async fn local_only_still_allows_a_local_provider() {
    let (result, turn) = run_turn_configured(
        vec![text_round("Hello from the local model.")],
        guardrails(4, 30),
        None,
        &[],
        Provider::Local,
        true,
    )
    .await;

    result.expect("a local provider runs under local_only");
    assert_eq!(turn.rounds_started, 1);
}

#[tokio::test]
async fn a_cloud_provider_runs_when_local_only_is_off() {
    let (result, turn) = run_turn_configured(
        vec![text_round("Hello from the cloud.")],
        guardrails(4, 30),
        None,
        &[],
        Provider::Cloud,
        false,
    )
    .await;

    result.expect("a cloud provider runs with local_only off");
    assert_eq!(turn.rounds_started, 1);
}

/// `thought` streamed as reasoning, then `round`'s events after its
/// `MessageStart`: a model that thinks, then calls a tool.
fn thinking_first(thought: &'static str, round: Round) -> Round {
    Arc::new(move |rid: &str| {
        let mut steps = round(rid);
        steps.insert(
            1,
            Step::Event(ProviderEvent::ReasoningDelta {
                request_id: rid.to_string(),
                block_id: "reasoning-0".into(),
                index: 0,
                content: thought.into(),
            }),
        );
        steps
    })
}

/// DeepSeek rejects a tool round whose earlier assistant message comes back
/// without its reasoning (HTTP 400). The continuation must carry the round's
/// reasoning as a reasoning part — the adapter decides whether to send it —
/// and must never fold it into the visible text.
#[tokio::test]
async fn a_tool_round_carries_its_reasoning_into_the_continuation() {
    let turn = run_turn(
        vec![
            thinking_first(
                "The user wants the time; call current_time.",
                tool_round(vec![("current_time", json!({}))], Duration::ZERO),
            ),
            text_round("It is noon."),
        ],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 2);
    let continuation = &turn.requests[1];
    let assistant = continuation
        .messages
        .iter()
        .rev()
        .find(|m| m.role == MessageRole::Assistant)
        .expect("the continuation replays the assistant's tool round");
    let parts_of = |kind: MessagePartKind| -> Vec<&str> {
        assistant
            .parts
            .iter()
            .filter(|p| p.kind == kind)
            .filter_map(|p| p.content.as_deref())
            .collect()
    };
    assert_eq!(
        parts_of(MessagePartKind::Reasoning),
        vec!["The user wants the time; call current_time."]
    );
    assert!(
        parts_of(MessagePartKind::Text)
            .iter()
            .all(|t| !t.contains("call current_time")),
        "reasoning must not be replayed as text"
    );
    assert_eq!(parts_of(MessagePartKind::ToolCall).len(), 1);
}

#[tokio::test]
async fn a_tool_round_runs_the_tool_then_one_continuation() {
    let turn = run_turn(
        vec![
            tool_round(vec![("current_time", json!({}))], Duration::ZERO),
            text_round("It is noon."),
        ],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 2);
    assert_eq!(
        turn.tool_executions(),
        vec![("current_time".to_string(), false)]
    );
    assert!(
        matches!(turn.terminal(), ProviderEvent::MessageComplete { finish_reason, .. } if finish_reason == "stop"),
        "got {:?}",
        turn.terminal()
    );
}

#[tokio::test]
async fn a_round_still_streaming_at_the_time_limit_finishes_but_no_new_round_starts() {
    // Limit 1s; the round keeps streaming for 1.5s before its tool call completes.
    let turn = run_turn(
        vec![
            tool_round(
                vec![("current_time", json!({}))],
                Duration::from_millis(1500),
            ),
            text_round("never requested"),
        ],
        guardrails(25, 1),
    )
    .await;

    assert_eq!(turn.rounds_started, 1, "no round may start after the limit");
    assert_eq!(
        turn.tool_executions(),
        vec![("current_time".to_string(), false)],
        "the round in flight finishes, tools included"
    );
    assert!(
        matches!(turn.terminal(), ProviderEvent::Error { error, .. } if error.message.contains("time limit")),
        "got {:?}",
        turn.terminal()
    );
}

#[tokio::test]
async fn a_round_calling_only_undeclared_tools_reports_an_empty_turn() {
    let turn = run_turn(
        vec![tool_round(
            vec![("not_a_declared_tool", json!({}))],
            Duration::ZERO,
        )],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 1);
    assert!(turn.tool_executions().is_empty());
    assert!(
        matches!(turn.terminal(), ProviderEvent::Error { .. }),
        "got {:?}",
        turn.terminal()
    );
}

#[tokio::test]
async fn running_out_of_steps_with_tools_pending_is_an_error() {
    let turn = run_turn(
        vec![tool_round(
            vec![("current_time", json!({}))],
            Duration::ZERO,
        )],
        guardrails(1, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 1);
    assert!(
        matches!(turn.terminal(), ProviderEvent::Error { error, .. } if error.message.contains("max steps")),
        "got {:?}",
        turn.terminal()
    );
}

// ── Finishing after a document write ─────────────────────────────────────────

fn write_page(title: &str) -> (&'static str, Value) {
    (
        "write_html_document",
        json!({ "title": title, "html": "<!doctype html><h1>Planets</h1>" }),
    )
}

#[tokio::test]
async fn a_round_that_only_writes_a_document_ends_the_turn() {
    let turn = run_turn(
        vec![
            tool_round(vec![write_page("Solar System Field Guide")], Duration::ZERO),
            text_round("never requested"),
        ],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(
        turn.rounds_started, 1,
        "no confirmation round after a successful write"
    );
    assert_eq!(
        turn.tool_executions(),
        vec![("write_html_document".to_string(), false)]
    );
    assert!(
        matches!(turn.terminal(), ProviderEvent::MessageComplete { finish_reason, .. } if finish_reason == "stop"),
        "got {:?}",
        turn.terminal()
    );
}

#[tokio::test]
async fn a_document_write_alongside_another_tool_still_continues() {
    let turn = run_turn(
        vec![
            tool_round(
                vec![write_page("Guide"), ("current_time", json!({}))],
                Duration::ZERO,
            ),
            text_round("Written, and it is noon."),
        ],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 2);
}

#[tokio::test]
async fn a_failed_document_write_gives_the_model_another_round() {
    // No `html`: the tool rejects the arguments.
    let turn = run_turn(
        vec![
            tool_round(
                vec![("write_html_document", json!({ "title": "Broken" }))],
                Duration::ZERO,
            ),
            text_round("Sorry, retrying."),
        ],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 2);
    assert_eq!(
        turn.tool_executions(),
        vec![("write_html_document".to_string(), true)]
    );
}

#[tokio::test]
async fn the_setting_off_keeps_the_confirmation_round() {
    let turn = run_turn(
        vec![
            tool_round(vec![write_page("Guide")], Duration::ZERO),
            text_round("I wrote your guide."),
        ],
        AgentGuardrails {
            finish_after_document_write: Some(false),
            ..guardrails(25, 300)
        },
    )
    .await;

    assert_eq!(turn.rounds_started, 2);
}

// ── Output limit ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn a_document_cut_off_by_the_output_limit_ends_the_turn_with_a_clear_error() {
    // What an adapter hands over when the stream stopped mid-argument.
    let cut_off = json!({ "raw": "{\"title\": \"Q3 report\", \"html\": \"<!doctype html><h1>Q3" });
    let turn = run_turn(
        vec![
            finishing_with(
                tool_round(vec![("write_html_document", cut_off)], Duration::ZERO),
                "length",
            ),
            text_round("never requested"),
        ],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 1, "retrying would hit the same limit");
    assert_eq!(
        turn.tool_executions(),
        vec![("write_html_document".to_string(), true)],
        "the call is reported as not run, never executed"
    );
    assert!(
        matches!(
            turn.terminal(),
            ProviderEvent::Error { error, .. }
                if error.provider_code.as_deref() == Some("output_limit")
                    && error.message.contains("“Q3 report”")
                    && error.message.contains("not saved")
        ),
        "got {:?}",
        turn.terminal()
    );
}

#[tokio::test]
async fn a_round_that_reasons_until_the_limit_is_retried_once_with_less_thinking() {
    let turn = run_turn(
        vec![
            finishing_with(reasoning_round("Let me think…"), "length"),
            text_round("Here is the answer."),
        ],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 2);
    assert_eq!(
        turn.requests[1]
            .generation_controls
            .as_ref()
            .and_then(|c| c.reasoning_effort),
        Some(provider_core::schema::ReasoningEffort::Low),
        "the retry asks for less reasoning"
    );
    assert!(turn.events.iter().any(|e| matches!(
        e,
        ProviderEvent::AgentPhase { label, .. } if label == "Retrying with less thinking"
    )));
    assert!(
        matches!(turn.terminal(), ProviderEvent::MessageComplete { finish_reason, .. } if finish_reason == "stop"),
        "got {:?}",
        turn.terminal()
    );
}

#[tokio::test]
async fn reasoning_through_the_limit_twice_reports_it_instead_of_a_blank_answer() {
    let turn = run_turn(
        vec![
            finishing_with(reasoning_round("Let me think…"), "length"),
            finishing_with(reasoning_round("Still thinking…"), "length"),
            text_round("never requested"),
        ],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 2);
    assert!(
        matches!(
            turn.terminal(),
            ProviderEvent::Error { error, .. }
                if error.provider_code.as_deref() == Some("output_limit_reasoning")
                    && error.message.contains("even when asked to think less")
        ),
        "got {:?}",
        turn.terminal()
    );
}

#[tokio::test]
async fn a_text_answer_cut_off_by_the_limit_completes_as_length() {
    let turn = run_turn(
        vec![finishing_with(text_round("The report covers"), "length")],
        guardrails(25, 300),
    )
    .await;

    assert!(
        matches!(turn.terminal(), ProviderEvent::MessageComplete { finish_reason, .. } if finish_reason == "length"),
        "got {:?}",
        turn.terminal()
    );
}

#[tokio::test]
async fn tool_calls_that_completed_before_the_limit_still_run() {
    let turn = run_turn(
        vec![
            finishing_with(
                tool_round(vec![("current_time", json!({}))], Duration::ZERO),
                "length",
            ),
            text_round("It is noon."),
        ],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 2);
    assert_eq!(
        turn.tool_executions(),
        vec![("current_time".to_string(), false)]
    );
}

#[test]
fn the_cut_off_message_names_the_limit_and_the_document() {
    use conduit_desktop::stream_manager::{output_limit_cut_off_message, CompletedToolCall};

    let call = |name: &str, raw: &str| CompletedToolCall {
        tool_call_id: "call-1".into(),
        tool_id: Some(name.into()),
        name: name.into(),
        arguments: json!({ "raw": raw }),
    };

    let message = output_limit_cut_off_message(
        &call(
            "write_html_document",
            r#"{"title": "The \"Big\" Plan", "html": "<p>"#,
        ),
        Some(64_000),
    );
    assert!(
        message.contains("output limit (64,000 tokens)"),
        "{message}"
    );
    assert!(message.contains("“The \"Big\" Plan”"), "{message}");

    let message = output_limit_cut_off_message(&call("write_html_document", r#"{"ht"#), None);
    assert!(message.contains("while writing the document"), "{message}");
    assert!(!message.contains("tokens)"), "{message}");

    let message = output_limit_cut_off_message(&call("current_time", r#"{"zone": "#), Some(900));
    assert!(message.contains("input for current_time"), "{message}");
}

/// `round` with a `Usage` event reporting `output_tokens` before it completes.
fn using_output_tokens(round: Round, output_tokens: u64) -> Round {
    Arc::new(move |rid: &str| {
        let mut steps = round(rid);
        let at = steps.len().saturating_sub(1);
        steps.insert(
            at,
            Step::Event(ProviderEvent::Usage {
                request_id: rid.to_string(),
                usage: provider_core::schema::ProviderUsage {
                    input_tokens: Some(2_720),
                    output_tokens: Some(output_tokens),
                    cache_tokens: None,
                    cache_read_tokens: None,
                    cache_write_tokens: None,
                    cost_hint: None,
                },
            }),
        );
        steps
    })
}

#[tokio::test]
async fn output_at_the_limit_counts_as_cut_off_even_when_the_provider_says_stop() {
    // Recorded live: OpenRouter serving GLM ended each round with `stop` after
    // exactly max_tokens of output, the write's arguments cut off mid-HTML.
    let cut_off = json!({ "raw": "{\"title\": \"Solar System\", \"html\": \"<h2>Jupiter</h2><table><tr><th colspan=" });
    let turn = run_turn_with_max_tokens(
        vec![
            using_output_tokens(
                finishing_with(
                    tool_round(vec![("write_html_document", cut_off)], Duration::ZERO),
                    "stop",
                ),
                3_000,
            ),
            text_round("never requested"),
        ],
        guardrails(25, 300),
        Some(3_000),
    )
    .await;

    assert_eq!(turn.rounds_started, 1);
    assert_eq!(
        turn.tool_executions(),
        vec![("write_html_document".to_string(), true)]
    );
    assert!(
        matches!(
            turn.terminal(),
            ProviderEvent::Error { error, .. }
                if error.message.contains("output limit (3,000 tokens)")
                    && error.message.contains("“Solar System”")
        ),
        "got {:?}",
        turn.terminal()
    );
}

#[tokio::test]
async fn output_below_the_limit_with_a_stop_is_not_cut_off() {
    let turn = run_turn_with_max_tokens(
        vec![using_output_tokens(text_round("Short answer."), 120)],
        guardrails(25, 300),
        Some(3_000),
    )
    .await;

    assert!(
        matches!(turn.terminal(), ProviderEvent::MessageComplete { finish_reason, .. } if finish_reason == "stop"),
        "got {:?}",
        turn.terminal()
    );
}

#[tokio::test]
async fn arguments_that_stop_mid_json_count_as_cut_off_without_any_limit_signal() {
    // No length stop, no token count, no known limit: only the arguments show it.
    let cut_off = json!({ "raw": "{\"title\": \"Solar System\", \"html\": \"<h2>Jupiter</h2><p>The largest" });
    let turn = run_turn(
        vec![
            tool_round(vec![("write_html_document", cut_off)], Duration::ZERO),
            text_round("never requested"),
        ],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 1);
    assert!(
        matches!(
            turn.terminal(),
            ProviderEvent::Error { error, .. }
                if error.message.contains("reached its output limit while writing “Solar System”")
        ),
        "got {:?}",
        turn.terminal()
    );
}

#[tokio::test]
async fn complete_but_malformed_arguments_still_reach_the_tool() {
    // Finished JSON the model got wrong is the tool's to report, and the model
    // gets another round to fix it.
    let malformed = json!({ "raw": "{\"title\": \"Guide\", html: \"<p>hi</p>\"}" });
    let turn = run_turn(
        vec![
            tool_round(vec![("write_html_document", malformed)], Duration::ZERO),
            text_round("Fixed it."),
        ],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 2);
    assert_eq!(
        turn.tool_executions(),
        vec![("write_html_document".to_string(), true)]
    );
}

// ── Building a document in parts ─────────────────────────────────────────────

fn request_mentions(request: &ProviderRequest, needle: &str) -> bool {
    request
        .messages
        .iter()
        .flat_map(|m| m.parts.iter())
        .any(|p| p.content.as_deref().is_some_and(|c| c.contains(needle)))
}

#[tokio::test]
async fn a_cut_off_document_asks_the_model_to_write_it_in_parts_once() {
    let cut_off = json!({ "raw": "{\"title\": \"Solar System\", \"html\": \"<h2>Jupiter" });
    let turn = run_turn_with_patching(
        vec![
            finishing_with(
                tool_round(vec![("write_html_document", cut_off)], Duration::ZERO),
                "length",
            ),
            text_round("Writing it in parts."),
        ],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 2, "the model gets a round to recover");
    assert_eq!(
        turn.tool_executions(),
        vec![("write_html_document".to_string(), true)]
    );
    assert!(
        request_mentions(&turn.requests[1], "Write the document in parts"),
        "the continuation must carry the recovery instructions"
    );
    assert!(
        matches!(turn.terminal(), ProviderEvent::MessageComplete { .. }),
        "got {:?}",
        turn.terminal()
    );
}

#[tokio::test]
async fn a_second_cut_off_in_the_same_turn_ends_it() {
    let cut_off = || json!({ "raw": "{\"title\": \"Solar System\", \"html\": \"<h2>Jupiter" });
    let turn = run_turn_with_patching(
        vec![
            finishing_with(
                tool_round(vec![("write_html_document", cut_off())], Duration::ZERO),
                "length",
            ),
            finishing_with(
                tool_round(vec![("write_html_document", cut_off())], Duration::ZERO),
                "length",
            ),
            text_round("never requested"),
        ],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 2);
    assert!(
        matches!(
            turn.terminal(),
            ProviderEvent::Error { error, .. } if error.provider_code.as_deref() == Some("output_limit")
        ),
        "got {:?}",
        turn.terminal()
    );
}

#[tokio::test]
async fn more_to_write_keeps_the_turn_going_after_a_document_write() {
    let skeleton = json!({
        "title": "Solar System",
        "html": "<main><!-- section: mercury --></main>",
        "more_to_write": true
    });
    let turn = run_turn_with_patching(
        vec![
            tool_round(vec![("write_html_document", skeleton)], Duration::ZERO),
            text_round("Filling in the sections."),
        ],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 2);
    assert_eq!(
        turn.tool_executions(),
        vec![("write_html_document".to_string(), false)]
    );
}

// ── Progress-aware time limit ────────────────────────────────────────────────

#[test]
fn saved_progress_extends_the_deadline_up_to_the_ceiling() {
    use conduit_desktop::stream_manager::TurnDeadline;
    let start = tokio::time::Instant::now();
    let window = Duration::from_secs(100);
    let mut deadline = TurnDeadline::new(start, window);

    assert!(!deadline.expired(start + Duration::from_secs(99)));
    assert!(deadline.expired(start + Duration::from_secs(101)));

    // Progress at 90s: one more window from then.
    deadline.record_progress(start + Duration::from_secs(90));
    assert!(!deadline.expired(start + Duration::from_secs(189)));
    assert!(deadline.expired(start + Duration::from_secs(191)));

    // Progress late in the turn is capped at three windows in total.
    deadline.record_progress(start + Duration::from_secs(280));
    assert!(!deadline.expired(start + Duration::from_secs(299)));
    assert!(deadline.expired(start + Duration::from_secs(301)));

    // Earlier progress never pulls the deadline in.
    deadline.record_progress(start + Duration::from_secs(10));
    assert!(!deadline.expired(start + Duration::from_secs(299)));
}

#[test]
fn time_waiting_for_the_user_extends_the_deadline_and_the_ceiling() {
    use conduit_desktop::stream_manager::TurnDeadline;
    let start = tokio::time::Instant::now();
    let mut deadline = TurnDeadline::new(start, Duration::from_secs(100));

    // A nine-minute approval wait does not count against the 100s limit.
    deadline.pause(Duration::from_secs(540));
    assert!(!deadline.expired(start + Duration::from_secs(639)));
    assert!(deadline.expired(start + Duration::from_secs(641)));

    // The progress ceiling moves out by the same amount: progress at 600s
    // buys a full window (ceiling would have been 300s unpaused).
    deadline.record_progress(start + Duration::from_secs(600));
    assert!(!deadline.expired(start + Duration::from_secs(699)));
    assert!(deadline.expired(start + Duration::from_secs(701)));
}

#[tokio::test]
async fn a_build_in_parts_gets_more_time_and_stops_with_a_continue_code() {
    // Limit 1s. Round 1 saves a skeleton after 1.5s — progress, so the turn
    // may run until 2.5s. Round 2 runs a tool for 1.2s, saves nothing, and the
    // limit hits before round 3 while the document is still being built.
    let skeleton = json!({
        "title": "Solar System",
        "html": "<main><!-- section: mercury --></main>",
        "more_to_write": true
    });
    let turn = run_turn_with_patching(
        vec![
            tool_round(
                vec![("write_html_document", skeleton)],
                Duration::from_millis(1500),
            ),
            tool_round(
                vec![("current_time", json!({}))],
                Duration::from_millis(1200),
            ),
            text_round("never requested"),
        ],
        guardrails(25, 1),
    )
    .await;

    assert_eq!(turn.rounds_started, 2, "progress bought the second round");
    assert!(
        matches!(
            turn.terminal(),
            ProviderEvent::Error { error, .. }
                if error.provider_code.as_deref() == Some("turn_time_limit_building")
                    && error.message.contains("saved as far as it got")
        ),
        "got {:?}",
        turn.terminal()
    );
}

// ── Idle timeout while a document is written in one piece ───────────────────

/// A round that starts a document write and then fails with `message`, the way
/// OpenRouter ends a stream that stayed silent too long.
fn stalled_write_round(message: &'static str) -> Round {
    Arc::new(move |rid: &str| {
        let r = rid.to_string();
        vec![
            Step::Event(ProviderEvent::MessageStart {
                request_id: r.clone(),
                index: 0,
            }),
            Step::Event(ProviderEvent::ToolCallStart {
                request_id: r.clone(),
                tool_call_id: format!("stalled-{r}"),
                index: 1,
                tool_id: "write_html_document".into(),
                name: "write_html_document".into(),
            }),
            Step::Event(ProviderEvent::Error {
                request_id: r,
                error: ProviderError {
                    provider_code: None,
                    retryable: false,
                    message: message.into(),
                },
            }),
        ]
    })
}

fn errors(turn: &Turn) -> Vec<&ProviderError> {
    turn.events
        .iter()
        .filter_map(|e| match e {
            ProviderEvent::Error { error, .. } => Some(error),
            _ => None,
        })
        .collect()
}

#[tokio::test]
async fn an_idle_timeout_on_a_document_turn_retries_once_in_parts() {
    let turn = run_turn_with_patching(
        vec![
            stalled_write_round("Upstream idle timeout exceeded"),
            text_round("Writing it in parts."),
        ],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 2);
    assert!(
        turn.requests[1]
            .developer_prompt
            .as_deref()
            .is_some_and(|p| p.contains("Write the document in parts")),
        "the retry asks for parts"
    );
    assert!(
        errors(&turn).is_empty(),
        "the retried error never reaches the UI"
    );
    assert_eq!(
        turn.tool_executions(),
        vec![("write_html_document".to_string(), true)],
        "the half-received call is closed as failed"
    );
    assert!(turn.events.iter().any(|e| matches!(
        e,
        ProviderEvent::AgentPhase { label, .. } if label == "Retrying in parts"
    )));
    assert!(
        matches!(turn.terminal(), ProviderEvent::MessageComplete { .. }),
        "got {:?}",
        turn.terminal()
    );
}

#[tokio::test]
async fn a_second_idle_timeout_ends_the_turn_with_one_clear_error() {
    let turn = run_turn_with_patching(
        vec![
            stalled_write_round("Upstream idle timeout exceeded"),
            stalled_write_round(
                "the provider sent nothing for 120s and the connection was still open",
            ),
            text_round("never requested"),
        ],
        guardrails(25, 300),
    )
    .await;

    assert_eq!(turn.rounds_started, 2);
    let errors = errors(&turn);
    assert_eq!(errors.len(), 1, "exactly one terminal error: {errors:?}");
    assert_eq!(errors[0].provider_code.as_deref(), Some("idle_timeout"));
    assert!(
        errors[0].message.contains("stopped waiting"),
        "{}",
        errors[0].message
    );
}

#[tokio::test]
async fn other_round_errors_still_end_the_turn_as_they_were() {
    let turn = run_turn(
        vec![
            stalled_write_round("Upstream idle timeout exceeded"),
            text_round("never requested"),
        ],
        guardrails(25, 300),
    )
    .await;

    // No patch_document on offer: nothing to retry in parts.
    assert_eq!(turn.rounds_started, 1);
    let errors = errors(&turn);
    assert_eq!(errors.len(), 1);
    assert_eq!(errors[0].message, "Upstream idle timeout exceeded");
}

// ── Round-3 live findings ────────────────────────────────────────────────────

/// Live: "make the tiles bigger and add a search box" read a 15 kB page 26
/// times and never edited it. Past three reads of one document in a turn, a
/// read is answered — the model already has the content — instead of run.
#[tokio::test]
async fn reading_one_document_over_and_over_is_answered_not_run() {
    let read = || {
        tool_round(
            vec![("read_document", json!({ "artifact_id": "doc-1" }))],
            Duration::ZERO,
        )
    };
    let turn = run_turn_with_patching(
        vec![read(), read(), read(), read(), read(), text_round("done")],
        guardrails(25, 300),
    )
    .await;

    let told = |request: &ProviderRequest| {
        request.messages.iter().any(|m| {
            m.parts.iter().any(|p| {
                p.content
                    .as_deref()
                    .is_some_and(|c| c.contains("already read this document"))
            })
        })
    };
    // Rounds 1-4 carry the results of reads 1-3; the fourth read's answer is
    // the first the model sees in round 5.
    assert!(
        !turn.requests[..4].iter().any(told),
        "reads 1-3 ran normally"
    );
    assert!(told(&turn.requests[4]), "read 4 was answered, not run");
}

/// Live: "tic tac toe" promised a game, then called
/// `werkzeug\n</think><tool_call>current_time`, and the turn ended silently.
#[tokio::test]
async fn a_round_ending_on_a_malformed_tool_name_says_so() {
    let turn = run_turn(
        vec![tool_round(
            vec![("werkzeug\n</think><tool_call>current_time", json!({}))],
            Duration::ZERO,
        )],
        guardrails(25, 300),
    )
    .await;

    assert!(
        matches!(turn.terminal(), ProviderEvent::Error { error, .. } if error.message.contains("malformed tool call")),
        "got {:?}",
        turn.terminal()
    );
}

/// The same event with its per-run values (ids, timestamps, durations) blanked,
/// so two runs of one script can be compared.
fn comparable(event: &ProviderEvent) -> Value {
    fn blank(value: &mut Value) {
        match value {
            Value::Object(map) => {
                for (key, v) in map.iter_mut() {
                    let per_run = key == "id"
                        || key.ends_with("Id")
                        || key.ends_with("At")
                        || key.ends_with("Ms");
                    if per_run {
                        *v = Value::Null;
                    } else {
                        blank(v);
                    }
                }
            }
            Value::Array(items) => items.iter_mut().for_each(blank),
            _ => {}
        }
    }
    let mut value = serde_json::to_value(event).expect("event serializes");
    blank(&mut value);
    value
}

#[tokio::test]
async fn a_headless_sink_sees_exactly_what_the_webview_sees() {
    let script = || {
        vec![
            tool_round(vec![("current_time", json!({}))], Duration::ZERO),
            text_round("It is noon."),
        ]
    };
    let (webview_result, webview) = run_turn_via(
        script(),
        guardrails(25, 300),
        None,
        &[],
        Provider::Local,
        true,
        Sink::Webview,
    )
    .await;
    let (headless_result, headless) = run_turn_via(
        script(),
        guardrails(25, 300),
        None,
        &[],
        Provider::Local,
        true,
        Sink::Headless,
    )
    .await;
    webview_result.expect("webview turn runs");
    headless_result.expect("headless turn runs");

    assert!(!webview.events.is_empty());
    assert_eq!(
        webview.events.iter().map(comparable).collect::<Vec<_>>(),
        headless.events.iter().map(comparable).collect::<Vec<_>>(),
    );
    assert_eq!(webview.rounds_started, headless.rounds_started);
    assert_eq!(
        headless.tool_executions(),
        vec![("current_time".to_string(), false)]
    );
}

#[tokio::test]
async fn a_closed_headless_sink_behaves_like_a_closed_window() {
    let script = || {
        vec![
            tool_round(vec![("current_time", json!({}))], Duration::ZERO),
            text_round("never reached"),
        ]
    };
    let run = |sink| {
        run_turn_via(
            script(),
            guardrails(25, 300),
            None,
            &[],
            Provider::Local,
            true,
            sink,
        )
    };
    let (_, webview) = run(Sink::ClosedWebview).await;
    let (_, headless) = run(Sink::Closed).await;
    assert_eq!(headless.rounds_started, webview.rounds_started);
    // Once nobody is listening, no further round (and no further provider
    // request) starts. It used to run until `max_steps`: 25 requests here.
    assert_eq!(webview.rounds_started, 1);
}

// ── Web search caps ──────────────────────────────────────────────────────────

/// A round that says `text` and then calls each `(name, arguments)` tool — the
/// shape of "Let me grab rental rates…" followed by two more searches.
fn text_then_tools_round(text: &'static str, calls: Vec<(&'static str, Value)>) -> Round {
    let tools = tool_round(calls, Duration::ZERO);
    Arc::new(move |rid: &str| {
        let r = rid.to_string();
        let mut steps = vec![
            Step::Event(ProviderEvent::MessageStart {
                request_id: r.clone(),
                index: 0,
            }),
            Step::Event(ProviderEvent::ContentBlockStart {
                request_id: r.clone(),
                block_id: "block-0".into(),
                index: 1,
                block_kind: "text".into(),
            }),
            Step::Event(ProviderEvent::ContentDelta {
                request_id: r.clone(),
                block_id: "block-0".into(),
                index: 2,
                content: text.into(),
            }),
            Step::Event(ProviderEvent::ContentBlockStop {
                request_id: r.clone(),
                block_id: "block-0".into(),
                index: 3,
            }),
        ];
        // The tool round minus its own MessageStart.
        steps.extend(tools(rid).into_iter().skip(1));
        steps
    })
}

fn searches(n: usize) -> Vec<(&'static str, Value)> {
    (0..n)
        .map(|i| ("web_search", json!({ "query": format!("query {i}") })))
        .collect()
}

/// SearXNG on a closed loopback port: every search fails at once, with no
/// network, and still counts toward the per-turn cap like a real one.
fn unreachable_searxng(settings: &mut AppSettings) {
    settings.web_search_enabled = true;
    settings.web_search.local_backend = provider_core::schema::LocalSearchBackend::Searxng;
    settings.web_search.searxng_base_url = Some("http://127.0.0.1:9".into());
}

async fn run_search_turn(rounds: Vec<Round>) -> Turn {
    let (result, turn) = run_turn_with_settings(
        rounds,
        guardrails(25, 300),
        None,
        &["web_search"],
        Provider::Cloud,
        false,
        Sink::Webview,
        unreachable_searxng,
    )
    .await;
    result.expect("turn runs");
    turn
}

fn declares_web_search(request: &ProviderRequest) -> bool {
    request
        .tool_definitions
        .iter()
        .any(|t| t.name == "web_search")
}

#[tokio::test]
async fn a_search_past_the_cap_is_refused_and_the_model_still_answers() {
    use conduit_desktop::stream_manager::MAX_WEB_SEARCH_PER_TURN_FULL;
    let cap = MAX_WEB_SEARCH_PER_TURN_FULL as usize;
    let turn = run_search_turn(vec![
        tool_round(searches(cap + 1), Duration::ZERO),
        text_then_tools_round("Let me grab rental rates.", searches(2)),
        text_round("Here is the comparison."),
    ])
    .await;

    // It used to end after the second round: web_search was removed from the
    // tools, its two calls were dropped as undeclared, and the round's one
    // sentence was taken as the answer.
    assert_eq!(turn.rounds_started, 3);
    assert!(
        matches!(turn.terminal(), ProviderEvent::MessageComplete { .. }),
        "{:?}",
        turn.terminal()
    );
    assert!(turn.requests.iter().all(declares_web_search));
    let searches_finished = turn
        .tool_executions()
        .into_iter()
        .filter(|(name, _)| name == "web_search")
        .count();
    assert_eq!(searches_finished, cap + 1 + 2, "every call gets an answer");
}

#[tokio::test]
async fn a_model_that_keeps_searching_past_the_cap_gets_a_visible_error() {
    use conduit_desktop::stream_manager::MAX_WEB_SEARCH_PER_TURN_FULL;
    let cap = MAX_WEB_SEARCH_PER_TURN_FULL as usize;
    let turn = run_search_turn(vec![
        tool_round(searches(cap), Duration::ZERO),
        text_then_tools_round("One more.", searches(1)),
        text_then_tools_round("And another.", searches(1)),
        text_round("never reached"),
    ])
    .await;

    assert_eq!(turn.rounds_started, 3);
    match turn.terminal() {
        ProviderEvent::Error { error, .. } => {
            assert!(
                error.message.contains("kept asking to search"),
                "{}",
                error.message
            );
            assert!(error.retryable);
        }
        other => panic!("expected an error, got {other:?}"),
    }
}
