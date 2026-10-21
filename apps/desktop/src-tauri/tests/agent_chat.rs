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
use std::time::Duration;

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
    AgentGuardrails, AppSettings, Message, MessagePart, MessagePartKind, MessageRole,
    PermissionLevel, ProviderError, ProviderEvent, ProviderRequest, ProviderUsage, ToolDefinition,
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
        patch.agent = Some(AgentGuardrails {
            handoff_agents: ids,
            ..AgentGuardrails::default()
        });
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
