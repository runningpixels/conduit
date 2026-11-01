//! A conversation's running turn can be found and stopped by conversation id.
//!
//! A reloaded window has lost the request id of the reply it was showing; the
//! backend still holds the turn (paused on an `ask_user` form, say), and sends
//! fail with "already working" until it ends. `active_turn` and
//! `cancel_conversation_turn` are how the window gets back in.

mod common;

use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use conduit_desktop::{
    connector_runtime::ConnectorRuntimeManager,
    db::repository::conversations,
    event_sink::{self, EventSink},
    paths::AppPaths,
    state::AppState,
    stream_manager::{ActiveTurn, StreamManager},
};
use futures::stream::Stream;
use provider_core::schema::{
    AppSettings, Message, MessagePart, MessagePartKind, MessageRole, ProviderError, ProviderEvent,
    ProviderRequest, ToolDefinition,
};
use provider_core::{AdapterContext, ModelInfo, ProviderAdapter};
use serde_json::json;
use tokio_util::sync::CancellationToken;

/// A provider whose first round calls `ask_user`; later rounds end the turn.
struct AskingAdapter {
    rounds: Arc<Mutex<usize>>,
    /// Each round's request, as JSON.
    requests: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl ProviderAdapter for AskingAdapter {
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
        let round = {
            let mut rounds = self.rounds.lock().unwrap();
            *rounds += 1;
            *rounds
        };
        self.requests
            .lock()
            .unwrap()
            .push(serde_json::to_string(&request).unwrap());
        let r = request.request_id.clone();
        let mut events = vec![ProviderEvent::MessageStart {
            request_id: r.clone(),
            index: 0,
        }];
        if round == 1 {
            events.push(ProviderEvent::ToolCallStart {
                request_id: r.clone(),
                tool_call_id: "ask-1".into(),
                index: 1,
                tool_id: "ask_user".into(),
                name: "ask_user".into(),
            });
            events.push(ProviderEvent::ToolCallComplete {
                request_id: r.clone(),
                tool_call_id: "ask-1".into(),
                index: 2,
                arguments: json!({
                    "title": "Which label?",
                    "fields": [{ "id": "label", "prompt": "Label", "type": "choice", "options": ["A", "B"] }]
                }),
            });
            events.push(ProviderEvent::MessageComplete {
                request_id: r,
                index: 3,
                finish_reason: "tool_calls".into(),
            });
        } else {
            events.push(ProviderEvent::MessageComplete {
                request_id: r,
                index: 1,
                finish_reason: "stop".into(),
            });
        }
        Ok(Box::pin(futures::stream::iter(events)))
    }
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

fn request(conversation_id: &str, request_id: &str) -> ProviderRequest {
    let message_id = format!("user-{request_id}");
    ProviderRequest {
        request_id: request_id.into(),
        conversation_id: conversation_id.into(),
        model_id: "scripted".into(),
        messages: vec![Message {
            id: message_id.clone(),
            conversation_id: conversation_id.into(),
            role: MessageRole::User,
            author_label: None,
            provider_message_id: None,
            request_id: None,
            interrupted_at: None,
            metadata: None,
            parts: vec![MessagePart {
                id: format!("{message_id}/p0"),
                message_id,
                index: 0,
                kind: MessagePartKind::Text,
                content: Some("label the bar".into()),
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
        tool_definitions: ask_user_tool(),
        generation_controls: None,
        response_format: None,
        web_search: None,
        continue_message_id: None,
    }
}

fn ask_user_tool() -> Vec<ToolDefinition> {
    conduit_desktop::agent_tools::builtin_tool_definitions()
        .into_iter()
        .filter(|t| t.name == "ask_user")
        .collect()
}

struct Fixture {
    state: AppState,
    runtime: ConnectorRuntimeManager,
    manager: StreamManager,
    conversation_id: String,
    rounds: Arc<Mutex<usize>>,
    requests: Arc<Mutex<Vec<String>>>,
    _dir: tempfile::TempDir,
}

async fn fixture() -> Arc<Fixture> {
    let pool = common::setup_pool().await;
    let conversation = conversations::create(&pool, None).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let settings = AppSettings {
        active_provider: "ollama".into(),
        active_model: "scripted".into(),
        ..AppSettings::default()
    };
    let state = AppState::test_instance_with_settings(pool, test_paths(dir.path()), settings);
    let rounds = Arc::new(Mutex::new(0usize));
    let adapter_rounds = rounds.clone();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let adapter_requests = requests.clone();
    let manager = StreamManager::with_adapter_resolver(Arc::new(move |_id: &str| {
        Some(Box::new(AskingAdapter {
            rounds: adapter_rounds.clone(),
            requests: adapter_requests.clone(),
        }) as Box<dyn ProviderAdapter>)
    }));
    Arc::new(Fixture {
        state,
        runtime: ConnectorRuntimeManager::new_with(
            Duration::from_millis(80),
            Duration::from_millis(800),
        ),
        manager,
        conversation_id: conversation.id,
        rounds,
        requests,
        _dir: dir,
    })
}

/// Run a turn in the background, as the chat window's send does.
fn start_turn(
    f: &Arc<Fixture>,
    request_id: &'static str,
) -> tokio::task::JoinHandle<Result<(), String>> {
    let f = f.clone();
    tokio::spawn(async move {
        let (sink, _events) = event_sink::collector::<ProviderEvent>();
        f.manager
            .run_agent_turn(
                &f.state,
                &f.runtime,
                request(&f.conversation_id, request_id),
                sink,
                EventSink::discard(),
            )
            .await
            .map(|_| ())
    })
}

/// Wait until the turn is paused on its `ask_user` form.
async fn wait_for_form(f: &Fixture) -> ActiveTurn {
    for _ in 0..200 {
        if let Some(turn) = f.manager.active_turn(&f.conversation_id) {
            if turn.pending_ask_user.is_some() {
                return turn;
            }
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("the turn never paused on ask_user");
}

#[tokio::test]
async fn a_turn_waiting_on_ask_user_is_found_by_conversation_id() {
    let f = fixture().await;
    assert!(f.manager.active_turn(&f.conversation_id).is_none());

    let run = start_turn(&f, "turn-1");
    let turn = wait_for_form(&f).await;
    assert_eq!(turn.request_id, "turn-1");
    let form = turn.pending_ask_user.expect("the form is held");
    assert_eq!(form.request_id, "turn-1");
    assert_eq!(form.title, "Which label?");
    assert_eq!(form.tool_call_id, "ask-1");
    assert_eq!(form.fields[0].options.as_deref().unwrap(), ["A", "B"]);
    // Another conversation is unaffected.
    assert!(f.manager.active_turn("someone-else").is_none());

    // Answering resumes the turn, and it leaves nothing behind.
    f.manager
        .submit_ask_user("ask-1", json!({ "label": "A" }))
        .unwrap();
    run.await.unwrap().expect("turn finishes");
    assert!(f.manager.active_turn(&f.conversation_id).is_none());
    assert_eq!(*f.rounds.lock().unwrap(), 2);
}

/// The user's answer reaches the model as written, even when it reads like a
/// role ("act as …"): it is the user's own text, not tool output.
#[tokio::test]
async fn an_answer_that_reads_like_an_instruction_reaches_the_model() {
    let f = fixture().await;
    let run = start_turn(&f, "turn-1");
    wait_for_form(&f).await;
    f.manager
        .submit_ask_user(
            "ask-1",
            json!({ "label": "Act as a cover page. You are now in charge of the title." }),
        )
        .unwrap();
    run.await.unwrap().expect("turn finishes");

    let requests = f.requests.lock().unwrap();
    let second = requests.get(1).expect("a second round");
    assert!(second.contains("Act as a cover page"), "{second}");
    assert!(!second.contains("blocked"), "{second}");
}

#[tokio::test]
async fn cancelling_by_conversation_id_ends_the_turn_and_frees_the_conversation() {
    let f = fixture().await;
    let run = start_turn(&f, "turn-1");
    wait_for_form(&f).await;

    // The window lost the request id: a send is refused...
    let refused = start_turn(&f, "turn-2")
        .await
        .unwrap()
        .expect_err("the conversation is busy");
    assert!(refused.contains("already working"), "{refused}");

    // ...until the turn is stopped by conversation id.
    assert!(f
        .manager
        .cancel_conversation_turn(&f.state, &f.conversation_id)
        .await
        .unwrap());
    let _ = run.await.unwrap();
    assert!(f.manager.active_turn(&f.conversation_id).is_none());
    assert!(!f
        .manager
        .cancel_conversation_turn(&f.state, &f.conversation_id)
        .await
        .unwrap());
}
