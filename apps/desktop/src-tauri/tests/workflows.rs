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
    workflows::runner::Runner,
    workflows::scheduler::{run_due, to_iso, RunningWorkflows},
};
use futures::stream::Stream;
use provider_core::schema::{AppSettings, ProviderError, ProviderEvent, ProviderRequest};
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
}

impl EchoModel {
    fn reply_for(&self, request: &ProviderRequest) -> String {
        let text = request
            .messages
            .last()
            .and_then(|m| m.parts.first())
            .and_then(|p| p.content.clone())
            .unwrap_or_default();
        if let (Some(json), true) = (self.reply_json, text.contains("JSON Schema")) {
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
        let reply = self.reply_for(&request);
        self.requests.lock().unwrap().push(request.clone());
        let r = request.request_id;
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
        themes: root.join("themes"),
    }
}

struct Harness {
    state: AppState,
    streams: StreamManager,
    model: EchoModel,
    _dir: tempfile::TempDir,
}

impl Harness {
    async fn new(model: EchoModel) -> Self {
        let pool = common::setup_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let settings = AppSettings {
            active_provider: "ollama".into(),
            active_model: "echo".into(),
            local_only: true,
            ..AppSettings::default()
        };
        let state = AppState::test_instance_with_settings(pool, test_paths(dir.path()), settings);
        let resolver_model = model.clone();
        let streams = StreamManager::with_adapter_resolver(Arc::new(move |_id: &str| {
            Some(Box::new(resolver_model.clone()) as Box<dyn ProviderAdapter>)
        }));
        Self {
            state,
            streams,
            model,
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
    async fn schedule(&self, id: &str, spec: Value, enabled: bool, next_run_at: &str) {
        repo::put_schedule(&self.state.db, id, &spec, enabled, Some(next_run_at))
            .await
            .unwrap();
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
