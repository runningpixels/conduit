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
    connector_runtime::ConnectorRuntimeManager, db::repository::conversations, paths::AppPaths,
    state::AppState, stream_manager::StreamManager,
};
use futures::stream::{Stream, StreamExt};
use provider_core::schema::{
    AgentGuardrails, AppSettings, ConnectorRuntimeEvent, Message, MessagePart, MessagePartKind,
    MessageRole, PermissionLevel, ProviderError, ProviderEvent, ProviderRequest, ToolDefinition,
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

// ── Harness ──────────────────────────────────────────────────────────────────

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
        themes: root.join("themes"),
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
    let pool = common::setup_pool().await;
    let conversation = conversations::create(&pool, None).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let settings = AppSettings {
        active_provider: "ollama".into(),
        active_model: "scripted".into(),
        agent,
        ..AppSettings::default()
    };
    let state = AppState::test_instance_with_settings(pool, test_paths(dir.path()), settings);
    let runtime =
        ConnectorRuntimeManager::new_with(Duration::from_millis(80), Duration::from_millis(800));

    let script = Script::new(rounds);
    let resolver_script = script.clone();
    let manager = StreamManager::with_adapter_resolver(Arc::new(move |_id: &str| {
        Some(Box::new(ScriptedAdapter(resolver_script.clone())) as Box<dyn ProviderAdapter>)
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
        tool_definitions: vec![
            tool("write_html_document", "Documents"),
            tool("current_time", "Utilities"),
        ],
        generation_controls: None,
        response_format: None,
        web_search: None,
    };

    manager
        .run_agent_turn(&state, &runtime, request, channel, runtime_channel)
        .await
        .expect("turn runs");

    let events = events.lock().unwrap().clone();
    Turn {
        events,
        rounds_started: script.rounds_started(),
    }
}

fn guardrails(max_steps: u32, wall_clock_budget_secs: u32) -> AgentGuardrails {
    AgentGuardrails {
        max_steps,
        wall_clock_budget_secs,
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

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
