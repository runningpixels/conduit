//! End-to-end tests for `workflows::runner`: real pages from a local server, a
//! scripted local model, and the real database, artifact storage and hidden
//! workflow conversation.

mod common;

use std::collections::HashMap;
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use conduit_desktop::{
    artifact_network::AddressPolicy,
    db::repository::{artifacts, conversations, workflows as repo},
    paths::AppPaths,
    state::AppState,
    stream_manager::StreamManager,
    workflows::ask::Questions,
    workflows::definition::WorkflowDefinition,
    workflows::permissions::{self, Decision, Permission, Reviews},
    workflows::runner::{Resume, RunBudget, Runner, Unattended},
    workflows::scheduler::{claim_due, run_claimed, run_due, to_iso, RunContext, RunningWorkflows},
};
use futures::stream::Stream;
use provider_core::schema::{
    AppSettings, KeychainMode, ProviderError, ProviderEvent, ProviderRequest,
};
use provider_core::{AdapterContext, ModelInfo, ProviderAdapter};
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

// ── A scripted local model ───────────────────────────────────────────────────

/// Answers every request by echoing what it was given: the first line inside
/// `<input>` (or the JSON `reply_json` when the prompt asks for JSON). Records
/// each request.
#[derive(Clone, Default)]
struct EchoModel {
    requests: Arc<Mutex<Vec<ProviderRequest>>>,
    reply_json: Option<&'static str>,
    /// Start replying, then say nothing more until the reply is cancelled.
    hang: bool,
    /// Report this many tokens used (input + output) with each reply.
    usage: Option<u64>,
    /// Answer with prose the first time JSON is asked for (the repair pass
    /// then gets `reply_json`).
    bad_json_first: bool,
    /// Fail this many replies with a provider error before answering.
    failures: Arc<std::sync::atomic::AtomicUsize>,
    /// Call this tool (name, arguments) first; answer once a tool result is in.
    tool_call: Option<(&'static str, Value)>,
    /// The provider id this copy was resolved for (set by the harness's
    /// adapter resolver); cloud ones report `is_local() == false`.
    tag: String,
    /// (provider, model) of every call, shared by all copies.
    calls: Arc<Mutex<Vec<(String, String)>>>,
}

impl EchoModel {
    fn reply_for(&self, request: &ProviderRequest) -> String {
        let text = request
            .messages
            .last()
            .and_then(|m| m.parts.first())
            .and_then(|p| p.content.clone())
            .unwrap_or_default();
        if let (Some(json), true) = (self.reply_json, text.contains("wasn't valid JSON")) {
            return json.to_string();
        }
        if let (Some(json), true) = (self.reply_json, text.contains("JSON Schema")) {
            if self.bad_json_first {
                return "Sure! Here is what I found, as JSON-ish text.".to_string();
            }
            return format!("```json\n{json}\n```");
        }
        let input = text
            .split("<input>")
            .nth(1)
            .and_then(|rest| rest.split("</input>").next())
            .unwrap_or_default();
        let first = input
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .unwrap_or("(nothing)");
        format!("SUMMARY: {first}")
    }
}

#[async_trait]
impl ProviderAdapter for EchoModel {
    fn id(&self) -> &'static str {
        "ollama"
    }
    fn display_name(&self) -> &'static str {
        "Echo"
    }
    fn is_local(&self) -> bool {
        !matches!(self.tag.as_str(), "openrouter" | "openai")
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
        let reply = self.reply_for(&request);
        self.requests.lock().unwrap().push(request.clone());
        self.calls
            .lock()
            .unwrap()
            .push((self.tag.clone(), request.model_id.clone()));
        let r = request.request_id;
        // A compare-exchange loop rather than `fetch_update`, which newer
        // toolchains deprecate (renamed `try_update`) and older ones lack.
        let failing = {
            use std::sync::atomic::Ordering::SeqCst;
            let mut n = self.failures.load(SeqCst);
            loop {
                if n == 0 {
                    break false;
                }
                match self.failures.compare_exchange(n, n - 1, SeqCst, SeqCst) {
                    Ok(_) => break true,
                    Err(actual) => n = actual,
                }
            }
        };
        if let Some((name, arguments)) = &self.tool_call {
            let answered = request
                .messages
                .iter()
                .any(|m| m.role == provider_core::schema::MessageRole::Tool);
            if !answered {
                return Ok(Box::pin(futures::stream::iter(vec![
                    ProviderEvent::MessageStart {
                        request_id: r.clone(),
                        index: 0,
                    },
                    ProviderEvent::ContentDelta {
                        request_id: r.clone(),
                        block_id: "b0".into(),
                        index: 1,
                        content: "Let me check.".into(),
                    },
                    ProviderEvent::ToolCallStart {
                        request_id: r.clone(),
                        tool_call_id: "call-1".into(),
                        index: 2,
                        tool_id: (*name).into(),
                        name: (*name).into(),
                    },
                    ProviderEvent::ToolCallComplete {
                        request_id: r.clone(),
                        tool_call_id: "call-1".into(),
                        index: 3,
                        arguments: arguments.clone(),
                    },
                    ProviderEvent::MessageComplete {
                        request_id: r,
                        index: 4,
                        finish_reason: "tool_calls".into(),
                    },
                ])));
            }
        }
        if failing {
            return Ok(Box::pin(futures::stream::iter(vec![
                ProviderEvent::Error {
                    request_id: r,
                    error: ProviderError {
                        provider_code: None,
                        retryable: true,
                        message: "The model is busy.".into(),
                    },
                },
            ])));
        }
        if self.hang {
            use futures::StreamExt;
            let start = ProviderEvent::MessageStart {
                request_id: r.clone(),
                index: 0,
            };
            let end = async move {
                cancel.cancelled().await;
                ProviderEvent::MessageComplete {
                    request_id: r,
                    index: 1,
                    finish_reason: "cancelled".into(),
                }
            };
            return Ok(Box::pin(
                futures::stream::iter(vec![start]).chain(futures::stream::once(end)),
            ));
        }
        let events = vec![
            ProviderEvent::MessageStart {
                request_id: r.clone(),
                index: 0,
            },
            ProviderEvent::ContentBlockStart {
                request_id: r.clone(),
                block_id: "b0".into(),
                index: 1,
                block_kind: "text".into(),
            },
            ProviderEvent::ContentDelta {
                request_id: r.clone(),
                block_id: "b0".into(),
                index: 2,
                content: reply,
            },
            ProviderEvent::ContentBlockStop {
                request_id: r.clone(),
                block_id: "b0".into(),
                index: 3,
            },
            ProviderEvent::Usage {
                request_id: r.clone(),
                usage: serde_json::from_value(json!({
                    "inputTokens": self.usage.unwrap_or(0) / 2,
                    "outputTokens": self.usage.unwrap_or(0) - self.usage.unwrap_or(0) / 2,
                }))
                .unwrap(),
            },
            ProviderEvent::MessageComplete {
                request_id: r,
                index: 4,
                finish_reason: "stop".into(),
            },
        ];
        Ok(Box::pin(futures::stream::iter(events)))
    }
}

// ── A local web server ───────────────────────────────────────────────────────

/// Answers every request with the next status in `statuses` (the last one
/// repeats) and counts the requests.
async fn serve_statuses(statuses: Vec<u16>) -> (String, Arc<std::sync::atomic::AtomicUsize>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let hits = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = hits.clone();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let n = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let status = statuses[n.min(statuses.len() - 1)];
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let _ = socket.read(&mut buf).await;
                let body = if status == 200 { PAGE_B } else { "nope" };
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    (format!("http://{addr}"), hits)
}

/// Accepts connections and never answers, like a site that hangs.
async fn serve_hanging() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let mut open = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            open.push(socket);
        }
    });
    format!("http://{addr}")
}

/// Serves `pages` (path → HTML) on loopback; anything else is a 404.
async fn serve(pages: Vec<(&'static str, &'static str)>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let pages: Arc<HashMap<&str, &str>> = Arc::new(pages.into_iter().collect());
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let pages = pages.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                let (status, body) = match pages.get(path.as_str()) {
                    Some(body) => ("200 OK", body.to_string()),
                    None => ("404 Not Found", "missing".to_string()),
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    format!("http://{addr}")
}

const PAGE_A: &str = "<html><head><title>Rust news</title><script>track()</script></head><body>\
<nav>Home | About</nav><article><h1>Rust 2.0 ships</h1><p>The release adds many things.</p></article></body></html>";
const PAGE_B: &str = "<html><head><title>Weather</title></head><body><main><p>Sunny all week.</p></main></body></html>";

// ── Setup ────────────────────────────────────────────────────────────────────

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

struct Harness {
    state: AppState,
    streams: StreamManager,
    model: EchoModel,
    reviews: Reviews,
    _dir: tempfile::TempDir,
}

impl Harness {
    async fn new(model: EchoModel) -> Self {
        Self::new_with(model, true, &[]).await
    }

    /// Active model ollama/echo; `keys` are cloud providers given a (fake) key.
    /// Credentials live in a file store under the test's directory, never the
    /// OS keychain.
    async fn new_with(model: EchoModel, local_only: bool, keys: &[&str]) -> Self {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let pool = common::setup_pool().await;
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var(
            conduit_desktop::credentials::FILE_KEY_ENV,
            STANDARD.encode([7u8; 32]),
        );
        let store = conduit_desktop::credentials::CredentialStore::default_service()
            .with_mode(KeychainMode::File)
            .with_data_dir(dir.path());
        for key in keys {
            store
                .save_provider_secret(key, "sk-test-not-a-real-key")
                .unwrap();
        }
        let settings = AppSettings {
            active_provider: "ollama".into(),
            active_model: "echo".into(),
            local_only,
            keychain_mode: KeychainMode::File,
            ..AppSettings::default()
        };
        let state = AppState::test_instance_with_settings(pool, test_paths(dir.path()), settings);
        let resolver_model = model.clone();
        let streams = StreamManager::with_adapter_resolver(Arc::new(move |id: &str| {
            let tagged = EchoModel {
                tag: id.to_string(),
                ..resolver_model.clone()
            };
            Some(Box::new(tagged) as Box<dyn ProviderAdapter>)
        }));
        Self {
            state,
            streams,
            model,
            reviews: Reviews::default(),
            _dir: dir,
        }
    }

    async fn save(&self, definition: Value) -> String {
        repo::create(
            &self.state.db,
            &self.state.encryption,
            "Morning briefing",
            None,
            &definition,
        )
        .await
        .unwrap()
        .id
    }

    async fn run(&self, id: &str) -> repo::WorkflowRunDetail {
        let runner = Runner {
            state: &self.state,
            streams: &self.streams,
            fetch_policy: AddressPolicy { public_only: false },
            stop: Default::default(),
            unattended: None,
            budget: RunBudget::default(),
            notify: None,
            questions: None,
            connectors: None,
        };
        runner
            .run(id, &HashMap::new(), "manual")
            .await
            .expect("the run starts")
    }
}

fn briefing(base: &str) -> Value {
    json!({
        "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/a"), format!("{base}/b")] },
            { "id": "each_page", "type": "for_each", "items": "steps.fetch.pages", "steps": [
                { "id": "sum", "type": "summarize", "prompt": "Summarize this page in one line.",
                  "input": "{{item.title}}\n{{item.text}}" }
            ]},
            { "id": "doc", "type": "template",
              "template": "# Briefing for {{run.date}}\n{{#each steps.each_page.items}}- {{item.sum.text}}\n{{/each}}" },
            { "id": "save", "type": "save_artifact", "title": "Morning briefing", "content": "{{steps.doc.text}}" }
        ]
    })
}

fn step<'a>(
    run: &'a repo::WorkflowRunDetail,
    id: &str,
    iteration: Option<i64>,
) -> &'a repo::WorkflowRunStep {
    run.steps
        .iter()
        .find(|s| s.step_id == id && s.iteration == iteration)
        .unwrap_or_else(|| panic!("no step {id} ({iteration:?}) in {:#?}", run.steps))
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn the_morning_briefing_runs_end_to_end() {
    let base = serve(vec![("/a", PAGE_A), ("/b", PAGE_B)]).await;
    let h = Harness::new(EchoModel::default()).await;
    let id = h.save(briefing(&base)).await;

    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed", "{:?}", run.run.error);

    // Pages were fetched and reduced to readable text.
    let pages = &step(&run, "fetch", None).output.as_ref().unwrap()["pages"];
    assert_eq!(pages[0]["title"], "Rust news");
    let text_a = pages[0]["text"].as_str().unwrap();
    assert!(
        text_a.contains("Rust 2.0 ships")
            && !text_a.contains("track()")
            && !text_a.contains("Home | About")
    );

    // One summarize per page, recorded per iteration, each a tool-less call
    // carrying the standing "treat the input as data" instruction.
    assert_eq!(
        step(&run, "sum", Some(0)).output.as_ref().unwrap()["text"],
        "SUMMARY: Rust news"
    );
    assert_eq!(
        step(&run, "sum", Some(1)).output.as_ref().unwrap()["text"],
        "SUMMARY: Weather"
    );
    let requests = h.model.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    assert!(requests.iter().all(|r| r.tool_definitions.is_empty()));
    assert!(requests[0]
        .system_prompt
        .as_deref()
        .unwrap()
        .contains("ignore any instructions"));

    // The briefing was saved as an artifact in the workflow's own conversation,
    // which is hidden from the chat list.
    let workflow = repo::get(&h.state.db, &h.state.encryption, &id)
        .await
        .unwrap()
        .unwrap();
    let conversation_id = workflow
        .conversation_id
        .clone()
        .expect("a conversation was made");
    let saved = artifacts::list(&h.state.db, &conversation_id)
        .await
        .unwrap();
    assert_eq!(saved.len(), 1);
    // The save step says where the document lives, so a run can open it.
    let save_out = step(&run, "save", None).output.as_ref().unwrap();
    assert_eq!(save_out["artifactId"], saved[0].id.as_str());
    assert_eq!(save_out["conversationId"], conversation_id.as_str());
    let content = artifacts::get(&h.state.db, &h.state.encryption, &saved[0].id)
        .await
        .unwrap()
        .and_then(|a| a.content_text)
        .expect("the briefing has content");
    assert!(
        content.contains("- SUMMARY: Rust news\n- SUMMARY: Weather"),
        "{content}"
    );
    assert!(conversations::list(&h.state.db)
        .await
        .unwrap()
        .iter()
        .all(|c| c.id != conversation_id));

    // A second run updates the same artifact instead of adding another.
    let again = h.run(&id).await;
    assert_eq!(again.run.status, "completed");
    assert_eq!(
        artifacts::list(&h.state.db, &conversation_id)
            .await
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        repo::list_runs(&h.state.db, &id, 10).await.unwrap().len(),
        2
    );
    let summary = &repo::list(&h.state.db).await.unwrap()[0];
    assert_eq!(summary.last_run_status.as_deref(), Some("completed"));
}

#[tokio::test]
async fn a_failed_step_fails_the_run_unless_it_says_skip() {
    let base = serve(vec![]).await;
    let h = Harness::new(EchoModel::default()).await;
    let failing = h
        .save(json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/gone")] },
            { "id": "after", "type": "template", "template": "never" }
        ]}))
        .await;
    let run = h.run(&failing).await;
    assert_eq!(run.run.status, "failed");
    assert!(
        run.run.error.as_deref().unwrap().contains("404"),
        "{:?}",
        run.run.error
    );
    assert_eq!(step(&run, "fetch", None).status, "failed");
    assert!(
        run.steps.iter().all(|s| s.step_id != "after"),
        "the run stopped at the failure"
    );

    let skipping = h
        .save(json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/gone")], "onError": "skip" },
            { "id": "after", "type": "template", "template": "went on: {{steps.fetch.error}}" }
        ]}))
        .await;
    let run = h.run(&skipping).await;
    assert_eq!(run.run.status, "completed");
    let after = step(&run, "after", None).output.as_ref().unwrap()["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        after.starts_with("went on: None of the pages could be fetched"),
        "{after}"
    );
}

#[tokio::test]
async fn a_schema_turns_the_reply_into_data() {
    let model = EchoModel {
        reply_json: Some(r#"{"mood": "calm", "score": 3}"#),
        ..Default::default()
    };
    let h = Harness::new(model).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "rate", "type": "summarize", "prompt": "Rate the mood.", "input": "A quiet day.",
              "schema": { "type": "object", "properties": { "mood": { "type": "string" } } } },
            { "id": "out", "type": "template", "template": "{{steps.rate.data.mood}} ({{steps.rate.data.score}})" }
        ]}))
        .await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed", "{:?}", run.run.error);
    assert_eq!(
        step(&run, "out", None).output.as_ref().unwrap()["text"],
        "calm (3)"
    );
}

#[tokio::test]
async fn an_invalid_definition_does_not_start_a_run() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [ { "id": "a", "type": "template", "template": "{{steps.b.text}}" } ]}))
        .await;
    let runner = Runner {
        state: &h.state,
        streams: &h.streams,
        fetch_policy: AddressPolicy { public_only: false },
        stop: Default::default(),
        unattended: None,
        budget: RunBudget::default(),
        notify: None,
        questions: None,
        connectors: None,
    };
    let err = runner
        .run(&id, &HashMap::new(), "manual")
        .await
        .unwrap_err();
    assert!(err.contains("reads steps.b.text"), "{err}");
    assert!(repo::list_runs(&h.state.db, &id, 10)
        .await
        .unwrap()
        .is_empty());
}

// ── Scheduling ───────────────────────────────────────────────────────────────

use chrono::{DateTime, FixedOffset, Utc};

fn utc(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
}

/// A model-free workflow that saves one document.
fn saving_workflow() -> Value {
    json!({ "steps": [
        { "id": "doc", "type": "template", "template": "Report for {{run.date}}" },
        { "id": "save", "type": "save_artifact", "title": "Daily report", "content": "{{steps.doc.text}}" }
    ]})
}

impl Harness {
    /// Schedule `id`, approving everything it needs (as turning a schedule on
    /// in the app does).
    async fn schedule(&self, id: &str, spec: Value, enabled: bool, next_run_at: &str) {
        repo::put_schedule(&self.state.db, id, &spec, enabled, Some(next_run_at))
            .await
            .unwrap();
        let required = self.required(id).await;
        repo::set_permissions(&self.state.db, &self.state.encryption, id, &required)
            .await
            .unwrap();
    }

    async fn required(&self, id: &str) -> Vec<Permission> {
        let workflow = repo::get(&self.state.db, &self.state.encryption, id)
            .await
            .unwrap()
            .unwrap();
        let def: WorkflowDefinition = serde_json::from_value(workflow.definition).unwrap();
        permissions::required(
            &def,
            &permissions::Context {
                search_backend: "duckduckgo",
                provider: "ollama",
                model: "echo",
                configured: None,
            },
        )
    }

    async fn tick(
        &self,
        running: &std::sync::Arc<RunningWorkflows>,
        now: &str,
    ) -> Vec<conduit_desktop::workflows::scheduler::RunFinished> {
        let tz = FixedOffset::east_opt(2 * 3600).unwrap();
        run_due(
            &self.state,
            &self.streams,
            running,
            &self.reviews,
            AddressPolicy { public_only: false },
            utc(now),
            &tz,
        )
        .await
    }
}

#[tokio::test]
async fn a_due_schedule_runs_once_and_moves_to_the_next_slot() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h.save(saving_workflow()).await;
    // 08:00 at +02:00 is 06:00Z.
    h.schedule(
        &id,
        json!({ "kind": "daily", "time": "08:00" }),
        true,
        "2026-09-29T06:00:00.000Z",
    )
    .await;
    let running = std::sync::Arc::new(RunningWorkflows::default());

    // Not due yet: nothing happens.
    assert!(h.tick(&running, "2026-09-29T05:59:00Z").await.is_empty());

    let finished = h.tick(&running, "2026-09-29T06:00:30Z").await;
    assert_eq!(finished.len(), 1);
    let event = &finished[0];
    assert_eq!(event.status, "completed", "{:?}", event.error);
    assert_eq!(event.trigger, "schedule");
    assert_eq!(event.workflow_name, "Morning briefing");
    assert_eq!(event.documents.len(), 1);
    assert_eq!(event.documents[0].title, "Daily report");

    let runs = repo::list_runs(&h.state.db, &id, 10).await.unwrap();
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0].trigger, "schedule");
    let schedule = repo::get_schedule(&h.state.db, &id).await.unwrap().unwrap();
    assert_eq!(
        schedule.next_run_at.as_deref(),
        Some("2026-09-30T06:00:00.000Z")
    );
    assert_eq!(
        schedule.last_run_at.as_deref(),
        Some(to_iso(utc("2026-09-29T06:00:30Z")).as_str())
    );
    // The list shows when it runs next.
    let summary = repo::list(&h.state.db)
        .await
        .unwrap()
        .into_iter()
        .find(|w| w.id == id)
        .unwrap();
    assert_eq!(
        summary.next_run_at.as_deref(),
        Some("2026-09-30T06:00:00.000Z")
    );

    // Ticking again straight away doesn't run it a second time.
    assert!(h.tick(&running, "2026-09-29T06:01:00Z").await.is_empty());
}

#[tokio::test]
async fn missed_mornings_turn_into_one_catch_up_run() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h.save(saving_workflow()).await;
    h.schedule(
        &id,
        json!({ "kind": "daily", "time": "08:00" }),
        true,
        "2026-09-26T06:00:00.000Z",
    )
    .await;
    let running = std::sync::Arc::new(RunningWorkflows::default());

    // Conduit was closed for three mornings.
    let finished = h.tick(&running, "2026-09-29T10:00:00Z").await;
    assert_eq!(finished.len(), 1);
    assert_eq!(finished[0].trigger, "catch_up");
    assert_eq!(
        repo::list_runs(&h.state.db, &id, 10).await.unwrap().len(),
        1
    );
    let schedule = repo::get_schedule(&h.state.db, &id).await.unwrap().unwrap();
    assert_eq!(
        schedule.next_run_at.as_deref(),
        Some("2026-09-30T06:00:00.000Z")
    );
}

#[tokio::test]
async fn a_workflow_already_running_skips_its_slot() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h.save(saving_workflow()).await;
    h.schedule(
        &id,
        json!({ "kind": "interval", "hours": 2 }),
        true,
        "2026-09-29T06:00:00.000Z",
    )
    .await;
    let running = std::sync::Arc::new(RunningWorkflows::default());
    let manual = running.try_start(&id).expect("free");

    let finished = h.tick(&running, "2026-09-29T06:00:10Z").await;
    assert_eq!(finished[0].status, "skipped");
    assert!(repo::list_runs(&h.state.db, &id, 10)
        .await
        .unwrap()
        .is_empty());
    // The slot is used up; the next one is two hours on.
    let schedule = repo::get_schedule(&h.state.db, &id).await.unwrap().unwrap();
    assert_eq!(
        schedule.next_run_at.as_deref(),
        Some("2026-09-29T08:00:10.000Z")
    );

    drop(manual);
    assert!(
        running.try_start(&id).is_some(),
        "the guard frees the workflow when dropped"
    );
}

#[tokio::test]
async fn a_schedule_that_is_off_does_not_run() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h.save(saving_workflow()).await;
    h.schedule(
        &id,
        json!({ "kind": "daily", "time": "08:00" }),
        false,
        "2026-09-29T06:00:00.000Z",
    )
    .await;
    let running = std::sync::Arc::new(RunningWorkflows::default());
    assert!(h.tick(&running, "2026-09-30T12:00:00Z").await.is_empty());
    assert!(repo::list_runs(&h.state.db, &id, 10)
        .await
        .unwrap()
        .is_empty());
    let summary = repo::list(&h.state.db)
        .await
        .unwrap()
        .into_iter()
        .find(|w| w.id == id)
        .unwrap();
    assert_eq!(
        summary.next_run_at, None,
        "a schedule that is off shows no next run"
    );
}

#[tokio::test]
async fn deleting_a_workflow_deletes_its_schedule() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h.save(saving_workflow()).await;
    h.schedule(
        &id,
        json!({ "kind": "daily", "time": "08:00" }),
        true,
        "2026-09-29T06:00:00.000Z",
    )
    .await;
    repo::delete(&h.state.db, &id).await.unwrap();
    assert!(repo::get_schedule(&h.state.db, &id)
        .await
        .unwrap()
        .is_none());
    assert_eq!(repo::earliest_next_run(&h.state.db).await.unwrap(), None);
}

// ── Stopping a run ───────────────────────────────────────────────────────────

impl Harness {
    /// Run `id` with `stop`, stopping it after `after`; the run must end soon.
    async fn run_and_stop(&self, id: &str, after: std::time::Duration) -> repo::WorkflowRunDetail {
        let stop = CancellationToken::new();
        let runner = Runner {
            state: &self.state,
            streams: &self.streams,
            fetch_policy: AddressPolicy { public_only: false },
            stop: stop.clone(),
            unattended: None,
            budget: RunBudget::default(),
            notify: None,
            questions: None,
            connectors: None,
        };
        let no_inputs = HashMap::new();
        let stopper = async {
            tokio::time::sleep(after).await;
            stop.cancel();
        };
        let (detail, ()) = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            tokio::join!(runner.run(id, &no_inputs, "manual"), stopper)
        })
        .await
        .expect("a stopped run ends promptly");
        detail.expect("the run starts")
    }
}

#[tokio::test]
async fn stopping_a_run_mid_fetch_ends_it_as_stopped_even_when_the_step_may_fail() {
    let h = Harness::new(EchoModel::default()).await;
    let base = serve_hanging().await;
    let id = h
        .save(json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/slow")], "onError": "skip" },
            { "id": "after", "type": "template", "template": "never" },
        ]}))
        .await;
    let detail = h
        .run_and_stop(&id, std::time::Duration::from_millis(300))
        .await;
    assert_eq!(detail.run.status, "stopped");
    assert_eq!(
        detail.run.error.as_deref(),
        Some("Stopped before it finished.")
    );
    let steps: Vec<(&str, &str)> = detail
        .steps
        .iter()
        .map(|s| (s.step_id.as_str(), s.status.as_str()))
        .collect();
    assert_eq!(
        steps,
        vec![("fetch", "stopped")],
        "onError: skip doesn't swallow a stop, and nothing runs after it"
    );
}

#[tokio::test]
async fn stopping_a_run_mid_reply_cancels_the_model_call() {
    let model = EchoModel {
        hang: true,
        ..EchoModel::default()
    };
    let h = Harness::new(model).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "sum", "type": "summarize", "prompt": "Sum up", "input": "text" },
        ]}))
        .await;
    let detail = h
        .run_and_stop(&id, std::time::Duration::from_millis(300))
        .await;
    assert_eq!(detail.run.status, "stopped");
    assert_eq!(detail.steps[0].status, "stopped");
    assert_eq!(
        h.model.requests.lock().unwrap().len(),
        1,
        "the model was asked once"
    );
}

#[tokio::test]
async fn a_stop_before_the_run_starts_runs_no_step() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h.save(saving_workflow()).await;
    let detail = h.run_and_stop(&id, std::time::Duration::ZERO).await;
    // The stop can land before, during or just after the first step (an
    // instant template, which CI has finished before the stop arrived); either
    // way the run is stopped and the save step never runs.
    assert_eq!(detail.run.status, "stopped");
    assert!(
        detail
            .steps
            .iter()
            .all(|s| s.status == "stopped" || (s.step_id == "doc" && s.status == "completed")),
        "{:?}",
        detail
            .steps
            .iter()
            .map(|s| (&s.step_id, &s.status))
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn runs_left_running_by_a_quit_are_marked_failed_at_launch() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h.save(saving_workflow()).await;
    let run = repo::start_run(&h.state.db, &id, 1, "schedule")
        .await
        .unwrap();
    let step = repo::start_step(
        &h.state.db,
        &h.state.encryption,
        &run.id,
        "fetch",
        None,
        &json!({}),
    )
    .await
    .unwrap();
    let _ = step;
    assert_eq!(repo::fail_interrupted_runs(&h.state.db).await.unwrap(), 1);
    let detail = repo::get_run(&h.state.db, &h.state.encryption, &run.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(detail.run.status, "failed");
    assert_eq!(
        detail.run.error.as_deref(),
        Some("Conduit closed before this run finished.")
    );
    assert!(detail.run.finished_at.is_some());
    assert_eq!(detail.steps[0].status, "failed");
    assert_eq!(
        repo::fail_interrupted_runs(&h.state.db).await.unwrap(),
        0,
        "only once"
    );
}

#[test]
fn running_workflows_count_stop_and_report_changes() {
    let running = Arc::new(RunningWorkflows::default());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    running.set_listener(move |n| log.lock().unwrap().push(n));

    let a = running.try_start("a").unwrap();
    let b = running.try_start("b").unwrap();
    assert!(running.try_start("a").is_none());
    assert_eq!(running.count(), 2);

    assert!(running.stop("a"));
    assert!(a.stop_token().is_cancelled());
    assert!(!b.stop_token().is_cancelled());
    assert!(!running.stop("nope"));
    assert_eq!(running.stop_all(), 2);
    assert!(b.stop_token().is_cancelled());

    drop(a);
    drop(b);
    assert_eq!(running.count(), 0);
    assert_eq!(*seen.lock().unwrap(), vec![1, 2, 1, 0]);
}

// ── Unattended runs: approvals, questions, budgets ──────────────────────────

impl Harness {
    /// Run `id` as nobody-is-watching, approved for `approved`.
    fn unattended_runner(&self, approved: Vec<Permission>, stop: CancellationToken) -> Runner<'_> {
        let mut unattended = Unattended::new(&self.reviews, approved);
        unattended.wait = std::time::Duration::from_secs(5);
        Runner {
            state: &self.state,
            streams: &self.streams,
            fetch_policy: AddressPolicy { public_only: false },
            stop,
            unattended: Some(unattended),
            budget: RunBudget::default(),
            notify: None,
            questions: None,
            connectors: None,
        }
    }

    /// Wait until a run is asking; returns its review.
    async fn next_review(&self) -> permissions::PendingReview {
        for _ in 0..200 {
            if let Some(review) = self.reviews.list().into_iter().next() {
                return review;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        panic!("no run asked");
    }
}

fn fetching_workflow(base: &str) -> Value {
    json!({ "steps": [
        { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/a")] },
        { "id": "save", "type": "save_artifact", "title": "Page", "content": "{{steps.fetch.text}}" },
    ]})
}

#[tokio::test]
async fn an_approved_unattended_run_asks_nothing() {
    let h = Harness::new(EchoModel::default()).await;
    let base = serve(vec![("/a", PAGE_A)]).await;
    let id = h.save(fetching_workflow(&base)).await;
    let approved = h.required(&id).await;
    assert_eq!(
        approved,
        vec![
            Permission::Host {
                host: "127.0.0.1".into()
            },
            Permission::SaveDocuments
        ]
    );
    let detail = h
        .unattended_runner(approved, CancellationToken::new())
        .run(&id, &HashMap::new(), "schedule")
        .await
        .unwrap();
    assert_eq!(detail.run.status, "completed");
    assert!(h.reviews.list().is_empty());
}

#[tokio::test]
async fn an_unapproved_step_pauses_the_run_and_allow_once_carries_on() {
    let h = Harness::new(EchoModel::default()).await;
    let base = serve(vec![("/a", PAGE_A)]).await;
    let id = h.save(fetching_workflow(&base)).await;
    let runner = h.unattended_runner(vec![Permission::SaveDocuments], CancellationToken::new());
    let no_inputs = HashMap::new();
    let run = runner.run(&id, &no_inputs, "schedule");
    let answer = async {
        let review = h.next_review().await;
        assert_eq!(review.step_id, "fetch");
        assert_eq!(review.workflow_name, "Morning briefing");
        assert_eq!(
            review.permission.permission,
            Permission::Host {
                host: "127.0.0.1".into()
            }
        );
        assert_eq!(review.url.as_deref(), Some(format!("{base}/a").as_str()));
        let runs = repo::list_runs(&h.state.db, &id, 1).await.unwrap();
        assert_eq!(runs[0].status, "paused", "the run shows it is waiting");
        assert!(h.reviews.answer(&review.run_id, Decision::AllowOnce));
    };
    let (detail, ()) = tokio::join!(run, answer);
    assert_eq!(detail.unwrap().run.status, "completed");
    assert!(
        repo::get_permissions(&h.state.db, &h.state.encryption, &id)
            .await
            .unwrap()
            .is_none(),
        "allowing once approves nothing for next time"
    );
}

#[tokio::test]
async fn always_allow_saves_the_permission_for_next_time() {
    let h = Harness::new(EchoModel::default()).await;
    let base = serve(vec![("/a", PAGE_A)]).await;
    let id = h.save(fetching_workflow(&base)).await;
    let runner = h.unattended_runner(vec![], CancellationToken::new());
    let no_inputs = HashMap::new();
    let run = runner.run(&id, &no_inputs, "schedule");
    let answer = async {
        for _ in 0..2 {
            let review = h.next_review().await;
            assert!(h.reviews.answer(&review.run_id, Decision::AlwaysAllow));
            // Let the run take the answer before looking for the next question.
            while !h.reviews.list().is_empty() {
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    };
    let (detail, ()) = tokio::join!(run, answer);
    assert_eq!(detail.unwrap().run.status, "completed");
    let (saved, _) = repo::get_permissions(&h.state.db, &h.state.encryption, &id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        saved,
        vec![
            Permission::Host {
                host: "127.0.0.1".into()
            },
            Permission::SaveDocuments
        ]
    );
}

#[tokio::test]
async fn deny_fails_the_step_and_nobody_answering_counts_as_deny() {
    let h = Harness::new(EchoModel::default()).await;
    let base = serve(vec![("/a", PAGE_A)]).await;
    let id = h.save(fetching_workflow(&base)).await;

    let runner = h.unattended_runner(vec![Permission::SaveDocuments], CancellationToken::new());
    let no_inputs = HashMap::new();
    let run = runner.run(&id, &no_inputs, "schedule");
    let answer = async {
        let review = h.next_review().await;
        h.reviews.answer(&review.run_id, Decision::Deny);
    };
    let (detail, ()) = tokio::join!(run, answer);
    let detail = detail.unwrap();
    assert_eq!(detail.run.status, "failed");
    assert_eq!(
        detail.steps[0].error.as_deref(),
        Some("You didn't allow this.")
    );

    let mut runner = h.unattended_runner(vec![Permission::SaveDocuments], CancellationToken::new());
    if let Some(u) = runner.unattended.as_mut() {
        u.wait = std::time::Duration::from_millis(100);
    }
    let detail = runner.run(&id, &HashMap::new(), "schedule").await.unwrap();
    assert_eq!(detail.run.status, "failed");
    assert_eq!(
        detail.steps[0].error.as_deref(),
        Some("Nobody answered within a day, so this didn't go ahead.")
    );
    assert!(h.reviews.list().is_empty(), "an expired question is gone");
}

#[tokio::test]
async fn stopping_a_run_that_waits_for_an_answer_ends_it_as_stopped() {
    let h = Harness::new(EchoModel::default()).await;
    let base = serve(vec![("/a", PAGE_A)]).await;
    let id = h.save(fetching_workflow(&base)).await;
    let stop = CancellationToken::new();
    let runner = h.unattended_runner(vec![], stop.clone());
    let no_inputs = HashMap::new();
    let run = runner.run(&id, &no_inputs, "schedule");
    let stopper = async {
        h.next_review().await;
        stop.cancel();
    };
    let (detail, ()) = tokio::join!(run, stopper);
    assert_eq!(detail.unwrap().run.status, "stopped");
    assert!(h.reviews.list().is_empty());
}

#[tokio::test]
async fn a_new_model_provider_counts_as_outside_the_approval() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "sum", "type": "summarize", "prompt": "Sum up", "input": "text" },
        ]}))
        .await;
    // Approved for a cloud provider; the settings now use Ollama.
    let runner = h.unattended_runner(
        vec![Permission::Model {
            provider: "openai".into(),
        }],
        CancellationToken::new(),
    );
    let no_inputs = HashMap::new();
    let run = runner.run(&id, &no_inputs, "schedule");
    let answer = async {
        let review = h.next_review().await;
        assert_eq!(
            review.permission.permission,
            Permission::Model {
                provider: "ollama".into()
            }
        );
        assert_eq!(review.permission.local, Some(true));
        h.reviews.answer(&review.run_id, Decision::AllowOnce);
    };
    let (detail, ()) = tokio::join!(run, answer);
    assert_eq!(detail.unwrap().run.status, "completed");
}

#[tokio::test]
async fn going_over_the_time_budget_fails_the_run_even_when_the_step_may_fail() {
    let h = Harness::new(EchoModel::default()).await;
    let base = serve_hanging().await;
    let id = h
        .save(json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/slow")], "onError": "skip" },
            { "id": "after", "type": "template", "template": "never" },
        ]}))
        .await;
    let runner = Runner {
        state: &h.state,
        streams: &h.streams,
        fetch_policy: AddressPolicy { public_only: false },
        stop: CancellationToken::new(),
        unattended: None,
        budget: RunBudget {
            wall_clock: std::time::Duration::from_millis(300),
            ..RunBudget::default()
        },
        notify: None,
        questions: None,
        connectors: None,
    };
    let detail = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        runner.run(&id, &HashMap::new(), "manual"),
    )
    .await
    .expect("the budget ends the run")
    .unwrap();
    assert_eq!(detail.run.status, "failed");
    assert_eq!(
        detail.run.error.as_deref(),
        Some("The run went over its time limit of 1 second.")
    );
    assert_eq!(
        detail.steps.len(),
        1,
        "nothing runs after the budget is spent"
    );
}

#[tokio::test]
async fn going_over_the_token_budget_fails_the_run() {
    let model = EchoModel {
        usage: Some(600),
        ..EchoModel::default()
    };
    let h = Harness::new(model).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "one", "type": "summarize", "prompt": "Sum up", "input": "a" },
            { "id": "two", "type": "summarize", "prompt": "Sum up", "input": "b" },
            { "id": "three", "type": "summarize", "prompt": "Sum up", "input": "c" },
        ]}))
        .await;
    let runner = Runner {
        state: &h.state,
        streams: &h.streams,
        fetch_policy: AddressPolicy { public_only: false },
        stop: CancellationToken::new(),
        unattended: None,
        budget: RunBudget {
            max_tokens: 1000,
            ..RunBudget::default()
        },
        notify: None,
        questions: None,
        connectors: None,
    };
    let detail = runner.run(&id, &HashMap::new(), "manual").await.unwrap();
    assert_eq!(detail.run.status, "failed");
    assert_eq!(
        detail.run.error.as_deref(),
        Some("The run went over its limit of 1000 model tokens.")
    );
    let statuses: Vec<&str> = detail.steps.iter().map(|s| s.status.as_str()).collect();
    assert_eq!(
        statuses,
        vec!["completed", "failed"],
        "the second reply crosses the limit"
    );
}

#[tokio::test]
async fn a_run_waiting_for_an_answer_holds_up_no_other_scheduled_run() {
    let h = Harness::new(EchoModel::default()).await;
    let base = serve(vec![("/a", PAGE_A)]).await;
    let asks = h.save(fetching_workflow(&base)).await;
    let approved = h.save(saving_workflow()).await;
    let spec = json!({ "kind": "daily", "time": "08:00" });
    h.schedule(&asks, spec.clone(), true, "2026-09-29T06:00:00.000Z")
        .await;
    h.schedule(&approved, spec, true, "2026-09-29T06:00:00.000Z")
        .await;
    // `asks` was approved for another site before an edit pointed it here.
    repo::set_permissions(
        &h.state.db,
        &h.state.encryption,
        &asks,
        &[
            Permission::Host {
                host: "example.com".into(),
            },
            Permission::SaveDocuments,
        ],
    )
    .await
    .unwrap();

    let tz = FixedOffset::east_opt(2 * 3600).unwrap();
    let claimed = claim_due(&h.state, utc("2026-09-29T06:00:10Z"), &tz).await;
    assert_eq!(claimed.len(), 2);
    assert!(
        claim_due(&h.state, utc("2026-09-29T06:00:20Z"), &tz)
            .await
            .is_empty(),
        "claimed slots are used up before anything runs"
    );
    let running = std::sync::Arc::new(RunningWorkflows::default());
    let order = Mutex::new(Vec::new());
    let record = |event: &conduit_desktop::workflows::scheduler::RunFinished| {
        order.lock().unwrap().push(event.workflow_id.clone());
    };
    let questions = Questions::default();
    let ctx = RunContext {
        state: &h.state,
        streams: &h.streams,
        running: &running,
        reviews: &h.reviews,
        questions: &questions,
        connectors: None,
        fetch_policy: AddressPolicy { public_only: false },
        notify: None,
    };
    let runs = run_claimed(&ctx, claimed, &record);
    let answer = async {
        let review = h.next_review().await;
        assert_eq!(review.workflow_id, asks);
        // The other workflow finished while this one waited.
        for _ in 0..200 {
            if !order.lock().unwrap().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(*order.lock().unwrap(), vec![approved.clone()]);
        h.reviews.answer(&review.run_id, Decision::AllowOnce);
    };
    let (finished, ()) = tokio::join!(runs, answer);
    assert_eq!(*order.lock().unwrap(), vec![approved.clone(), asks.clone()]);
    assert!(finished.iter().all(|f| f.status == "completed"));
}

#[tokio::test]
async fn a_run_left_waiting_by_a_quit_is_marked_failed_at_launch() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h.save(saving_workflow()).await;
    let run = repo::start_run(&h.state.db, &id, 1, "schedule")
        .await
        .unwrap();
    repo::set_run_status(&h.state.db, &run.id, "paused")
        .await
        .unwrap();
    assert_eq!(repo::fail_interrupted_runs(&h.state.db).await.unwrap(), 1);
    let detail = repo::get_run(&h.state.db, &h.state.encryption, &run.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(detail.run.status, "failed");
}

// ── Retries and notifications ───────────────────────────────────────────────

fn hits(counter: &Arc<std::sync::atomic::AtomicUsize>) -> usize {
    counter.load(std::sync::atomic::Ordering::SeqCst)
}

#[tokio::test]
async fn a_page_that_fails_for_a_moment_is_fetched_on_a_retry() {
    let h = Harness::new(EchoModel::default()).await;
    let (base, count) = serve_statuses(vec![503, 503, 200]).await;
    let id = h
        .save(json!({ "steps": [ { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/p")] } ]}))
        .await;
    let detail = h.run(&id).await;
    assert_eq!(detail.run.status, "completed");
    assert_eq!(hits(&count), 3, "two retries by default");
    assert_eq!(
        detail.steps[0].output.as_ref().unwrap()["pages"][0]["title"],
        "Weather"
    );
}

#[tokio::test]
async fn a_missing_page_is_not_retried_and_retries_can_be_turned_off() {
    let h = Harness::new(EchoModel::default()).await;
    let (base, count) = serve_statuses(vec![404]).await;
    let id = h
        .save(json!({ "steps": [ { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/p")] } ]}))
        .await;
    let detail = h.run(&id).await;
    assert_eq!(detail.run.status, "failed");
    assert_eq!(hits(&count), 1, "404 won't change on a retry");

    let (base, count) = serve_statuses(vec![503, 200]).await;
    let id = h
        .save(json!({ "steps": [ { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/p")], "retries": 0 } ]}))
        .await;
    let detail = h.run(&id).await;
    assert_eq!(detail.run.status, "failed");
    assert_eq!(hits(&count), 1);
}

#[tokio::test]
async fn a_model_error_is_retried_once() {
    let model = EchoModel {
        failures: Arc::new(std::sync::atomic::AtomicUsize::new(1)),
        ..EchoModel::default()
    };
    let h = Harness::new(model).await;
    let id = h
        .save(json!({ "steps": [ { "id": "sum", "type": "summarize", "prompt": "Sum up", "input": "Rust ships" } ]}))
        .await;
    let detail = h.run(&id).await;
    assert_eq!(detail.run.status, "completed");
    assert_eq!(
        detail.steps[0].output.as_ref().unwrap()["text"],
        "SUMMARY: Rust ships"
    );
    assert_eq!(h.model.requests.lock().unwrap().len(), 2);

    // Two failures in a row outlast the one retry.
    h.model
        .failures
        .store(2, std::sync::atomic::Ordering::SeqCst);
    let detail = h.run(&id).await;
    assert_eq!(detail.run.status, "failed");
    assert!(detail.steps[0]
        .error
        .as_deref()
        .unwrap()
        .contains("The model is busy."));
}

#[tokio::test]
async fn a_reply_that_should_be_json_gets_one_more_ask() {
    let model = EchoModel {
        reply_json: Some(r#"{"topics": ["rust"]}"#),
        bad_json_first: true,
        ..EchoModel::default()
    };
    let h = Harness::new(model).await;
    let id = h
        .save(json!({ "steps": [ {
            "id": "sum", "type": "summarize", "prompt": "List topics", "input": "Rust ships",
            "schema": { "type": "object" }
        } ]}))
        .await;
    let detail = h.run(&id).await;
    assert_eq!(detail.run.status, "completed");
    assert_eq!(
        detail.steps[0].output.as_ref().unwrap()["data"],
        json!({ "topics": ["rust"] })
    );
    let requests = h.model.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[1].messages.len(),
        3,
        "the repair ask carries the bad reply"
    );
}

#[tokio::test]
async fn a_notify_step_shows_its_filled_in_text() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "doc", "type": "template", "template": "3 new posts" },
            { "id": "ping", "type": "notify", "title": "Briefing ready", "body": "{{steps.doc.text}}" },
        ]}))
        .await;
    let shown = Mutex::new(Vec::new());
    let notify = |title: &str, body: &str| {
        shown
            .lock()
            .unwrap()
            .push((title.to_string(), body.to_string()));
        Ok(())
    };
    let runner = Runner {
        state: &h.state,
        streams: &h.streams,
        fetch_policy: AddressPolicy { public_only: false },
        stop: CancellationToken::new(),
        unattended: None,
        budget: RunBudget::default(),
        notify: Some(&notify),
        questions: None,
        connectors: None,
    };
    let detail = runner.run(&id, &HashMap::new(), "manual").await.unwrap();
    assert_eq!(detail.run.status, "completed");
    assert_eq!(
        *shown.lock().unwrap(),
        vec![("Briefing ready".to_string(), "3 new posts".to_string())]
    );
    assert_eq!(detail.steps[1].output.as_ref().unwrap()["delivered"], true);

    // Without a desktop to show it on, the step says so.
    let detail = h.run(&id).await;
    assert_eq!(detail.run.status, "failed");
    assert!(detail.steps[1]
        .error
        .as_deref()
        .unwrap()
        .contains("Notifications aren't available"));
}

// ── Rerun from a step ───────────────────────────────────────────────────────

impl Harness {
    fn manual_runner(&self) -> Runner<'_> {
        Runner {
            state: &self.state,
            streams: &self.streams,
            fetch_policy: AddressPolicy { public_only: false },
            stop: CancellationToken::new(),
            unattended: None,
            budget: RunBudget::default(),
            notify: None,
            questions: None,
            connectors: None,
        }
    }

    async fn rerun(
        &self,
        earlier: &repo::WorkflowRunDetail,
        from: &str,
    ) -> Result<repo::WorkflowRunDetail, String> {
        let inputs: HashMap<String, String> =
            repo::get_run_inputs(&self.state.db, &self.state.encryption, &earlier.run.id)
                .await
                .unwrap()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default();
        let resume = Resume {
            from_step: from.to_string(),
            earlier: earlier.steps.clone(),
        };
        self.manual_runner()
            .run_from(&earlier.run.workflow_id, &inputs, "rerun", Some(&resume))
            .await
    }
}

#[tokio::test]
async fn a_rerun_from_a_step_reuses_what_came_before_it() {
    let h = Harness::new(EchoModel::default()).await;
    let (base, count) = serve_statuses(vec![200]).await;
    let steps = |template: &str| {
        json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/weather")] },
            { "id": "sum", "type": "summarize", "prompt": "Sum up", "input": "{{steps.fetch.text}}" },
            { "id": "doc", "type": "template", "template": template },
        ]})
    };
    let id = h.save(steps("Old: {{steps.sum.text}}")).await;
    let first = h.run(&id).await;
    assert_eq!(first.run.status, "completed");
    assert_eq!(
        (hits(&count), h.model.requests.lock().unwrap().len()),
        (1, 1)
    );

    // Fix the template, then rerun from it.
    let workflow = repo::get(&h.state.db, &h.state.encryption, &id)
        .await
        .unwrap()
        .unwrap();
    repo::update(
        &h.state.db,
        &h.state.encryption,
        &id,
        &workflow.name,
        None,
        &steps("New: {{steps.sum.text}}"),
    )
    .await
    .unwrap();
    let again = h.rerun(&first, "doc").await.unwrap();
    assert_eq!(again.run.status, "completed");
    assert_eq!(again.run.trigger, "rerun");
    assert_eq!(hits(&count), 1, "no page fetched again");
    assert_eq!(
        h.model.requests.lock().unwrap().len(),
        1,
        "the model wasn't asked again"
    );
    let statuses: Vec<(&str, &str)> = again
        .steps
        .iter()
        .map(|s| (s.step_id.as_str(), s.status.as_str()))
        .collect();
    assert_eq!(
        statuses,
        vec![("fetch", "reused"), ("sum", "reused"), ("doc", "completed")]
    );
    assert_eq!(
        again.steps[2].output.as_ref().unwrap()["text"],
        "New: SUMMARY: ## Weather"
    );
    // A rerun of a rerun reuses the reused steps too.
    let third = h.rerun(&again, "doc").await.unwrap();
    assert_eq!(third.run.status, "completed");
    assert_eq!(hits(&count), 1);
}

#[tokio::test]
async fn a_rerun_keeps_the_values_the_run_started_with() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({
            "inputs": [ { "id": "topic", "label": "Topic", "default": "news" } ],
            "steps": [
                { "id": "first", "type": "template", "template": "start" },
                { "id": "doc", "type": "template", "template": "About {{inputs.topic}}" },
            ]
        }))
        .await;
    let inputs = HashMap::from([("topic".to_string(), "rust".to_string())]);
    let first = h.manual_runner().run(&id, &inputs, "manual").await.unwrap();
    assert_eq!(
        first.steps[1].output.as_ref().unwrap()["text"],
        "About rust"
    );
    let again = h.rerun(&first, "doc").await.unwrap();
    assert_eq!(
        again.steps[1].output.as_ref().unwrap()["text"],
        "About rust"
    );
}

#[tokio::test]
async fn a_rerun_cannot_start_after_a_step_that_did_not_finish() {
    let h = Harness::new(EchoModel::default()).await;
    let (base, _) = serve_statuses(vec![404]).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/gone")] },
            { "id": "doc", "type": "template", "template": "x" },
        ]}))
        .await;
    let first = h.run(&id).await;
    assert_eq!(first.run.status, "failed");
    let runs_before = repo::list_runs(&h.state.db, &id, 10).await.unwrap().len();
    let err = h.rerun(&first, "doc").await.unwrap_err();
    assert!(err.contains("didn't finish last time"), "{err}");
    assert_eq!(
        repo::list_runs(&h.state.db, &id, 10).await.unwrap().len(),
        runs_before,
        "nothing is recorded"
    );
    let err = h.rerun(&first, "nope").await.unwrap_err();
    assert!(err.contains("isn't in the workflow"), "{err}");
}

#[tokio::test]
async fn a_step_allowed_to_fail_is_reused_with_its_error() {
    let h = Harness::new(EchoModel::default()).await;
    let (base, _) = serve_statuses(vec![404]).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/gone")], "onError": "skip" },
            { "id": "doc", "type": "template", "template": "Fetch said: {{steps.fetch.error}}" },
        ]}))
        .await;
    let first = h.run(&id).await;
    assert_eq!(first.run.status, "completed");
    let again = h.rerun(&first, "doc").await.unwrap();
    assert_eq!(again.run.status, "completed");
    assert!(again.steps[1].output.as_ref().unwrap()["text"]
        .as_str()
        .unwrap()
        .starts_with("Fetch said: None of the pages could be fetched."));
}

// ── Live-test fixes ──────────────────────────────────────────────────────────

#[tokio::test]
async fn a_briefing_with_a_missing_page_and_a_failed_summary_still_completes() {
    let base = serve(vec![("/a", PAGE_A)]).await;
    // The first summary has nothing to work on and fails (no model call),
    // the second works.
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/gone"), format!("{base}/a")] },
            { "id": "each_page", "type": "for_each", "items": "steps.fetch.pages", "steps": [
                { "id": "sum", "type": "summarize", "prompt": "Summarize.", "retries": 0,
                  "onError": "skip", "input": "{{item.title}}\n{{item.text}}" }
            ]},
            { "id": "doc", "type": "template",
              "template": "{{#each steps.each_page.items}}[{{item.sum.text}}]{{/each}}" }
        ]}))
        .await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed", "{:?}", run.run.error);

    // The missing page is reported inside `pages`, with a null title.
    let pages = &step(&run, "fetch", None).output.as_ref().unwrap()["pages"];
    assert_eq!(pages[0]["title"], Value::Null);
    assert_eq!(pages[0]["text"], "");
    assert!(pages[0]["error"].as_str().unwrap().contains("404"));

    // The skipped step keeps its shape: empty text, a marker and the reason.
    let skipped = step(&run, "sum", Some(0));
    assert_eq!(skipped.status, "skipped");
    let out = &step(&run, "each_page", None).output.as_ref().unwrap()["items"][0]["sum"];
    assert_eq!(out["skipped"], true);
    assert_eq!(out["text"], "");
    assert!(out["error"]
        .as_str()
        .unwrap()
        .starts_with("There was nothing to summarize"));
    assert_eq!(h.model.requests.lock().unwrap().len(), 1);

    let doc = step(&run, "doc", None).output.as_ref().unwrap()["text"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(doc.starts_with("[]["), "{doc}");
    assert!(doc.contains("SUMMARY: Rust news"), "{doc}");
}

#[tokio::test]
async fn reading_through_a_skipped_step_says_it_was_skipped() {
    let base = serve(vec![]).await;
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/gone")], "onError": "skip" },
            { "id": "doc", "type": "template", "template": "{{steps.fetch.pages}}" }
        ]}))
        .await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "failed");
    let error = run.run.error.unwrap();
    assert!(
        error.contains("Step \"fetch\" was skipped (None of the pages could be fetched")
            && error.contains("so {{steps.fetch.pages}} has nothing to show."),
        "{error}"
    );
}

#[tokio::test]
async fn run_date_and_time_use_the_local_clock() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "doc", "type": "template", "template": "{{run.date}}|{{run.time}}" }
        ]}))
        .await;
    let before = chrono::Local::now();
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed", "{:?}", run.run.error);
    let text = step(&run, "doc", None).output.as_ref().unwrap()["text"]
        .as_str()
        .unwrap()
        .to_string();
    let (date, time) = text.split_once('|').unwrap();
    let parsed = chrono::DateTime::parse_from_rfc3339(time).expect("ISO 8601 with an offset");
    assert_eq!(
        parsed.offset().local_minus_utc(),
        before.offset().local_minus_utc()
    );
    assert_eq!(date, parsed.format("%Y-%m-%d").to_string());
}

#[tokio::test]
async fn text_sent_to_the_model_is_cut_with_a_marker() {
    let page: &'static str = Box::leak(
        format!(
            "<html><body><main><p>{}</p></main></body></html>",
            "word ".repeat(30_000)
        )
        .into_boxed_str(),
    );
    let base = serve(vec![("/big", page)]).await;
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/big")] },
            { "id": "sum", "type": "summarize", "prompt": "Summarize.",
              "input": "{{steps.fetch.text}}{{steps.fetch.text}}{{steps.fetch.text}}{{steps.fetch.text}}" }
        ]}))
        .await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed", "{:?}", run.run.error);
    let requests = h.model.requests.lock().unwrap().clone();
    let sent = requests[0].messages.last().unwrap().parts[0]
        .content
        .clone()
        .unwrap();
    assert!(sent.contains("[\u{2026} cut: "), "marker missing");
    assert!(sent.contains("more characters]"));
    assert!(
        sent.chars().count() < 150_000 + 200,
        "{}",
        sent.chars().count()
    );
}

#[tokio::test]
async fn a_summary_of_nothing_fails_without_asking_the_model() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "blank", "type": "template", "template": "  " },
            { "id": "sum", "type": "summarize", "prompt": "Summarize.", "input": "{{steps.blank.text}}\n" }
        ]}))
        .await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "failed");
    assert_eq!(
        run.run.error.as_deref(),
        Some("Step \"sum\" failed: There was nothing to summarize: the input came out empty.")
    );
    assert!(h.model.requests.lock().unwrap().is_empty());

    // Allowed to fail, the run goes on and the step is skipped.
    let id = h
        .save(json!({ "steps": [
            { "id": "blank", "type": "template", "template": "" },
            { "id": "sum", "type": "summarize", "prompt": "Summarize.", "input": "{{steps.blank.text}}",
              "onError": "skip" }
        ]}))
        .await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed", "{:?}", run.run.error);
    assert!(h.model.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn every_page_gets_a_fair_share_of_what_the_model_can_take() {
    let mut paths = Vec::new();
    for n in 0..8 {
        let page: &'static str = Box::leak(
            format!(
                "<html><head><title>Page {n}</title></head><body><main><p>{}</p></main></body></html>",
                format!("m{n} ").repeat(30_000)
            )
            .into_boxed_str(),
        );
        let path: &'static str = Box::leak(format!("/p{n}").into_boxed_str());
        paths.push((path, page));
    }
    let base = serve(paths).await;
    let urls: Vec<String> = (0..8).map(|n| format!("{base}/p{n}")).collect();
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": urls },
            { "id": "sum", "type": "summarize", "prompt": "Summarize.", "input": "{{steps.fetch.text}}" }
        ]}))
        .await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed", "{:?}", run.run.error);
    let requests = h.model.requests.lock().unwrap().clone();
    let sent = requests[0].messages.last().unwrap().parts[0]
        .content
        .clone()
        .unwrap();
    for n in 0..8 {
        assert!(sent.contains(&format!("## Page {n}")), "page {n} missing");
        assert!(
            sent.contains(&format!("m{n} m{n} ")),
            "page {n} text missing"
        );
    }
    // Each page is cut on its own, and the whole stays within the cap.
    assert_eq!(sent.matches("more characters]").count(), 8);
    assert!(
        sent.chars().count() < 150_000 + 200,
        "{}",
        sent.chars().count()
    );
    // The run detail shows what the model received, not the uncut text.
    let recorded = step(&run, "sum", None).input.as_ref().unwrap()["input"]
        .as_str()
        .unwrap()
        .to_string();
    assert_eq!(recorded.matches("more characters]").count(), 8);
    assert!(recorded.chars().count() < 150_000);
}

// ── Ask me ──────────────────────────────────────────────────────────────────

impl Harness {
    fn asking_runner<'a>(
        &'a self,
        questions: &'a Questions,
        stop: CancellationToken,
    ) -> Runner<'a> {
        Runner {
            questions: Some(questions),
            connectors: None,
            stop,
            ..self.manual_runner()
        }
    }
}

/// Nobody-is-watching with a 100 ms wait, approved for nothing.
fn short_wait(reviews: &Reviews) -> Unattended<'_> {
    let mut unattended = Unattended::new(reviews, []);
    unattended.wait = std::time::Duration::from_millis(100);
    unattended
}

async fn next_question(questions: &Questions) -> conduit_desktop::workflows::ask::PendingQuestion {
    for _ in 0..200 {
        if let Some(q) = questions.list().into_iter().next() {
            return q;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("no run asked");
}

fn asking_workflow(default: Option<&str>) -> Value {
    let mut ask = json!({ "id": "ask", "type": "ask", "question": "Which topic, {{inputs.who}}?", "choices": ["Rust", "Go"] });
    if let Some(default) = default {
        ask["default"] = json!(default);
    }
    json!({
        "inputs": [ { "id": "who", "label": "Who", "default": "Sam" } ],
        "steps": [ ask, { "id": "doc", "type": "template", "template": "Topic: {{steps.ask.answer}}" } ]
    })
}

#[tokio::test]
async fn an_ask_step_waits_for_the_answer_and_carries_on_with_it() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h.save(asking_workflow(None)).await;
    let questions = Questions::default();
    let runner = h.asking_runner(&questions, CancellationToken::new());
    let no_inputs = HashMap::new();
    let run = runner.run(&id, &no_inputs, "manual");
    let answer = async {
        let q = next_question(&questions).await;
        assert_eq!(q.question, "Which topic, Sam?");
        assert_eq!(q.choices, vec!["Rust", "Go"]);
        let runs = repo::list_runs(&h.state.db, &id, 1).await.unwrap();
        assert_eq!(runs[0].status, "paused");
        assert!(questions.answer(&q.run_id, "Go".into()));
    };
    let (detail, ()) = tokio::join!(run, answer);
    let detail = detail.unwrap();
    assert_eq!(detail.run.status, "completed");
    assert_eq!(detail.steps[0].output.as_ref().unwrap()["answer"], "Go");
    assert_eq!(
        detail.steps[1].output.as_ref().unwrap()["text"],
        "Topic: Go"
    );
}

#[tokio::test]
async fn nobody_answering_takes_the_default_or_fails_without_one() {
    let h = Harness::new(EchoModel::default()).await;
    let questions = Questions::default();
    let id = h.save(asking_workflow(Some("Rust"))).await;
    let mut runner = h.asking_runner(&questions, CancellationToken::new());
    runner.unattended = Some(short_wait(&h.reviews));
    let detail = runner.run(&id, &HashMap::new(), "schedule").await.unwrap();
    assert_eq!(detail.run.status, "completed");
    assert_eq!(
        detail.steps[1].output.as_ref().unwrap()["text"],
        "Topic: Rust"
    );

    let id = h.save(asking_workflow(None)).await;
    let mut runner = h.asking_runner(&questions, CancellationToken::new());
    runner.unattended = Some(short_wait(&h.reviews));
    let detail = runner.run(&id, &HashMap::new(), "schedule").await.unwrap();
    assert_eq!(detail.run.status, "failed");
    assert_eq!(
        detail.steps[0].error.as_deref(),
        Some("Nobody answered in time.")
    );
    assert!(questions.list().is_empty());
}

#[tokio::test]
async fn stopping_while_asking_stops_and_nowhere_to_ask_fails() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h.save(asking_workflow(None)).await;
    let questions = Questions::default();
    let stop = CancellationToken::new();
    let runner = h.asking_runner(&questions, stop.clone());
    let no_inputs = HashMap::new();
    let run = runner.run(&id, &no_inputs, "manual");
    let stopper = async {
        next_question(&questions).await;
        stop.cancel();
    };
    let (detail, ()) = tokio::join!(run, stopper);
    assert_eq!(detail.unwrap().run.status, "stopped");
    assert!(questions.list().is_empty());

    let detail = h.run(&id).await;
    assert_eq!(detail.run.status, "failed");
    assert!(detail.steps[0]
        .error
        .as_deref()
        .unwrap()
        .contains("can't be asked here"));
}

// ── Agent step ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn an_agent_step_calls_its_tools_and_answers() {
    let model = EchoModel {
        tool_call: Some(("calculator", json!({ "expression": "6*7" }))),
        ..EchoModel::default()
    };
    let h = Harness::new(model).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "think", "type": "agent", "prompt": "Work it out", "input": "What is 6*7?", "tools": ["calculator"] },
            { "id": "doc", "type": "template", "template": "Answer: {{steps.think.text}}" },
        ]}))
        .await;
    let connectors = conduit_desktop::connector_runtime::ConnectorRuntimeManager::new();
    let runner = Runner {
        connectors: Some(&connectors),
        ..h.manual_runner()
    };
    let detail = runner.run(&id, &HashMap::new(), "manual").await.unwrap();
    assert_eq!(detail.run.status, "completed", "{:?}", detail.run.error);
    let out = detail.steps[0].output.as_ref().unwrap();
    assert_eq!(out["toolCalls"], json!(["calculator"]));
    // The echo model answers the second round from its last message (the
    // tool result); "Let me check." came before the tool call.
    assert_eq!(out["text"], "SUMMARY: (nothing)");
    let requests = h.model.requests.lock().unwrap();
    assert_eq!(
        requests.len(),
        2,
        "one round to call the tool, one to answer"
    );
    let offered: Vec<&str> = requests[0]
        .tool_definitions
        .iter()
        .map(|d| d.name.as_str())
        .collect();
    assert_eq!(offered, vec!["calculator"], "only the tools the step lists");
}

#[tokio::test]
async fn an_agent_step_without_a_tool_loop_fails_and_needs_approval_unattended() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "think", "type": "agent", "prompt": "Look it up", "tools": ["web_search", "web_fetch"] },
        ]}))
        .await;
    let detail = h.run(&id).await;
    assert_eq!(detail.run.status, "failed");
    assert!(detail.steps[0]
        .error
        .as_deref()
        .unwrap()
        .contains("can't run here"));

    assert_eq!(
        h.required(&id).await,
        vec![
            Permission::Model {
                provider: "ollama".into()
            },
            Permission::AgentTools {
                step_id: "think".into(),
                tools: vec!["web_fetch".into(), "web_search".into()],
            },
        ]
    );
    // Unattended, with only the model approved: it asks about the tools.
    let connectors = conduit_desktop::connector_runtime::ConnectorRuntimeManager::new();
    let runner = Runner {
        connectors: Some(&connectors),
        ..h.unattended_runner(
            vec![Permission::Model {
                provider: "ollama".into(),
            }],
            CancellationToken::new(),
        )
    };
    let no_inputs = HashMap::new();
    let run = runner.run(&id, &no_inputs, "schedule");
    let answer = async {
        let review = h.next_review().await;
        assert!(matches!(
            review.permission.permission,
            Permission::AgentTools { .. }
        ));
        h.reviews.answer(&review.run_id, Decision::Deny);
    };
    let (detail, ()) = tokio::join!(run, answer);
    let detail = detail.unwrap();
    assert_eq!(detail.run.status, "failed");
    assert_eq!(
        detail.steps[0].error.as_deref(),
        Some("You didn't allow this.")
    );
}

// ── A model per step ────────────────────────────────────────────────────────

fn sum_step(id: &str, model: Option<Value>) -> Value {
    let mut step = json!({
        "id": id, "type": "summarize", "prompt": "Sum up", "input": "some text"
    });
    if let Some(model) = model {
        step["model"] = model;
    }
    step
}

fn model_of(run: &repo::WorkflowRunDetail, id: &str) -> Value {
    step(run, id, None).output.as_ref().unwrap()["model"].clone()
}

fn calls(h: &Harness) -> Vec<(String, String)> {
    h.model.calls.lock().unwrap().clone()
}

fn pair(provider: &str, model: &str) -> (String, String) {
    (provider.to_string(), model.to_string())
}

#[tokio::test]
async fn a_step_beats_the_workflow_beats_the_chat_model_and_the_request_goes_there() {
    let model = EchoModel {
        usage: Some(10),
        ..EchoModel::default()
    };
    let h = Harness::new_with(model, false, &["openrouter"]).await;
    let id = h
        .save(json!({
            "model": { "provider": "lmstudio", "model": "wf-model" },
            "steps": [
                sum_step("a", None),
                sum_step("b", Some(json!({ "provider": "openrouter", "model": "or-model" }))),
                sum_step("c", None),
            ]
        }))
        .await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed", "{:?}", run.run.error);

    // The adapter that answered, and the model it was asked for, per call.
    assert_eq!(
        calls(&h),
        vec![
            pair("lmstudio", "wf-model"),
            pair("openrouter", "or-model"),
            pair("lmstudio", "wf-model"),
        ]
    );
    assert_eq!(
        model_of(&run, "a"),
        json!({ "provider": "lmstudio", "model": "wf-model" })
    );
    assert_eq!(
        model_of(&run, "b"),
        json!({ "provider": "openrouter", "model": "or-model" })
    );
    assert!(step(&run, "b", None).output.as_ref().unwrap()["modelNote"].is_null());

    // Usage rows name the provider and model each call really used.
    let mut rows: Vec<(String, String)> =
        sqlx::query_as("SELECT provider_id, model_id FROM usage_summary")
            .fetch_all(&h.state.db)
            .await
            .unwrap();
    rows.sort();
    assert_eq!(
        rows,
        vec![
            pair("lmstudio", "wf-model"),
            pair("lmstudio", "wf-model"),
            pair("openrouter", "or-model"),
        ]
    );
}

#[tokio::test]
async fn a_workflow_without_a_model_uses_the_chat_model_as_before() {
    let model = EchoModel {
        usage: Some(10),
        ..EchoModel::default()
    };
    let h = Harness::new(model).await;
    let id = h.save(json!({ "steps": [sum_step("a", None)] })).await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed", "{:?}", run.run.error);
    assert_eq!(calls(&h), vec![pair("ollama", "echo")]);
    let out = step(&run, "a", None).output.as_ref().unwrap();
    assert_eq!(
        out["model"],
        json!({ "provider": "ollama", "model": "echo" })
    );
    assert!(out["modelNote"].is_null());
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT provider_id, model_id FROM usage_summary")
            .fetch_all(&h.state.db)
            .await
            .unwrap();
    assert_eq!(rows, vec![pair("ollama", "echo")]);
}

#[tokio::test]
async fn a_provider_that_is_not_set_up_falls_back_to_the_chat_model_with_a_note() {
    // No OpenRouter key stored.
    let h = Harness::new_with(EchoModel::default(), false, &[]).await;
    let id = h
        .save(json!({ "steps": [
            sum_step("a", Some(json!({ "provider": "openrouter", "model": "gone" }))),
        ]}))
        .await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed", "{:?}", run.run.error);
    assert_eq!(calls(&h), vec![pair("ollama", "echo")]);
    let out = step(&run, "a", None).output.as_ref().unwrap();
    assert_eq!(
        out["model"],
        json!({ "provider": "ollama", "model": "echo" })
    );
    assert_eq!(
        out["modelNote"],
        "OpenRouter isn't set up, so the chat model was used."
    );
}

#[tokio::test]
async fn a_cloud_step_in_local_only_mode_fails_in_plain_words() {
    let h = Harness::new_with(EchoModel::default(), true, &["openrouter"]).await;
    let id = h
        .save(json!({ "steps": [
            sum_step("a", Some(json!({ "provider": "openrouter", "model": "m" }))),
        ]}))
        .await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "failed");
    assert_eq!(
        step(&run, "a", None).error.as_deref(),
        Some("This step uses OpenRouter, but Conduit is in local-only mode.")
    );
    assert!(calls(&h).is_empty(), "nothing was sent");
}

#[tokio::test]
async fn a_scheduled_run_pauses_when_a_step_moves_to_a_new_provider() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            sum_step("a", None),
            sum_step("b", Some(json!({ "provider": "lmstudio", "model": "other" }))),
        ]}))
        .await;
    // Approved for the chat's provider only.
    let runner = h.unattended_runner(
        vec![Permission::Model {
            provider: "ollama".into(),
        }],
        CancellationToken::new(),
    );
    let no_inputs = HashMap::new();
    let run = runner.run(&id, &no_inputs, "schedule");
    let answer = async {
        let review = h.next_review().await;
        assert_eq!(review.step_id, "b");
        assert_eq!(
            review.permission.permission,
            Permission::Model {
                provider: "lmstudio".into()
            }
        );
        h.reviews.answer(&review.run_id, Decision::AllowOnce);
    };
    let (detail, ()) = tokio::join!(run, answer);
    assert_eq!(detail.unwrap().run.status, "completed");
    assert_eq!(
        calls(&h),
        vec![pair("ollama", "echo"), pair("lmstudio", "other")]
    );
}

#[tokio::test]
async fn an_agent_step_runs_every_round_on_its_own_model() {
    let model = EchoModel {
        tool_call: Some(("calculator", json!({ "expression": "6*7" }))),
        usage: Some(10),
        ..EchoModel::default()
    };
    let h = Harness::new(model).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "think", "type": "agent", "prompt": "Work it out", "input": "6*7?",
              "tools": ["calculator"], "model": { "provider": "lmstudio", "model": "agent-model" } },
        ]}))
        .await;
    let connectors = conduit_desktop::connector_runtime::ConnectorRuntimeManager::new();
    let runner = Runner {
        connectors: Some(&connectors),
        ..h.manual_runner()
    };
    let detail = runner.run(&id, &HashMap::new(), "manual").await.unwrap();
    assert_eq!(detail.run.status, "completed", "{:?}", detail.run.error);
    assert_eq!(
        calls(&h),
        vec![
            pair("lmstudio", "agent-model"),
            pair("lmstudio", "agent-model")
        ]
    );
    assert_eq!(
        model_of(&detail, "think"),
        json!({ "provider": "lmstudio", "model": "agent-model" })
    );
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT provider_id, model_id FROM usage_summary")
            .fetch_all(&h.state.db)
            .await
            .unwrap();
    assert!(!rows.is_empty());
    assert!(rows.iter().all(|r| *r == pair("lmstudio", "agent-model")));
}
