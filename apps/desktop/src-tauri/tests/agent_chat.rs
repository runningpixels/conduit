//! Chat turns that run as one of the user's agents (`@Researcher ...`) or hand
//! work to them (`ask_<id>`): `agents::handoff`, the `agent_calls` table, and
//! the settings that choose the agents the assistant may ask.
//!
//! The loop runs for real against a scripted provider: each request the
//! provider receives (the lead's, then a helper's, then the lead's again) plays
//! the next scripted round.

mod common;

use std::pin::Pin;
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use conduit_desktop::{
    agents::{
        handoff::{self, CEILING_MESSAGE},
        library,
    },
    connector_runtime::ConnectorRuntimeManager,
    db::repository::{agent_calls, conversations, event_log},
    event_sink::{self, EventSink},
    paths::AppPaths,
    state::AppState,
    stream_manager::{StreamManager, TurnOptions},
    workflows::definition::AgentDef,
};
use futures::stream::{Stream, StreamExt};
use provider_core::schema::{
    AgentGuardrails, AppSettings, HandoffTokens, Message, MessagePart, MessagePartKind,
    MessageRole, PermissionLevel, ProviderError, ProviderEvent, ProviderRequest, ProviderUsage,
    ToolDefinition,
};
use provider_core::{AdapterContext, ModelInfo, ProviderAdapter};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

// ── Scripted provider ────────────────────────────────────────────────────────

type Round = Arc<dyn Fn(&str) -> Vec<ProviderEvent> + Send + Sync>;

#[derive(Clone)]
struct Script {
    rounds: Arc<Vec<Round>>,
    requests: Arc<Mutex<Vec<ProviderRequest>>>,
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
        let events = match self.0.rounds.get(index) {
            Some(round) => round(&request.request_id),
            None => text_round("(script exhausted)")(&request.request_id),
        };
        Ok(Box::pin(
            futures::stream::iter(events).then(|e| async move { e }),
        ))
    }
}

fn text_round(text: &'static str) -> Round {
    text_round_using(text, 0)
}

/// An answer that reports `tokens` input tokens.
fn text_round_using(text: &'static str, tokens: u64) -> Round {
    Arc::new(move |rid: &str| {
        let r = rid.to_string();
        let mut events = vec![
            ProviderEvent::MessageStart {
                request_id: r.clone(),
                index: 0,
            },
            ProviderEvent::ContentBlockStart {
                request_id: r.clone(),
                block_id: "block-0".into(),
                index: 1,
                block_kind: "text".into(),
            },
            ProviderEvent::ContentDelta {
                request_id: r.clone(),
                block_id: "block-0".into(),
                index: 2,
                content: text.into(),
            },
            ProviderEvent::ContentBlockStop {
                request_id: r.clone(),
                block_id: "block-0".into(),
                index: 3,
            },
        ];
        if tokens > 0 {
            events.push(ProviderEvent::Usage {
                request_id: r.clone(),
                usage: ProviderUsage {
                    input_tokens: Some(tokens),
                    output_tokens: Some(0),
                    cache_tokens: None,
                    cache_read_tokens: None,
                    cache_write_tokens: None,
                    cost_hint: None,
                },
            });
        }
        events.push(ProviderEvent::MessageComplete {
            request_id: r,
            index: 4,
            finish_reason: "stop".into(),
        });
        events
    })
}

/// `round`, reporting `tokens` input tokens just before it ends.
fn using(round: Round, tokens: u64) -> Round {
    Arc::new(move |rid: &str| {
        let mut events = round(rid);
        let at = events.len() - 1;
        events.insert(
            at,
            ProviderEvent::Usage {
                request_id: rid.to_string(),
                usage: ProviderUsage {
                    input_tokens: Some(tokens),
                    output_tokens: Some(0),
                    cache_tokens: None,
                    cache_read_tokens: None,
                    cache_write_tokens: None,
                    cost_hint: None,
                },
            },
        );
        events
    })
}

fn tool_round(calls: Vec<(&'static str, Value)>) -> Round {
    Arc::new(move |rid: &str| {
        let r = rid.to_string();
        let mut events = vec![ProviderEvent::MessageStart {
            request_id: r.clone(),
            index: 0,
        }];
        for (n, (name, arguments)) in calls.iter().enumerate() {
            let id = format!("call-{n}-{r}");
            events.push(ProviderEvent::ToolCallStart {
                request_id: r.clone(),
                tool_call_id: id.clone(),
                index: 1,
                tool_id: (*name).into(),
                name: (*name).into(),
            });
            events.push(ProviderEvent::ToolCallComplete {
                request_id: r.clone(),
                tool_call_id: id,
                index: 2,
                arguments: arguments.clone(),
            });
        }
        events.push(ProviderEvent::MessageComplete {
            request_id: r,
            index: 3,
            finish_reason: "tool_calls".into(),
        });
        events
    })
}

// ── Harness ──────────────────────────────────────────────────────────────────

fn test_paths(root: &std::path::Path) -> AppPaths {
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

fn tool(name: &str) -> ToolDefinition {
    ToolDefinition {
        tool_id: name.into(),
        name: name.into(),
        description: name.into(),
        input_schema: json!({ "type": "object", "properties": {} }),
        kind: None,
        host_config: None,
        permission_level: Some(PermissionLevel::SideEffectful),
        display_group: Some("Utilities".into()),
        tenant_scope: None,
    }
}

struct Chat {
    state: AppState,
    manager: StreamManager,
    runtime: ConnectorRuntimeManager,
    script: Script,
    conversation: String,
    _dir: tempfile::TempDir,
}

impl Chat {
    async fn new(rounds: Vec<Round>, handoff_agents: &[&str]) -> Self {
        let pool = common::setup_pool().await;
        let conversation = conversations::create(&pool, None).await.unwrap().id;
        let dir = tempfile::tempdir().unwrap();
        let settings = AppSettings {
            active_provider: "ollama".into(),
            active_model: "scripted".into(),
            agent: AgentGuardrails {
                handoff_agents: handoff_agents.iter().map(|s| s.to_string()).collect(),
                ..AgentGuardrails::default()
            },
            ..AppSettings::default()
        };
        let state = AppState::test_instance_with_settings(pool, test_paths(dir.path()), settings);
        let script = Script {
            rounds: Arc::new(rounds),
            requests: Arc::new(Mutex::new(Vec::new())),
        };
        let resolver_script = script.clone();
        let manager = StreamManager::with_adapter_resolver(Arc::new(move |_id: &str| {
            Some(Box::new(ScriptedAdapter(resolver_script.clone())) as Box<dyn ProviderAdapter>)
        }));
        Self {
            state,
            manager,
            runtime: ConnectorRuntimeManager::new_with(
                Duration::from_millis(80),
                Duration::from_millis(800),
            ),
            script,
            conversation,
            _dir: dir,
        }
    }

    async fn save_agent(&self, agent: Value) {
        library::create(
            &self.state.db,
            &self.state.encryption,
            serde_json::from_value(agent).unwrap(),
        )
        .await
        .unwrap();
    }

    fn request(&self, tools: &[&str]) -> ProviderRequest {
        ProviderRequest {
            request_id: "turn-1".into(),
            conversation_id: self.conversation.clone(),
            model_id: "scripted".into(),
            messages: vec![Message {
                id: "user-1".into(),
                conversation_id: self.conversation.clone(),
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
                    content: Some("compare two things".into()),
                    mime_type: None,
                    tool_call_id: None,
                    artifact_id: None,
                    attachment_id: None,
                    blob_ref: None,
                    metadata: None,
                    created_at: "2026-10-21T00:00:00Z".into(),
                }],
                created_at: "2026-10-21T00:00:00Z".into(),
            }],
            system_prompt: Some("Be brief.".into()),
            developer_prompt: None,
            attachments: None,
            tool_definitions: tools.iter().map(|t| tool(t)).collect(),
            generation_controls: None,
            response_format: None,
            web_search: None,
        }
    }

    /// Run the turn as the chat command does; the turn's events.
    async fn run(
        &self,
        request: ProviderRequest,
        agent: Option<&str>,
    ) -> (Result<(), String>, Vec<ProviderEvent>) {
        let (sink, collected) = event_sink::collector::<ProviderEvent>();
        let result = handoff::start_chat_turn(
            &self.manager,
            &self.state,
            &self.runtime,
            request,
            sink,
            EventSink::discard(),
            agent.map(str::to_string),
        )
        .await
        .map(|_| ());
        let events = collected.lock().unwrap().clone();
        (result, events)
    }

    fn requests(&self) -> Vec<ProviderRequest> {
        self.script.requests.lock().unwrap().clone()
    }

    /// `agent_calls`: (kind, agent, conversation, parent, model, status, error, tokens).
    async fn calls(&self) -> Vec<Call> {
        sqlx::query_as(
            "SELECT kind, agent_id, conversation_id, parent_id, model, status, error, tokens \
             FROM agent_calls ORDER BY started_at, rowid",
        )
        .fetch_all(&self.state.db)
        .await
        .unwrap()
    }
}

type Call = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    String,
    Option<String>,
    i64,
);

fn tool_names(request: &ProviderRequest) -> Vec<String> {
    let mut names: Vec<String> = request
        .tool_definitions
        .iter()
        .map(|t| t.name.clone())
        .collect();
    names.sort();
    names
}

fn kind_of(event: &ProviderEvent) -> String {
    serde_json::to_value(event).unwrap()["kind"]
        .as_str()
        .unwrap()
        .to_string()
}

fn mentions(request: &ProviderRequest, needle: &str) -> bool {
    serde_json::to_string(request).unwrap().contains(needle)
}

fn researcher() -> Value {
    json!({
        "id": "researcher", "name": "Researcher",
        "instructions": "Find facts on the web.", "tools": ["calculator"]
    })
}

// ── The table ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_migration_keeps_the_workflow_calls_and_drops_the_old_table() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    // Everything up to 0042, as an existing profile has it.
    for migration in conduit_desktop::db::MIGRATOR
        .iter()
        .filter(|m| m.version <= 42)
    {
        sqlx::raw_sql(&migration.sql).execute(&pool).await.unwrap();
    }
    sqlx::query("PRAGMA foreign_keys = OFF")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO workflow_agent_calls (id, run_id, workflow_id, step_id, kind, agent_id, \
         parent_id, task, status, error, tokens, started_at, finished_at) \
         VALUES ('c1', 'r1', 'w1', 's1', 'helper', 'researcher', 'c0', 'task', 'failed', \
         'boom', 42, '2026-10-01T00:00:00Z', '2026-10-01T00:01:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let new_sql = conduit_desktop::db::MIGRATOR
        .iter()
        .find(|m| m.version == 43)
        .expect("migration 43")
        .sql
        .clone();
    sqlx::raw_sql(&new_sql).execute(&pool).await.unwrap();

    let row: (
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        String,
        i64,
    ) = sqlx::query_as(
        "SELECT id, run_id, workflow_id, kind, conversation_id, model, status, tokens \
             FROM agent_calls",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, "c1");
    assert_eq!((row.1.as_str(), row.2.as_str()), ("r1", "w1"));
    assert_eq!(row.3, "helper");
    assert_eq!((row.4, row.5), (None, None), "old rows have no model");
    assert_eq!((row.6.as_str(), row.7), ("failed", 42));
    let old: Option<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workflow_agent_calls'",
    )
    .fetch_optional(&pool)
    .await
    .unwrap();
    assert!(old.is_none(), "the old table is gone");
}

// ── Running a chat turn as an agent ──────────────────────────────────────────

#[tokio::test]
async fn a_turn_as_an_agent_uses_its_instructions_model_and_tools_and_is_recorded() {
    let chat = Chat::new(vec![text_round_using("Done.", 30)], &[]).await;
    chat.save_agent(json!({
        "id": "researcher", "name": "Researcher", "instructions": "Find facts on the web.",
        "tools": ["calculator"], "model": { "provider": "ollama", "model": "special" }
    }))
    .await;
    // Chat offered these; the agent lists only the calculator.
    let request = chat.request(&["write_html_document", "current_time"]);
    let (result, events) = chat.run(request, Some("researcher")).await;
    result.unwrap();

    let requests = chat.requests();
    assert_eq!(requests.len(), 1);
    let system = requests[0].system_prompt.as_deref().unwrap();
    assert!(system.starts_with("Be brief."), "{system}");
    assert!(
        system.contains("You are Researcher, one of the user's agents. Find facts on the web."),
        "{system}"
    );
    assert_eq!(requests[0].model_id, "special");
    assert_eq!(tool_names(&requests[0]), vec!["calculator"]);
    assert!(matches!(
        events.last(),
        Some(ProviderEvent::MessageComplete { .. })
    ));

    let calls = chat.calls().await;
    assert_eq!(calls.len(), 1, "{calls:?}");
    let call = &calls[0];
    assert_eq!((call.0.as_str(), call.1.as_str()), ("chat", "researcher"));
    assert_eq!(call.2.as_deref(), Some(chat.conversation.as_str()));
    assert_eq!(call.3, None);
    assert_eq!(call.4.as_deref(), Some("ollama/special"));
    assert_eq!(
        (call.5.as_str(), call.6.clone(), call.7),
        ("done", None, 30)
    );

    // The Agents page counts it.
    let activity = agent_calls::chat_agent_activity(
        &chat.state.db,
        &chat.state.encryption,
        "2000-01-01T00:00:00Z",
    )
    .await
    .unwrap();
    assert_eq!(activity.len(), 1);
    assert_eq!((activity[0].tasks, activity[0].tokens), (1, 30));
    assert!(activity[0].current_task.is_none());
    let workflow_side = agent_calls::agent_activity(
        &chat.state.db,
        &chat.state.encryption,
        "2000-01-01T00:00:00Z",
    )
    .await
    .unwrap();
    assert!(workflow_side.is_empty(), "chat work isn't a workflow's");
}

#[tokio::test]
async fn an_agent_that_is_gone_is_refused_in_plain_words() {
    let chat = Chat::new(vec![text_round("never")], &[]).await;
    let (result, _) = chat.run(chat.request(&[]), Some("nobody")).await;
    let error = result.unwrap_err();
    assert!(
        error.contains("\u{201c}nobody\u{201d} is one of your agents, but it no longer exists."),
        "{error}"
    );
    assert!(chat.requests().is_empty(), "no round started");
    assert!(chat.calls().await.is_empty());
}

#[tokio::test]
async fn a_turn_with_no_agent_and_nobody_to_ask_is_the_ordinary_turn() {
    let chat = Chat::new(vec![text_round("Hi.")], &["ghost"]).await;
    let (result, _) = chat.run(chat.request(&["current_time"]), None).await;
    result.unwrap();
    let requests = chat.requests();
    assert_eq!(tool_names(&requests[0]), vec!["current_time"]);
    assert_eq!(requests[0].system_prompt.as_deref(), Some("Be brief."));
    assert!(chat.calls().await.is_empty());
}

// ── Handing work to agents from chat ─────────────────────────────────────────

#[tokio::test]
async fn the_assistant_hands_a_task_to_an_agent_that_works_in_a_hidden_conversation() {
    let chat = Chat::new(
        vec![
            tool_round(vec![(
                "ask_researcher",
                json!({ "task": "Find the capital of France" }),
            )]),
            text_round_using("Paris.", 12),
            text_round("It is Paris."),
        ],
        &["researcher", "ghost"],
    )
    .await;
    chat.save_agent(researcher()).await;
    let (result, events) = chat.run(chat.request(&["current_time"]), None).await;
    result.unwrap();

    let requests = chat.requests();
    assert_eq!(requests.len(), 3, "lead, helper, lead again");
    // The assistant is offered the agent the user ticked, and only it.
    assert_eq!(
        tool_names(&requests[0]),
        vec!["ask_researcher", "current_time"]
    );
    assert!(requests[0]
        .system_prompt
        .as_deref()
        .unwrap()
        .contains("hand self-contained tasks"));
    // The agent works from its own instructions, in a conversation of its own.
    let helper = &requests[1];
    assert!(helper
        .system_prompt
        .as_deref()
        .unwrap()
        .contains("You are Researcher. Find facts on the web."));
    assert_eq!(tool_names(helper), vec!["calculator"]);
    assert_ne!(helper.conversation_id, chat.conversation);
    assert!(mentions(helper, "Find the capital of France"));
    let left: Option<String> = sqlx::query_scalar("SELECT id FROM conversations WHERE id = ?")
        .bind(&helper.conversation_id)
        .fetch_optional(&chat.state.db)
        .await
        .unwrap();
    assert!(left.is_none(), "the hidden conversation is deleted");
    // Its answer comes back as the tool's result.
    assert!(mentions(&requests[2], "Paris."));

    // The turn shows it: started, the helper's own events, finished.
    let shown: Vec<String> = events.iter().map(kind_of).collect();
    let started = events
        .iter()
        .find_map(|e| match e {
            ProviderEvent::HandoffStarted {
                tool_call_id,
                agent_id,
                name,
                task,
                model,
                ..
            } => Some((tool_call_id, agent_id, name, task, model)),
            _ => None,
        })
        .expect("a hand-off started");
    assert_eq!(started.1, "researcher");
    assert_eq!(started.2, "Researcher");
    assert_eq!(started.3, "Find the capital of France");
    assert_eq!(started.4, "ollama/scripted");
    let inner_kinds: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            ProviderEvent::Handoff {
                tool_call_id,
                event,
                ..
            } if tool_call_id == started.0 => Some(kind_of(event)),
            _ => None,
        })
        .collect();
    assert!(
        inner_kinds.contains(&"contentDelta".to_string()),
        "{inner_kinds:?}"
    );
    assert!(inner_kinds.contains(&"messageComplete".to_string()));
    let finished = events
        .iter()
        .find_map(|e| match e {
            ProviderEvent::HandoffFinished {
                status,
                tokens,
                error,
                answer,
                ..
            } => Some((status.clone(), *tokens, error.clone(), answer.clone())),
            _ => None,
        })
        .expect("a hand-off finished");
    assert_eq!(
        finished,
        ("done".to_string(), 12, None, Some("Paris.".to_string()))
    );
    let started_at = shown.iter().position(|k| k == "handoffStarted").unwrap();
    let finished_at = shown.iter().position(|k| k == "handoffFinished").unwrap();
    assert!(started_at < finished_at);

    // And the turn's log keeps it for a reload, without the streamed text.
    let logged = event_log::load_events(&chat.state.db, &chat.conversation, "turn-1")
        .await
        .unwrap();
    let logged_kinds: Vec<String> = logged.iter().map(kind_of).collect();
    assert!(logged_kinds.contains(&"handoffStarted".to_string()));
    assert!(logged_kinds.contains(&"handoff".to_string()));
    assert!(logged_kinds.contains(&"handoffFinished".to_string()));
    assert!(
        !logged.iter().any(|e| matches!(
            e,
            ProviderEvent::Handoff { event, .. }
                if matches!(**event, ProviderEvent::ContentDelta { .. })
        )),
        "streamed text is shown live, not logged"
    );
    let at = |kind: &str| logged_kinds.iter().position(|k| k == kind).unwrap();
    assert!(at("handoffStarted") < at("handoff") && at("handoff") < at("handoffFinished"));

    // One helper row, filed under the chat's conversation.
    let calls = chat.calls().await;
    assert_eq!(calls.len(), 1, "{calls:?}");
    let call = &calls[0];
    assert_eq!((call.0.as_str(), call.1.as_str()), ("helper", "researcher"));
    assert_eq!(call.2.as_deref(), Some(chat.conversation.as_str()));
    assert_eq!(call.3, None, "the assistant has no row of its own");
    assert_eq!(call.4.as_deref(), Some("ollama/scripted"));
    assert_eq!((call.5.as_str(), call.7), ("done", 12));
}

#[tokio::test]
async fn a_helper_that_hands_work_on_nests_its_events_and_files_under_its_own_row() {
    let chat = Chat::new(
        vec![
            tool_round(vec![("ask_writer", json!({ "task": "Write it up" }))]),
            tool_round(vec![("ask_researcher", json!({ "task": "Get the facts" }))]),
            text_round("Facts."),
            text_round("Written."),
            text_round("All done."),
        ],
        &["writer"],
    )
    .await;
    chat.save_agent(researcher()).await;
    chat.save_agent(json!({
        "id": "writer", "name": "Writer", "instructions": "Write.", "agents": ["researcher"]
    }))
    .await;
    let (result, events) = chat.run(chat.request(&[]), None).await;
    result.unwrap();
    assert_eq!(chat.requests().len(), 5);
    assert!(
        tool_names(&chat.requests()[1]).contains(&"ask_researcher".to_string()),
        "the writer may ask the researcher"
    );

    let nested = events.iter().any(|e| match e {
        ProviderEvent::Handoff { event, .. } => matches!(
            &**event,
            ProviderEvent::HandoffStarted { agent_id, .. } if agent_id == "researcher"
        ),
        _ => false,
    });
    assert!(nested, "the researcher's hand-off nests in the writer's");

    let calls = chat.calls().await;
    assert_eq!(calls.len(), 2, "{calls:?}");
    let writer_row: String =
        sqlx::query_scalar("SELECT id FROM agent_calls WHERE agent_id = 'writer'")
            .fetch_one(&chat.state.db)
            .await
            .unwrap();
    let researcher_parent: Option<String> =
        sqlx::query_scalar("SELECT parent_id FROM agent_calls WHERE agent_id = 'researcher'")
            .fetch_one(&chat.state.db)
            .await
            .unwrap();
    assert_eq!(researcher_parent, Some(writer_row));
    // Only the outermost hand-off is in the turn's log, with the rest inside it.
    let logged = event_log::load_events(&chat.state.db, &chat.conversation, "turn-1")
        .await
        .unwrap();
    assert_eq!(
        logged
            .iter()
            .filter(|e| matches!(e, ProviderEvent::HandoffStarted { .. }))
            .count(),
        1
    );
}

#[tokio::test]
async fn a_helper_that_jumps_past_its_token_limit_gets_one_round_to_answer() {
    let chat = Chat::new(
        vec![
            tool_round(vec![("ask_researcher", json!({ "task": "Work it out" }))]),
            using(
                tool_round(vec![("calculator", json!({ "expression": "2+2" }))]),
                5_000,
            ),
            text_round("Four, from what I had."),
            text_round("It's four."),
        ],
        &["researcher"],
    )
    .await;
    chat.save_agent(json!({
        "id": "researcher", "name": "Researcher", "instructions": "Do sums.",
        "tools": ["calculator"], "maxTokens": 1000
    }))
    .await;
    let (result, events) = chat.run(chat.request(&[]), None).await;
    result.unwrap();
    assert!(mentions(&chat.requests()[2], "most of your token budget"));
    let finished = events
        .iter()
        .find_map(|e| match e {
            ProviderEvent::HandoffFinished { status, answer, .. } => {
                Some((status.clone(), answer.clone()))
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(
        finished,
        (
            "done".to_string(),
            Some("Four, from what I had.".to_string())
        )
    );
}

#[tokio::test]
async fn a_helper_that_answers_as_it_passes_its_token_limit_keeps_the_answer() {
    let chat = Chat::new(
        vec![
            tool_round(vec![("ask_researcher", json!({ "task": "Work it out" }))]),
            text_round_using("Four.", 5_000),
            text_round("It's four."),
        ],
        &["researcher"],
    )
    .await;
    chat.save_agent(json!({
        "id": "researcher", "name": "Researcher", "instructions": "Do sums.", "maxTokens": 1000
    }))
    .await;
    let (result, events) = chat.run(chat.request(&[]), None).await;
    result.unwrap();
    let finished = events
        .iter()
        .find_map(|e| match e {
            ProviderEvent::HandoffFinished { status, answer, .. } => {
                Some((status.clone(), answer.clone()))
            }
            _ => None,
        })
        .unwrap();
    assert_eq!(finished, ("done".to_string(), Some("Four.".to_string())));
    assert!(mentions(&chat.requests()[2], "Four."));
}

#[tokio::test]
async fn a_helper_near_its_token_limit_is_told_to_answer_with_what_it_has() {
    let chat = Chat::new(
        vec![
            tool_round(vec![("ask_researcher", json!({ "task": "Work it out" }))]),
            using(
                tool_round(vec![("calculator", json!({ "expression": "2+2" }))]),
                800,
            ),
            text_round("Four, as far as I got."),
            text_round("It's four."),
        ],
        &["researcher"],
    )
    .await;
    chat.save_agent(json!({
        "id": "researcher", "name": "Researcher", "instructions": "Do sums.",
        "tools": ["calculator"], "maxTokens": 1000
    }))
    .await;
    let (result, _) = chat.run(chat.request(&[]), None).await;
    result.unwrap();
    let requests = chat.requests();
    assert!(!mentions(&requests[1], "most of your token budget"));
    assert!(
        mentions(&requests[2], "most of your token budget"),
        "the helper's next round is told to wrap up"
    );
    assert!(mentions(&requests[3], "as far as I got"));
}

#[tokio::test]
async fn a_helper_over_its_token_limit_fails_and_the_assistant_carries_on() {
    let chat = Chat::new(
        vec![
            tool_round(vec![("ask_researcher", json!({ "task": "Work it out" }))]),
            using(
                tool_round(vec![("calculator", json!({ "expression": "2+2" }))]),
                5_000,
            ),
            // Its one more round, to answer, calls a tool instead.
            tool_round(vec![("calculator", json!({ "expression": "2+3" }))]),
            text_round("Never reached."),
            text_round("I'll do it myself."),
        ],
        &["researcher"],
    )
    .await;
    chat.save_agent(json!({
        "id": "researcher", "name": "Researcher", "instructions": "Do sums.",
        "tools": ["calculator"], "maxTokens": 1000
    }))
    .await;
    let (result, events) = chat.run(chat.request(&[]), None).await;
    result.unwrap();
    let finished = events
        .iter()
        .find_map(|e| match e {
            ProviderEvent::HandoffFinished {
                status,
                tokens,
                error,
                ..
            } => Some((status.clone(), *tokens, error.clone())),
            _ => None,
        })
        .unwrap();
    assert_eq!(finished.0, "failed");
    assert_eq!(finished.1, 5_000);
    assert!(
        finished
            .2
            .as_deref()
            .is_some_and(|e| e.contains("limit of 1000 tokens")),
        "{finished:?}"
    );
    assert!(mentions(
        chat.requests().last().unwrap(),
        "limit of 1000 tokens"
    ));
    let calls = chat.calls().await;
    assert_eq!((calls[0].5.as_str(), calls[0].7), ("failed", 5_000));
}

#[tokio::test]
async fn an_agent_asked_to_do_nothing_or_that_isnt_ticked_is_refused() {
    let chat = Chat::new(
        vec![
            tool_round(vec![("ask_researcher", json!({ "task": "  " }))]),
            text_round("Fine."),
        ],
        &["researcher"],
    )
    .await;
    chat.save_agent(researcher()).await;
    let (result, events) = chat.run(chat.request(&[]), None).await;
    result.unwrap();
    assert_eq!(chat.requests().len(), 2, "no helper round");
    assert!(mentions(
        &chat.requests()[1],
        "Say what the helper should do"
    ));
    assert!(!events
        .iter()
        .any(|e| matches!(e, ProviderEvent::HandoffStarted { .. })));
    assert!(chat.calls().await.is_empty());
}

// ── The guards ───────────────────────────────────────────────────────────────

fn def(id: &str, name: &str) -> AgentDef {
    serde_json::from_value(json!({ "id": id, "name": name, "instructions": "x" })).unwrap()
}

#[test]
fn work_is_never_handed_back_up_the_chain() {
    let handed = AtomicUsize::new(0);
    let chain = vec!["writer".to_string()];
    let error = handoff::check_handoff(&chain, &def("writer", "Writer"), &handed).unwrap_err();
    assert_eq!(
        error,
        "Writer handed you this work; do it yourself rather than hand it back."
    );
    assert_eq!(
        handed.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "not counted"
    );
}

#[test]
fn work_is_handed_on_only_so_far() {
    let handed = AtomicUsize::new(0);
    let chain = vec!["a".to_string(), "b".to_string()];
    let error = handoff::check_handoff(&chain, &def("c", "C"), &handed).unwrap_err();
    assert_eq!(
        error,
        "This work can't be handed on any further; do it yourself."
    );
    assert!(handoff::check_handoff(&chain[..1], &def("c", "C"), &handed).is_ok());
}

#[test]
fn a_turn_hands_out_only_so_many_tasks() {
    let handed = AtomicUsize::new(0);
    let helper = def("c", "C");
    for _ in 0..12 {
        handoff::check_handoff(&[], &helper, &handed).unwrap();
    }
    let error = handoff::check_handoff(&[], &helper, &handed).unwrap_err();
    assert!(error.contains("12 tasks already"), "{error}");
}

// ── Settings ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn deleting_an_agent_takes_it_off_the_assistants_list() {
    let chat = Chat::new(vec![], &["researcher", "writer"]).await;
    chat.save_agent(researcher()).await;
    library::delete(&chat.state.db, &chat.state.encryption, "researcher")
        .await
        .unwrap();
    library::forget_handoff(&chat.state, "researcher").unwrap();
    assert_eq!(
        chat.state.settings().unwrap().agent.handoff_agents,
        ["writer"]
    );
}

#[tokio::test]
async fn the_agents_the_assistant_may_ask_are_cleaned_and_capped_on_save() {
    let pool_dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance_with_settings(
        common::setup_pool().await,
        test_paths(pool_dir.path()),
        AppSettings::default(),
    );
    let save = |ids: Vec<String>| {
        let mut patch: provider_core::schema::SettingsPatch = serde_json::from_str("{}").unwrap();
        patch.agent = Some(
            AgentGuardrails {
                handoff_agents: ids,
                ..AgentGuardrails::default()
            }
            .into(),
        );
        state.update_settings(patch)
    };
    let saved = save(vec![
        " writer ".into(),
        "".into(),
        "writer".into(),
        "  ".into(),
        "reviewer".into(),
    ])
    .unwrap();
    assert_eq!(saved.agent.handoff_agents, ["writer", "reviewer"]);
    let too_many: Vec<String> = (0..21).map(|n| format!("a{n}")).collect();
    assert!(save(too_many).is_err());
}

#[tokio::test]
async fn how_many_helpers_work_at_once_is_one_to_four_and_three_by_default() {
    let pool_dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance_with_settings(
        common::setup_pool().await,
        test_paths(pool_dir.path()),
        AppSettings::default(),
    );
    let save = |at_once: u8| {
        let mut patch: provider_core::schema::SettingsPatch = serde_json::from_str("{}").unwrap();
        patch.agent = Some(
            AgentGuardrails {
                parallel_helpers: at_once,
                ..AgentGuardrails::default()
            }
            .into(),
        );
        state.update_settings(patch)
    };
    for bad in [0, 5] {
        let error = save(bad).unwrap_err();
        assert_eq!(error.code, "error.validation.agentParallelHelpers");
        assert_eq!(error.params.get("max").map(String::as_str), Some("4"));
    }
    assert_eq!(save(4).unwrap().agent.parallel_helpers, 4);
    // Settings saved before it existed get the default.
    let older: AgentGuardrails =
        serde_json::from_value(json!({ "maxSteps": 25, "wallClockBudgetSecs": 300 })).unwrap();
    assert_eq!(older.parallel_helpers, 3);
}

#[tokio::test]
async fn a_partial_agent_patch_keeps_the_other_guardrails() {
    let pool_dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance_with_settings(
        common::setup_pool().await,
        test_paths(pool_dir.path()),
        AppSettings::default(),
    );
    let patch: provider_core::schema::SettingsPatch = serde_json::from_value(json!({
        "agent": { "handoffAgents": ["writer"], "maxSteps": 40 }
    }))
    .unwrap();
    state.update_settings(patch).unwrap();
    // The way the settings tool sends it: one field, nothing else.
    let patch: provider_core::schema::SettingsPatch =
        serde_json::from_value(json!({ "agent": { "parallelHelpers": 1 } })).unwrap();
    let saved = state.update_settings(patch).unwrap();
    assert_eq!(saved.agent.parallel_helpers, 1);
    assert_eq!(saved.agent.handoff_agents, ["writer"]);
    assert_eq!(saved.agent.max_steps, 40);
}

// ── Helpers side by side ─────────────────────────────────────────────────────

/// When each helper's first round started and ended, by its name.
type Shifts = Arc<Mutex<Vec<(String, Instant, Instant)>>>;

/// A model that answers each request from what it is, so helpers can work
/// side by side: the lead's first round hands out `asks` and its next one
/// answers; a helper's first round works for its time in `work` (or until it
/// is cancelled), then answers with its task; a later one (after a redirect)
/// answers at once with what it was last told.
#[derive(Clone)]
struct Workers {
    local: bool,
    asks: Vec<(&'static str, Value)>,
    work: Vec<(&'static str, Duration)>,
    shifts: Shifts,
    requests: Arc<Mutex<Vec<ProviderRequest>>>,
}

impl Workers {
    fn new(asks: Vec<(&'static str, Value)>, work: Vec<(&'static str, Duration)>) -> Self {
        Self {
            local: false,
            asks,
            work,
            shifts: Arc::new(Mutex::new(Vec::new())),
            requests: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn shift(&self, name: &str) -> (Instant, Instant) {
        let shifts = self.shifts.lock().unwrap();
        let (_, start, end) = shifts
            .iter()
            .find(|(n, _, _)| n == name)
            .unwrap_or_else(|| panic!("{name} never worked: {shifts:?}"));
        (*start, *end)
    }

    /// Wait (up to 5 s) until `name`'s first round is under way.
    async fn at_work(&self, name: &str) {
        for _ in 0..500 {
            let working = self
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|r| Self::helper_of(r).as_deref() == Some(name));
            if working {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("{name} never started");
    }

    /// The helper a request is from, by the name its instructions give it.
    fn helper_of(request: &ProviderRequest) -> Option<String> {
        let system = request.system_prompt.as_deref()?;
        if !system.contains("one of the user's agents: another agent handed you") {
            return None;
        }
        let name = system.split("\n\nYou are ").nth(1)?.split('.').next()?;
        Some(name.to_string())
    }
}

fn last_text(request: &ProviderRequest) -> String {
    request
        .messages
        .iter()
        .rev()
        .find(|m| m.role == MessageRole::User)
        .and_then(|m| m.parts.first())
        .and_then(|p| p.content.clone())
        .unwrap_or_default()
}

/// A round that answers `text`, having used 100 input, 20 output, 7 cache
/// read and 3 cache write tokens.
fn answer(rid: &str, text: String) -> Vec<ProviderEvent> {
    let r = rid.to_string();
    vec![
        ProviderEvent::MessageStart {
            request_id: r.clone(),
            index: 0,
        },
        ProviderEvent::ContentDelta {
            request_id: r.clone(),
            block_id: "b0".into(),
            index: 1,
            content: text,
        },
        ProviderEvent::Usage {
            request_id: r.clone(),
            usage: ProviderUsage {
                input_tokens: Some(100),
                output_tokens: Some(20),
                cache_tokens: None,
                cache_read_tokens: Some(7),
                cache_write_tokens: Some(3),
                cost_hint: None,
            },
        },
        ProviderEvent::MessageComplete {
            request_id: r,
            index: 2,
            finish_reason: "stop".into(),
        },
    ]
}

#[async_trait]
impl ProviderAdapter for Workers {
    fn id(&self) -> &'static str {
        "ollama"
    }

    fn display_name(&self) -> &'static str {
        "Workers"
    }

    fn is_local(&self) -> bool {
        self.local
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
        cancel: CancellationToken,
    ) -> Result<Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>, ProviderError> {
        self.requests.lock().unwrap().push(request.clone());
        let rid = request.request_id.clone();
        let Some(name) = Self::helper_of(&request) else {
            // The lead.
            let answered = request.messages.iter().any(|m| m.role == MessageRole::Tool);
            let events = if answered {
                answer(&rid, "All done.".into())
            } else {
                tool_round(self.asks.clone())(&rid)
            };
            return Ok(Box::pin(futures::stream::iter(events)));
        };
        let first = request.messages.len() == 1;
        let work = self
            .work
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, d)| *d)
            .filter(|_| first)
            .unwrap_or_default();
        let shifts = self.shifts.clone();
        let text = format!("{name}: {}", last_text(&request));
        let started = Instant::now();
        Ok(Box::pin(
            futures::stream::once(async move {
                tokio::select! {
                    () = tokio::time::sleep(work) => {}
                    () = cancel.cancelled() => return Vec::new(),
                }
                if first {
                    shifts.lock().unwrap().push((name, started, Instant::now()));
                }
                answer(&rid, text)
            })
            .flat_map(futures::stream::iter),
        ))
    }
}

impl Chat {
    /// A chat whose model is `workers`, which may hand work to `handoff_agents`,
    /// `at_once` helpers at a time.
    async fn working(workers: &Workers, handoff_agents: &[&str], at_once: u8) -> Self {
        let mut chat = Chat::new(Vec::new(), handoff_agents).await;
        let workers = workers.clone();
        chat.manager = StreamManager::with_adapter_resolver(Arc::new(move |_id: &str| {
            Some(Box::new(workers.clone()) as Box<dyn ProviderAdapter>)
        }));
        let mut patch: provider_core::schema::SettingsPatch = serde_json::from_str("{}").unwrap();
        patch.agent = Some(
            AgentGuardrails {
                handoff_agents: handoff_agents.iter().map(|s| s.to_string()).collect(),
                parallel_helpers: at_once,
                ..AgentGuardrails::default()
            }
            .into(),
        );
        // `Workers` is a cloud model unless it says it is local.
        patch.local_only = Some(false);
        chat.state.update_settings(patch).unwrap();
        chat
    }

    /// Start the turn; its events as they come.
    fn start(
        &self,
        request: ProviderRequest,
    ) -> (
        impl std::future::Future<Output = Result<(), String>> + '_,
        Arc<Mutex<Vec<ProviderEvent>>>,
    ) {
        let (sink, collected) = event_sink::collector::<ProviderEvent>();
        let turn = async move {
            handoff::start_chat_turn(
                &self.manager,
                &self.state,
                &self.runtime,
                request,
                sink,
                EventSink::discard(),
                None,
            )
            .await
            .map(|_| ())
        };
        (turn, collected)
    }

    /// `agent_calls`: (agent, status, error, tokens, input, output, cache
    /// read, cache write, request id), in the order they started.
    async fn usage_rows(&self) -> Vec<UsageRow> {
        sqlx::query_as(
            "SELECT agent_id, status, error, tokens, input_tokens, output_tokens, \
             cache_read_tokens, cache_write_tokens, request_id \
             FROM agent_calls ORDER BY started_at, rowid",
        )
        .fetch_all(&self.state.db)
        .await
        .unwrap()
    }
}

type UsageRow = (
    String,
    String,
    Option<String>,
    i64,
    i64,
    i64,
    i64,
    i64,
    Option<String>,
);

fn helper_agent(id: &str, name: &str) -> Value {
    json!({ "id": id, "name": name, "instructions": "Look it up." })
}

/// Wait (up to 5 s) for an event `find` picks out.
async fn seen<T>(
    events: &Mutex<Vec<ProviderEvent>>,
    find: impl Fn(&ProviderEvent) -> Option<T>,
) -> T {
    for _ in 0..500 {
        if let Some(found) = events.lock().unwrap().iter().find_map(&find) {
            return found;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("never seen");
}

/// The agent call id and helper request id `agent`'s hand-off started with.
fn started_as(agent: &str) -> impl Fn(&ProviderEvent) -> Option<(String, String)> + '_ {
    move |event| match event {
        ProviderEvent::HandoffStarted {
            agent_id,
            call_id,
            helper_request_id,
            ..
        } if agent_id == agent => Some((call_id.clone(), helper_request_id.clone())),
        _ => None,
    }
}

fn finished(events: &[ProviderEvent], tool_call: &str) -> (String, Option<String>, Option<String>) {
    events
        .iter()
        .find_map(|e| match e {
            ProviderEvent::HandoffFinished {
                tool_call_id,
                status,
                error,
                answer,
                ..
            } if tool_call_id.starts_with(tool_call) => {
                Some((status.clone(), error.clone(), answer.clone()))
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("{tool_call} never finished"))
}

fn three_asks() -> Vec<(&'static str, Value)> {
    vec![
        ("ask_alpha", json!({ "task": "first" })),
        ("ask_beta", json!({ "task": "second" })),
        ("ask_gamma", json!({ "task": "third" })),
    ]
}

async fn save_three(chat: &Chat) {
    for (id, name) in [("alpha", "Alpha"), ("beta", "Beta"), ("gamma", "Gamma")] {
        chat.save_agent(helper_agent(id, name)).await;
    }
}

fn overlap(a: (Instant, Instant), b: (Instant, Instant)) -> bool {
    a.0 < b.1 && b.0 < a.1
}

#[tokio::test]
async fn three_helpers_in_one_round_work_side_by_side_and_answer_in_call_order() {
    let work = Duration::from_millis(400);
    let workers = Workers::new(
        three_asks(),
        vec![("Alpha", work), ("Beta", work), ("Gamma", work)],
    );
    let chat = Chat::working(&workers, &["alpha", "beta", "gamma"], 3).await;
    save_three(&chat).await;
    let began = Instant::now();
    let (result, events) = chat.run(chat.request(&[]), None).await;
    result.unwrap();
    let took = began.elapsed();

    let (a, b, c) = (
        workers.shift("Alpha"),
        workers.shift("Beta"),
        workers.shift("Gamma"),
    );
    assert!(
        overlap(a, b) && overlap(b, c) && overlap(a, c),
        "all three worked at once"
    );
    assert!(
        took < work * 3,
        "about the time of the slowest, not the sum: {took:?}"
    );

    // Recorded in the order the lead called them.
    let order: Vec<String> = events
        .iter()
        .filter_map(|e| match e {
            ProviderEvent::ToolExecutionFinished { tool_name, .. } => Some(tool_name.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(order, ["ask_alpha", "ask_beta", "ask_gamma"]);
    let lead = chat
        .workers_requests(&workers)
        .into_iter()
        .rfind(|r| Workers::helper_of(r).is_none())
        .unwrap();
    for (n, expected) in ["Alpha: first", "Beta: second", "Gamma: third"]
        .iter()
        .enumerate()
    {
        let result = lead
            .messages
            .iter()
            .flat_map(|m| &m.parts)
            .find(|p| {
                p.tool_call_id
                    .as_deref()
                    .is_some_and(|id| id.starts_with(&format!("call-{n}-")))
                    && p.kind == MessagePartKind::ToolResult
            })
            .unwrap();
        assert!(
            result.content.as_deref().unwrap().contains(expected),
            "{:?}",
            result.content
        );
    }

    // Each helper's tokens: live after its round, and split when it finished.
    let split = HandoffTokens {
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 7,
        cache_write_tokens: 3,
    };
    let live: Vec<(u64, HandoffTokens)> = events
        .iter()
        .filter_map(|e| match e {
            ProviderEvent::HandoffUsage { tokens, usage, .. } => Some((*tokens, *usage)),
            _ => None,
        })
        .collect();
    assert!(live.len() >= 3, "{live:?}");
    assert!(live.iter().all(|u| *u == (120, split)), "{live:?}");
    let finished_usage: Vec<HandoffTokens> = events
        .iter()
        .filter_map(|e| match e {
            ProviderEvent::HandoffFinished { usage, tokens, .. } => {
                assert_eq!(*tokens, 120);
                Some(*usage)
            }
            _ => None,
        })
        .collect();
    assert_eq!(finished_usage, [split; 3]);
    let rows = chat.usage_rows().await;
    assert_eq!(rows.len(), 3);
    for row in &rows {
        assert_eq!(row.1, "done");
        assert_eq!((row.3, row.4, row.5, row.6, row.7), (120, 100, 20, 7, 3));
        assert!(row.8.is_some(), "its request is kept");
    }
    // Live only: a reload shows the finished split, not every update.
    let logged = event_log::load_events(&chat.state.db, &chat.conversation, "turn-1")
        .await
        .unwrap();
    assert!(!logged.iter().map(kind_of).any(|k| k == "handoffUsage"));
    assert!(logged.iter().map(kind_of).any(|k| k == "handoffFinished"));
}

#[tokio::test]
async fn one_helper_at_a_time_makes_them_take_turns() {
    let work = Duration::from_millis(150);
    let workers = Workers::new(
        three_asks(),
        vec![("Alpha", work), ("Beta", work), ("Gamma", work)],
    );
    let chat = Chat::working(&workers, &["alpha", "beta", "gamma"], 1).await;
    save_three(&chat).await;
    let (result, _) = chat.run(chat.request(&[]), None).await;
    result.unwrap();
    let (a, b, c) = (
        workers.shift("Alpha"),
        workers.shift("Beta"),
        workers.shift("Gamma"),
    );
    assert!(!overlap(a, b) && !overlap(b, c) && !overlap(a, c));
}

#[tokio::test]
async fn a_local_model_serves_one_helper_round_at_a_time() {
    let work = Duration::from_millis(150);
    let mut workers = Workers::new(
        three_asks(),
        vec![("Alpha", work), ("Beta", work), ("Gamma", work)],
    );
    workers.local = true;
    let chat = Chat::working(&workers, &["alpha", "beta", "gamma"], 3).await;
    save_three(&chat).await;
    let (result, events) = chat.run(chat.request(&[]), None).await;
    result.unwrap();
    let (a, b, c) = (
        workers.shift("Alpha"),
        workers.shift("Beta"),
        workers.shift("Gamma"),
    );
    assert!(!overlap(a, b) && !overlap(b, c) && !overlap(a, c));
    assert_eq!(
        events
            .iter()
            .filter(
                |e| matches!(e, ProviderEvent::HandoffFinished { status, .. } if status == "done")
            )
            .count(),
        3
    );
}

#[tokio::test]
async fn a_helper_that_acts_works_alone_unless_it_may_work_alongside_others() {
    let work = Duration::from_millis(300);
    let asks = vec![
        ("ask_clerk", json!({ "task": "file it" })),
        ("ask_alpha", json!({ "task": "first" })),
        ("ask_beta", json!({ "task": "second" })),
    ];
    for alongside in [false, true] {
        let workers = Workers::new(
            asks.clone(),
            vec![("Clerk", work), ("Alpha", work), ("Beta", work)],
        );
        let chat = Chat::working(&workers, &["clerk", "alpha", "beta"], 3).await;
        chat.save_agent(helper_agent("alpha", "Alpha")).await;
        chat.save_agent(helper_agent("beta", "Beta")).await;
        chat.save_agent(json!({
            "id": "clerk", "name": "Clerk", "instructions": "File things.",
            "tools": ["computer"], "alongside": alongside
        }))
        .await;
        let (result, events) = chat.run(chat.request(&[]), None).await;
        result.unwrap();
        let (clerk, a, b) = (
            workers.shift("Clerk"),
            workers.shift("Alpha"),
            workers.shift("Beta"),
        );
        assert!(overlap(a, b), "the others work side by side");
        if alongside {
            assert!(overlap(clerk, a), "allowed to work alongside them");
        } else {
            assert!(
                clerk.0 >= a.1 && clerk.0 >= b.1,
                "it uses the computer, so it works after the others"
            );
        }
        let order: Vec<String> = events
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::ToolExecutionFinished { tool_name, .. } => Some(tool_name.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(order, ["ask_clerk", "ask_alpha", "ask_beta"]);
    }
}

#[test]
fn a_helper_acts_when_it_uses_the_computer_or_a_tool_that_changes_things() {
    let agent = |tools: Value| -> AgentDef {
        serde_json::from_value(
            json!({ "id": "a", "name": "A", "instructions": "x", "tools": tools }),
        )
        .unwrap()
    };
    let unknown = |_: &str, _: &str| None;
    assert!(!handoff::acts(
        &agent(json!(["web_search", "web_fetch", "calculator"])),
        unknown
    ));
    assert!(handoff::acts(&agent(json!(["computer"])), unknown));
    assert!(handoff::acts(&agent(json!(["remember"])), unknown));
    // A connector tool counts by what it declares; one that can't be told, as acting.
    let tools = agent(json!(["files/read", "files/post"]));
    assert!(handoff::acts(&tools, unknown));
    assert!(handoff::acts(&tools, |_, tool| Some(tool == "read")));
    assert!(!handoff::acts(&tools, |_, _| Some(true)));
}

#[tokio::test]
async fn stopping_one_helper_leaves_its_sibling_working_and_the_lead_carries_on() {
    let workers = Workers::new(
        vec![
            ("ask_slow", json!({ "task": "dig deep" })),
            ("ask_quick", json!({ "task": "glance" })),
        ],
        vec![
            ("Slow", Duration::from_secs(30)),
            ("Quick", Duration::from_millis(300)),
        ],
    );
    let chat = Chat::working(&workers, &["slow", "quick"], 3).await;
    chat.save_agent(helper_agent("slow", "Slow")).await;
    chat.save_agent(helper_agent("quick", "Quick")).await;
    let began = Instant::now();
    let (turn, events) = chat.start(chat.request(&[]));
    let stop = async {
        let (call_id, _) = seen(&events, started_as("slow")).await;
        assert!(!call_id.is_empty());
        workers.at_work("Slow").await;
        chat.manager.stop_agent_call(&call_id).unwrap();
        call_id
    };
    let (result, call_id) = tokio::join!(turn, stop);
    result.unwrap();
    assert!(
        began.elapsed() < Duration::from_secs(10),
        "it didn't wait for the slow one"
    );
    let events = events.lock().unwrap().clone();

    assert_eq!(
        finished(&events, "call-0-"),
        ("stopped".into(), Some(handoff::STOPPED_BY_YOU.into()), None)
    );
    let quick = finished(&events, "call-1-");
    assert_eq!(quick.0, "done");
    assert_eq!(quick.2.as_deref(), Some("Quick: glance"));
    // The lead heard both and answered.
    let lead = chat
        .workers_requests(&workers)
        .into_iter()
        .rfind(|r| Workers::helper_of(r).is_none())
        .unwrap();
    assert!(mentions(&lead, "Stopped by you."));
    assert!(mentions(&lead, "Quick: glance"));
    assert!(matches!(
        events.last(),
        Some(ProviderEvent::MessageComplete { .. })
    ));

    let rows = chat.usage_rows().await;
    let row = |agent: &str| rows.iter().find(|r| r.0 == agent).unwrap().clone();
    assert_eq!(row("slow").1, "stopped");
    assert_eq!(row("slow").2.as_deref(), Some(handoff::STOPPED_BY_YOU));
    assert_eq!(row("quick").1, "done");
    // It is no longer at work.
    let error = chat.manager.stop_agent_call(&call_id).unwrap_err();
    assert_eq!(error.code, "error.agents.notWorking");
}

#[tokio::test]
async fn redirecting_a_helper_steers_it_and_only_it() {
    let workers = Workers::new(
        vec![("ask_slow", json!({ "task": "Find hotels in Paris" }))],
        vec![("Slow", Duration::from_secs(30))],
    );
    let chat = Chat::working(&workers, &["slow"], 3).await;
    chat.save_agent(helper_agent("slow", "Slow")).await;
    let (turn, events) = chat.start(chat.request(&[]));
    let redirect = async {
        let (call_id, helper_request) = seen(&events, started_as("slow")).await;
        workers.at_work("Slow").await;
        let empty = chat
            .manager
            .redirect_agent_call(&call_id, "  ")
            .unwrap_err();
        assert_eq!(empty.code, "error.validation.agentRedirectEmpty");
        let unknown = chat
            .manager
            .redirect_agent_call("nobody", "Go")
            .unwrap_err();
        assert_eq!(unknown.code, "error.agents.notWorking");
        chat.manager
            .redirect_agent_call(&call_id, "Look at Lyon instead.")
            .unwrap();
        helper_request
    };
    let began = Instant::now();
    let (result, helper_request) = tokio::join!(turn, redirect);
    result.unwrap();
    assert!(began.elapsed() < Duration::from_secs(10));
    let events = events.lock().unwrap().clone();
    let (status, _, answer) = finished(&events, "call-0-");
    assert_eq!(status, "done");
    assert_eq!(answer.as_deref(), Some("Slow: Look at Lyon instead."));
    // The redirect is kept with the helper's events, before it finished, and saved in
    // the turn's log so a reloaded view still shows it.
    let note_at = events.iter().position(|e| {
        matches!(e, ProviderEvent::Handoff { event, .. }
            if matches!(&**event, ProviderEvent::UserNote { text, .. } if text == "Look at Lyon instead."))
    });
    let finished_at = events
        .iter()
        .position(|e| matches!(e, ProviderEvent::HandoffFinished { .. }));
    assert!(
        note_at.is_some() && note_at < finished_at,
        "{note_at:?} {finished_at:?}"
    );
    let logged: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM provider_event_log WHERE event_kind = 'handoff' \n         AND payload LIKE '%userNote%' AND payload LIKE '%Look at Lyon instead.%'",
    )
    .fetch_one(&chat.state.db)
    .await
    .unwrap();
    assert_eq!(logged, 1);
    let rows = chat.usage_rows().await;
    assert_eq!(rows[0].8.as_deref(), Some(helper_request.as_str()));
}

impl Chat {
    fn workers_requests(&self, workers: &Workers) -> Vec<ProviderRequest> {
        workers.requests.lock().unwrap().clone()
    }
}

#[tokio::test]
async fn migration_44_adds_the_split_and_the_request_and_allows_stopped() {
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    for migration in conduit_desktop::db::MIGRATOR
        .iter()
        .filter(|m| m.version <= 43)
    {
        sqlx::raw_sql(&migration.sql).execute(&pool).await.unwrap();
    }
    sqlx::query(
        "INSERT INTO agent_calls (id, kind, agent_id, status, tokens, started_at) \
         VALUES ('c1', 'chat', 'researcher', 'done', 42, '2026-10-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .unwrap();
    let sql = conduit_desktop::db::MIGRATOR
        .iter()
        .find(|m| m.version == 44)
        .expect("migration 44")
        .sql
        .clone();
    sqlx::raw_sql(&sql).execute(&pool).await.unwrap();
    let row: (i64, i64, i64, i64, i64, Option<String>) = sqlx::query_as(
        "SELECT tokens, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, \
         request_id FROM agent_calls",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row, (42, 0, 0, 0, 0, None));
    agent_calls::finish_agent_call(
        &pool,
        "c1",
        &agent_calls::AgentCallEnd {
            tokens: 50,
            usage: HandoffTokens {
                input_tokens: 40,
                output_tokens: 10,
                cache_read_tokens: 2,
                cache_write_tokens: 1,
            },
            error: Some(handoff::STOPPED_BY_YOU),
            stopped: true,
        },
    )
    .await
    .unwrap();
    let (status, input): (String, i64) =
        sqlx::query_as("SELECT status, input_tokens FROM agent_calls")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!((status.as_str(), input), ("stopped", 40));
}

// ── The turn ceiling ─────────────────────────────────────────────────────────

#[tokio::test]
async fn a_turn_past_its_ceiling_stops_with_a_plain_error() {
    let chat = Chat::new(vec![text_round("never asked")], &[]).await;
    let (sink, collected) = event_sink::collector::<ProviderEvent>();
    chat.manager
        .run_agent_turn_opts(
            &chat.state,
            &chat.runtime,
            chat.request(&["current_time"]),
            sink,
            EventSink::discard(),
            None,
            TurnOptions {
                ceiling: Some(tokio::time::Instant::now()),
                ..TurnOptions::default()
            },
        )
        .await
        .unwrap();
    let events = collected.lock().unwrap().clone();
    assert!(
        events.iter().any(|e| matches!(
            e,
            ProviderEvent::Error { error, .. } if error.message == CEILING_MESSAGE
        )),
        "{:?}",
        events.iter().map(kind_of).collect::<Vec<_>>()
    );
    assert!(
        chat.requests().is_empty(),
        "no round started past the ceiling"
    );
}

// ── What the page hears about agents at work ─────────────────────────────────

/// Every `agent-call-changed` announcement from now on.
fn hear(chat: &Chat) -> Arc<Mutex<Vec<agent_calls::AgentCallChange>>> {
    let heard = Arc::new(Mutex::new(Vec::new()));
    let sink = heard.clone();
    chat.state
        .agent_calls
        .set_listener(move |change| sink.lock().unwrap().push(change.clone()));
    heard
}

#[tokio::test]
async fn a_helper_announces_when_it_starts_and_when_it_ends() {
    let chat = Chat::new(
        vec![
            tool_round(vec![(
                "ask_researcher",
                json!({ "task": "Find the capital of France" }),
            )]),
            text_round_using("Paris.", 12),
            text_round("It is Paris."),
        ],
        &["researcher"],
    )
    .await;
    chat.save_agent(researcher()).await;
    let heard = hear(&chat);
    let (result, _) = chat.run(chat.request(&["current_time"]), None).await;
    result.unwrap();

    let heard = heard.lock().unwrap().clone();
    assert_eq!(heard.len(), 2, "{heard:?}");
    let (start, end) = (&heard[0], &heard[1]);
    assert_eq!(start.id, end.id);
    assert_eq!(
        (
            start.kind.as_str(),
            start.agent_id.as_str(),
            start.name.as_str()
        ),
        ("helper", "researcher", "Researcher")
    );
    assert_eq!(start.task, "Find the capital of France");
    assert_eq!(
        start.conversation_id.as_deref(),
        Some(chat.conversation.as_str())
    );
    assert_eq!(
        (start.run_id.clone(), start.workflow_id.clone()),
        (None, None)
    );
    assert_eq!(start.parent_id, None);
    assert_eq!(start.status, "running");
    assert!(start.finished_at.is_none() && start.error.is_none());
    assert_eq!(end.status, "done");
    assert!(end.finished_at.is_some());
    assert_eq!(end.task, start.task);
    // The camelCase the page reads.
    let json = serde_json::to_value(end).unwrap();
    assert_eq!(json["agentId"], "researcher");
    assert!(json["conversationId"].is_string());
    assert!(json.get("finishedAt").is_some());
}

#[tokio::test]
async fn a_turn_run_as_an_agent_announces_itself_by_name() {
    let chat = Chat::new(vec![text_round("Done.")], &[]).await;
    chat.save_agent(researcher()).await;
    let heard = hear(&chat);
    let (result, _) = chat.run(chat.request(&[]), Some("researcher")).await;
    result.unwrap();

    let heard = heard.lock().unwrap().clone();
    let statuses: Vec<&str> = heard.iter().map(|c| c.status.as_str()).collect();
    assert_eq!(statuses, ["running", "done"]);
    assert_eq!(heard[0].kind, "chat");
    assert_eq!(heard[0].name, "Researcher");
    assert_eq!(heard[0].task, "compare two things");
    assert_eq!(
        heard[0].conversation_id.as_deref(),
        Some(chat.conversation.as_str())
    );
}

#[tokio::test]
async fn a_stopped_helper_announces_that_it_stopped() {
    let workers = Workers::new(
        vec![("ask_slow", json!({ "task": "dig deep" }))],
        vec![("Slow", Duration::from_secs(30))],
    );
    let chat = Chat::working(&workers, &["slow"], 3).await;
    chat.save_agent(helper_agent("slow", "Slow")).await;
    let heard = hear(&chat);
    let (turn, events) = chat.start(chat.request(&[]));
    let stop = async {
        let (call_id, _) = seen(&events, started_as("slow")).await;
        workers.at_work("Slow").await;
        chat.manager.stop_agent_call(&call_id).unwrap();
    };
    let (result, ()) = tokio::join!(turn, stop);
    result.unwrap();

    let heard = heard.lock().unwrap().clone();
    let slow: Vec<&agent_calls::AgentCallChange> =
        heard.iter().filter(|c| c.agent_id == "slow").collect();
    assert_eq!(slow.len(), 2, "{heard:?}");
    assert_eq!(
        (slow[0].status.as_str(), slow[0].name.as_str()),
        ("running", "Slow")
    );
    assert_eq!(slow[1].status, "stopped");
    assert_eq!(slow[1].error.as_deref(), Some(handoff::STOPPED_BY_YOU));
    assert!(slow[1].finished_at.is_some());
}

#[tokio::test]
async fn only_the_agents_still_running_are_listed() {
    let chat = Chat::new(Vec::new(), &[]).await;
    chat.save_agent(researcher()).await;
    let start = |agent: &'static str, task: &'static str| {
        let (pool, enc, conversation) = (
            chat.state.db.clone(),
            chat.state.encryption.clone(),
            chat.conversation.clone(),
        );
        async move {
            agent_calls::start_agent_call(
                &pool,
                &enc,
                &agent_calls::AgentCallStart {
                    run_id: None,
                    workflow_id: None,
                    step_id: None,
                    conversation_id: Some(&conversation),
                    kind: "helper",
                    agent_id: agent,
                    parent_id: None,
                    task,
                    model: None,
                    request_id: None,
                },
            )
            .await
            .unwrap()
        }
    };
    let finished = start("researcher", "old task").await;
    let first = start("researcher", "first task").await;
    tokio::time::sleep(Duration::from_millis(5)).await;
    let second = start("nobody", "second task").await;
    agent_calls::finish_agent_call(
        &chat.state.db,
        &finished,
        &agent_calls::AgentCallEnd {
            tokens: 0,
            usage: HandoffTokens::default(),
            error: None,
            stopped: false,
        },
    )
    .await
    .unwrap();

    let running = conduit_desktop::agents::calls::running(&chat.state.db, &chat.state.encryption)
        .await
        .unwrap();
    let ids: Vec<&str> = running.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids, [second.as_str(), first.as_str()], "newest first");
    assert_eq!(running[1].name, "Researcher");
    assert_eq!(running[1].task, "first task");
    assert_eq!(running[0].name, "nobody", "an unknown agent keeps its id");
    assert!(running.iter().all(|c| c.status == "running"));
}

#[tokio::test]
async fn a_reloaded_turn_gets_the_finish_times_of_its_helpers_tool_calls_too() {
    use conduit_desktop::db::repository::tool_calls;
    use provider_core::schema::{ToolCallRecord, ToolCallStatus};

    let chat = Chat::new(
        vec![
            tool_round(vec![("ask_writer", json!({ "task": "Write it up" }))]),
            tool_round(vec![("ask_researcher", json!({ "task": "Get the facts" }))]),
            text_round("Facts."),
            text_round("Written."),
            text_round("All done."),
        ],
        &["writer"],
    )
    .await;
    chat.save_agent(researcher()).await;
    chat.save_agent(json!({
        "id": "writer", "name": "Writer", "instructions": "Write.", "agents": ["researcher"]
    }))
    .await;
    let (result, _) = chat.run(chat.request(&[]), None).await;
    result.unwrap();

    let request_of = |agent: &'static str| {
        let pool = chat.state.db.clone();
        async move {
            sqlx::query_scalar::<_, String>("SELECT request_id FROM agent_calls WHERE agent_id = ?")
                .bind(agent)
                .fetch_one(&pool)
                .await
                .unwrap()
        }
    };
    let record = |id: &str, request_id: &str, at: &str| ToolCallRecord {
        id: id.into(),
        tool_id: "web_search".into(),
        request_id: request_id.into(),
        status: ToolCallStatus::Completed,
        arguments: None,
        result: None,
        error: None,
        approved_at: None,
        completed_at: Some(at.into()),
    };
    for rec in [
        record("lead-tool", "turn-1", "2026-10-21T10:00:01.000Z"),
        record(
            "writer-tool",
            &request_of("writer").await,
            "2026-10-21T10:00:02.000Z",
        ),
        record(
            "researcher-tool",
            &request_of("researcher").await,
            "2026-10-21T10:00:03.000Z",
        ),
        record("elsewhere", "some-other-turn", "2026-10-21T10:00:04.000Z"),
    ] {
        tool_calls::insert_tool_call(&chat.state.db, &rec)
            .await
            .unwrap();
    }

    let log = conduit_desktop::commands::chat::request_event_log(
        &chat.state,
        &chat.conversation,
        "turn-1",
    )
    .await
    .unwrap();
    assert!(!log.events.is_empty());
    for id in ["lead-tool", "writer-tool", "researcher-tool"] {
        assert!(log.tool_finished_at.contains_key(id), "{id} is missing");
    }
    assert!(!log.tool_finished_at.contains_key("elsewhere"));
    assert_eq!(
        log.tool_finished_at["researcher-tool"],
        "2026-10-21T10:00:03.000Z"
    );
}

// ── An agent's own notes and collections ─────────────────────────────────────

fn remembering(id: &str, name: &str) -> Value {
    json!({ "id": id, "name": name, "instructions": "Keep track.", "tools": ["calculator"], "memory": true })
}

/// Save a note in `agent`'s own memory; its id.
async fn note(chat: &Chat, agent: &str, body: &str) -> String {
    use conduit_desktop::db::repository::memory::{self, MemoryKind, MemoryStatus, NewMemory};
    memory::create(
        &chat.state.db,
        &chat.state.encryption,
        NewMemory {
            kind: MemoryKind::Note,
            body: body.to_string(),
            source_conversation_id: None,
            pinned: false,
            status: MemoryStatus::Active,
            scope: memory::agent_scope(agent),
            origin: None,
        },
    )
    .await
    .unwrap()
    .id
}

async fn notes_of(
    chat: &Chat,
    agent: &str,
) -> Vec<conduit_desktop::db::repository::memory::MemoryItem> {
    use conduit_desktop::db::repository::memory;
    memory::list_in(
        &chat.state.db,
        &chat.state.encryption,
        None,
        &memory::agent_scope(agent),
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn a_turn_as_an_agent_that_remembers_sees_its_notes_and_keeps_new_ones_at_once() {
    use conduit_desktop::db::repository::memory::{self, MemoryOrigin, MemoryStatus};
    let chat = Chat::new(
        vec![
            tool_round(vec![(
                "remember",
                json!({ "fact": "The user follows Rust releases." }),
            )]),
            text_round("Noted."),
        ],
        &[],
    )
    .await;
    chat.save_agent(remembering("researcher", "Researcher"))
        .await;
    chat.save_agent(remembering("writer", "Writer")).await;
    let kept = note(&chat, "researcher", "Last report covered Rust 1.80.").await;
    note(&chat, "writer", "WRITER-ONLY note.").await;
    // Chat offers its global `remember`; the agent gets its own instead.
    let (result, _) = chat
        .run(
            chat.request(&["remember", "current_time"]),
            Some("researcher"),
        )
        .await;
    result.unwrap();

    let requests = chat.requests();
    let system = requests[0].system_prompt.as_deref().unwrap();
    assert!(system.contains("## Your notes"), "{system}");
    assert!(
        system.contains(&format!("[{kept}] Last report covered Rust 1.80.")),
        "{system}"
    );
    assert!(system.contains("untrusted guidance"), "{system}");
    assert!(
        !system.contains("WRITER-ONLY"),
        "another agent's notes stay out"
    );
    assert_eq!(
        tool_names(&requests[0]),
        vec!["calculator", "forget", "remember"]
    );
    let remember = requests[0]
        .tool_definitions
        .iter()
        .find(|d| d.name == "remember")
        .unwrap();
    assert!(
        remember.description.contains("replaces"),
        "the agent's own remember"
    );

    let notes = notes_of(&chat, "researcher").await;
    assert_eq!(notes.len(), 2);
    let new = notes
        .iter()
        .find(|n| n.body == "The user follows Rust releases.")
        .unwrap();
    assert_eq!(new.status, MemoryStatus::Active, "used at once, not queued");
    assert_eq!(new.origin, Some(MemoryOrigin::Chat));
    assert!(
        memory::list(&chat.state.db, &chat.state.encryption, None)
            .await
            .unwrap()
            .is_empty(),
        "nothing is waiting on the Memory page"
    );
}

/// A round calling the tools in `calls`, read when the round is played (for
/// ids made after the script was).
fn tool_round_later(calls: Arc<Mutex<Vec<(&'static str, Value)>>>) -> Round {
    Arc::new(move |rid: &str| {
        let now = calls.lock().unwrap().clone();
        tool_round(now)(rid)
    })
}

#[tokio::test]
async fn an_agent_replaces_and_forgets_only_its_own_notes() {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let chat = Chat::new(
        vec![tool_round_later(calls.clone()), text_round("Done.")],
        &[],
    )
    .await;
    chat.save_agent(remembering("researcher", "Researcher"))
        .await;
    chat.save_agent(remembering("writer", "Writer")).await;
    let a = note(&chat, "researcher", "Covered 1.80.").await;
    let b = note(&chat, "researcher", "Stale note.").await;
    let w = note(&chat, "writer", "The writer's note.").await;
    *calls.lock().unwrap() = vec![
        (
            "remember",
            json!({ "fact": "Covered 1.81.", "replaces": a }),
        ),
        ("forget", json!({ "id": b })),
        ("remember", json!({ "fact": "Hijacked.", "replaces": w })),
        ("forget", json!({ "id": w })),
        ("forget", json!({ "id": "no-such-note" })),
    ];
    let (result, _) = chat.run(chat.request(&[]), Some("researcher")).await;
    result.unwrap();

    let mine = notes_of(&chat, "researcher").await;
    let bodies: Vec<&str> = mine.iter().map(|n| n.body.as_str()).collect();
    assert_eq!(
        bodies,
        vec!["Covered 1.81."],
        "replaced in place, the stale one gone"
    );
    assert_eq!(mine[0].id, a);
    let theirs = notes_of(&chat, "writer").await;
    assert_eq!(theirs.len(), 1);
    assert_eq!(theirs[0].body, "The writer's note.");

    let answered = &chat.requests()[1];
    assert!(mentions(
        answered,
        "isn't one of yours, so it can't be replaced"
    ));
    assert!(mentions(
        answered,
        "isn't one of yours, so it can't be forgotten"
    ));
    assert!(mentions(answered, "There is no note"));
}

#[tokio::test]
async fn an_agent_handed_a_task_in_chat_sees_its_notes_and_writes_to_them() {
    use conduit_desktop::db::repository::memory::MemoryOrigin;
    let chat = Chat::new(
        vec![
            tool_round(vec![(
                "ask_researcher",
                json!({ "task": "What's new in Rust?" }),
            )]),
            tool_round(vec![(
                "remember",
                json!({ "fact": "Told the user about 1.81." }),
            )]),
            text_round("1.81 is out."),
            text_round("Rust 1.81 is out."),
        ],
        &["researcher"],
    )
    .await;
    chat.save_agent(remembering("researcher", "Researcher"))
        .await;
    note(&chat, "researcher", "Last time: 1.80.").await;
    let (result, _) = chat.run(chat.request(&[]), None).await;
    result.unwrap();

    let requests = chat.requests();
    assert!(
        !requests[0]
            .system_prompt
            .as_deref()
            .unwrap()
            .contains("Your notes"),
        "the assistant isn't the agent"
    );
    assert!(
        !tool_names(&requests[0]).contains(&"remember".to_string()),
        "nor does it get the agent's tools"
    );
    let helper = &requests[1];
    let system = helper.system_prompt.as_deref().unwrap();
    assert!(
        system.contains("## Your notes") && system.contains("Last time: 1.80."),
        "{system}"
    );
    assert_eq!(tool_names(helper), vec!["calculator", "forget", "remember"]);
    let notes = notes_of(&chat, "researcher").await;
    let new = notes
        .iter()
        .find(|n| n.body == "Told the user about 1.81.")
        .expect("the helper's note");
    assert_eq!(new.origin, Some(MemoryOrigin::Chat));
}

#[tokio::test]
async fn an_agent_with_memory_off_gets_no_notes_and_no_note_tools() {
    let chat = Chat::new(vec![text_round("Hi.")], &[]).await;
    chat.save_agent(researcher()).await;
    note(&chat, "researcher", "LEFT-OVER note.").await;
    let (result, _) = chat
        .run(chat.request(&["remember"]), Some("researcher"))
        .await;
    result.unwrap();
    let request = &chat.requests()[0];
    assert!(!mentions(request, "LEFT-OVER"));
    assert!(!mentions(request, "Your notes"));
    assert_eq!(tool_names(request), vec!["calculator"]);
}

#[tokio::test]
async fn turning_memory_off_in_settings_turns_off_agents_notes_too() {
    let chat = Chat::new(vec![text_round("Hi.")], &[]).await;
    chat.save_agent(remembering("researcher", "Researcher"))
        .await;
    note(&chat, "researcher", "HIDDEN note.").await;
    let mut patch: provider_core::schema::SettingsPatch = serde_json::from_str("{}").unwrap();
    patch.memory_enabled = Some(false);
    chat.state.update_settings(patch).unwrap();
    let (result, _) = chat.run(chat.request(&[]), Some("researcher")).await;
    result.unwrap();
    let request = &chat.requests()[0];
    assert!(!mentions(request, "HIDDEN"));
    assert!(!mentions(request, "Your notes"));
    assert_eq!(tool_names(request), vec!["calculator"]);
}

#[tokio::test]
async fn an_agent_that_reads_collections_can_search_them_and_no_others() {
    use conduit_desktop::db::repository::knowledge;
    let chat = Chat::new(
        vec![
            tool_round(vec![("search_documents", json!({ "query": "garden" }))]),
            text_round("Nothing there."),
        ],
        &[],
    )
    .await;
    let made = |name: &'static str| {
        let pool = chat.state.db.clone();
        async move {
            knowledge::create_collection(
                &pool,
                knowledge::NewCollection {
                    name: name.to_string(),
                    provider_id: "ollama".to_string(),
                    embedding_model: "nomic-embed-text".to_string(),
                    embedding_dimensions: 4,
                },
            )
            .await
            .unwrap()
            .id
        }
    };
    let notes = made("Project notes").await;
    made("Private diary").await;
    chat.save_agent(json!({
        "id": "reader", "name": "Reader", "instructions": "Answer from the documents.",
        "knowledge": [notes]
    }))
    .await;
    let (result, _) = chat.run(chat.request(&[]), Some("reader")).await;
    result.unwrap();
    let requests = chat.requests();
    assert_eq!(tool_names(&requests[0]), vec!["search_documents"]);
    let search = &requests[0].tool_definitions[0];
    assert!(
        search.description.contains("\u{201c}Project notes\u{201d}"),
        "{}",
        search.description
    );
    assert!(!search.description.contains("Private diary"));
    // Nobody agreed to send documents to the embedding provider: the result
    // says so in words, and the turn goes on.
    assert!(
        mentions(&requests[1], "can't be searched until the user allows"),
        "{:?}",
        requests[1].messages.last()
    );
    assert!(!mentions(&requests[1], "Private diary"));
}

// ── Reviewing a chat's document ──────────────────────────────────────────────

impl Chat {
    /// A document of `kind` in this chat holding `text`.
    async fn document(&self, kind: &str, title: &str, text: &str) -> String {
        use conduit_desktop::db::repository::artifacts;
        let made = artifacts::create(&self.state.db, &self.conversation, kind, Some(title), None)
            .await
            .unwrap();
        artifacts::set_content(
            &self.state.db,
            &self.state.paths.artifacts,
            &self.state.encryption,
            &made.id,
            Some("text/markdown"),
            &artifacts::ArtifactContent::Text { text: text.into() },
        )
        .await
        .unwrap();
        made.id
    }

    async fn review(
        &self,
        artifact: &str,
        request: &str,
    ) -> Result<review::DocumentReview, String> {
        review::review_document(&self.state, &self.runtime, &self.manager, artifact, request).await
    }
}

use conduit_desktop::agents::review;

#[tokio::test]
async fn the_reviewer_reads_a_document_against_its_request_and_lists_what_to_change() {
    let chat = Chat::new(
        vec![text_round_using(
            r#"{"verdict":"issues","issues":[{"problem":"It is 240 words","change":"Cut it under 200"}]}"#,
            40,
        )],
        &[],
    )
    .await;
    let doc = chat
        .document("markdown", "Heater email", "Dear landlord, the heater...")
        .await;
    let found = chat
        .review(&doc, "An email under 200 words.")
        .await
        .unwrap();
    assert_eq!(found.reviewer, "Reviewer");
    assert_eq!(
        found.issues,
        vec![review::ReviewIssue {
            problem: "It is 240 words".into(),
            change: "Cut it under 200".into()
        }]
    );

    // The deleted Reviewer's starter stands in, with its web tools, and is
    // told what it reads and that the document is saved.
    let requests = chat.requests();
    assert_eq!(requests.len(), 1);
    let asked = &requests[0];
    assert!(asked
        .system_prompt
        .as_deref()
        .unwrap()
        .contains("You are Reviewer."));
    assert_eq!(tool_names(asked), vec!["web_fetch", "web_search"]);
    // (`mentions` reads the request as JSON, where a line break is `\n`.)
    assert!(mentions(asked, r"REQUEST:\nAn email under 200 words."));
    assert!(mentions(asked, r"DOCUMENT:\nDear landlord, the heater..."));
    assert!(mentions(
        asked,
        "already saved as a markdown document titled \u{201c}Heater email\u{201d}"
    ));

    // Recorded as an agent's task of its own, outside any chat.
    let calls = chat.calls().await;
    assert_eq!(calls.len(), 1);
    let (kind, agent, conversation, parent, _, status, error, tokens) = &calls[0];
    assert_eq!((kind.as_str(), agent.as_str()), ("helper", "reviewer"));
    assert_eq!((conversation, parent), (&None, &None));
    assert_eq!((status.as_str(), error), ("done", &None));
    assert_eq!(*tokens, 40);
}

#[tokio::test]
async fn the_users_own_reviewer_reviews_and_ok_means_nothing_to_change() {
    let chat = Chat::new(vec![text_round(r#"{"verdict":"ok","issues":[]}"#)], &[]).await;
    chat.save_agent(json!({
        "id": "reviewer", "name": "Strict editor", "instructions": "Be strict about length.",
        "tools": []
    }))
    .await;
    let doc = chat.document("text", "Notes", "Short notes.").await;
    let found = chat.review(&doc, "").await.unwrap();
    assert_eq!(found.reviewer, "Strict editor");
    assert!(found.issues.is_empty());
    let asked = &chat.requests()[0];
    assert!(asked
        .system_prompt
        .as_deref()
        .unwrap()
        .contains("You are Strict editor. Be strict about length."));
    assert!(tool_names(asked).is_empty());
    assert!(mentions(asked, "isn't known"));
}

#[tokio::test]
async fn only_a_document_with_text_is_reviewed() {
    let chat = Chat::new(vec![], &[]).await;
    let app = chat.document("app", "Timer", "<html></html>").await;
    assert_eq!(
        chat.review(&app, "a timer").await.unwrap_err(),
        "Only documents can be reviewed."
    );
    let empty = chat.document("markdown", "Blank", "   ").await;
    assert_eq!(
        chat.review(&empty, "x").await.unwrap_err(),
        "The document is empty."
    );
    assert_eq!(
        chat.review("missing", "x").await.unwrap_err(),
        "That document no longer exists."
    );
    assert!(chat.requests().is_empty());
}

#[tokio::test]
async fn a_turn_that_panics_ends_with_an_error_and_no_agent_keeps_working() {
    let chat = Chat::new(
        vec![
            tool_round(vec![("ask_writer", json!({ "task": "Write it up" }))]),
            tool_round(vec![("ask_researcher", json!({ "task": "Get the facts" }))]),
            // The researcher's round panics, deep inside the lead's turn.
            Arc::new(|_: &str| -> Vec<ProviderEvent> {
                panic!("byte index 3 is not a char boundary")
            }),
        ],
        &["writer"],
    )
    .await;
    chat.save_agent(researcher()).await;
    chat.save_agent(json!({
        "id": "writer", "name": "Writer", "instructions": "Write.", "agents": ["researcher"]
    }))
    .await;
    let (result, events) = chat.run(chat.request(&[]), None).await;
    // The page is told once, with the turn's id, and the turn is over.
    result.expect("a panicked turn still ends in an event");
    let errors: Vec<&ProviderEvent> = events
        .iter()
        .filter(|e| matches!(e, ProviderEvent::Error { .. }))
        .collect();
    assert_eq!(errors.len(), 1, "{events:?}");
    match errors[0] {
        ProviderEvent::Error { request_id, error } => {
            assert_eq!(request_id, "turn-1");
            assert_eq!(error.message, handoff::TURN_PANICKED);
        }
        _ => unreachable!(),
    }
    // No row is left running; each failed with the reason.
    let calls = chat.calls().await;
    assert_eq!(calls.len(), 2, "{calls:?}");
    for call in &calls {
        assert_eq!(call.5, "failed", "{call:?}");
        assert_eq!(call.6.as_deref(), Some(handoff::TURN_PANICKED), "{call:?}");
    }
    let running = conduit_desktop::agents::calls::running(&chat.state.db, &chat.state.encryption)
        .await
        .unwrap();
    assert!(running.is_empty(), "{running:?}");
    // The conversation can take another turn.
    let mut again = chat.request(&[]);
    again.request_id = "turn-2".into();
    let (result, _) = chat.run(again, None).await;
    assert!(result.is_ok());
}
