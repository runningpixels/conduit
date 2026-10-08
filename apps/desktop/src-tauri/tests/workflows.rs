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
    AppSettings, EmbeddingRequest, EmbeddingResult, KeychainMode, LocalSearchBackend,
    ProviderError, ProviderEvent, ProviderRequest,
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
    /// Call all of these tools in one round (name, arguments), then answer
    /// once their results are in. Used instead of `tool_call` when set.
    tool_calls: Vec<(&'static str, Value)>,
    /// Text replaced in the scripted tool calls' arguments when they are sent
    /// (ids that exist only once the test has made its document), shared by
    /// all copies.
    subs: Arc<Mutex<Vec<(&'static str, String)>>>,
    /// The provider id this copy was resolved for (set by the harness's
    /// adapter resolver); cloud ones report `is_local() == false`.
    tag: String,
    /// (provider, model) of every call, shared by all copies.
    calls: Arc<Mutex<Vec<(String, String)>>>,
    /// Replies to workflow-drafting requests, in order (the last repeats),
    /// shared by all copies.
    drafts: Arc<Mutex<Vec<String>>>,
    /// Answers a request from (system prompt, last user text) before the
    /// usual echo does; `None` falls through to it.
    script: Option<Script>,
}

type Script = Arc<dyn Fn(&str, &str) -> Option<String> + Send + Sync>;

/// Words the fake embedding counts, one dimension each.
const VOCAB: [&str; 4] = ["tomato", "garden", "quantum", "qubit"];

fn fake_embed(text: &str) -> Vec<f32> {
    let lower = text.to_lowercase();
    VOCAB
        .iter()
        .map(|word| lower.matches(word).count() as f32)
        .collect()
}

impl EchoModel {
    fn reply_for(&self, request: &ProviderRequest) -> String {
        if request
            .system_prompt
            .as_deref()
            .is_some_and(|s| s.contains("You design workflows"))
        {
            let mut drafts = self.drafts.lock().unwrap();
            if !drafts.is_empty() {
                return if drafts.len() > 1 {
                    drafts.remove(0)
                } else {
                    drafts[0].clone()
                };
            }
        }
        let text = request
            .messages
            .last()
            .and_then(|m| m.parts.first())
            .and_then(|p| p.content.clone())
            .unwrap_or_default();
        if let Some(script) = &self.script {
            let system = request.system_prompt.as_deref().unwrap_or_default();
            if let Some(reply) = script(system, &text) {
                return reply;
            }
        }
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
    async fn generate_embeddings(
        &self,
        request: EmbeddingRequest,
        _ctx: &AdapterContext,
    ) -> Result<EmbeddingResult, ProviderError> {
        Ok(EmbeddingResult {
            vectors: request.inputs.iter().map(|s| fake_embed(s)).collect(),
            model_id: request.model_id,
        })
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
        let scripted: Vec<(&'static str, Value)> = if self.tool_calls.is_empty() {
            self.tool_call.iter().cloned().collect()
        } else {
            self.tool_calls.clone()
        };
        if !scripted.is_empty() {
            let answered = request
                .messages
                .iter()
                .any(|m| m.role == provider_core::schema::MessageRole::Tool);
            if !answered {
                let mut events = vec![
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
                ];
                let mut index = 2;
                for (n, (name, arguments)) in scripted.iter().enumerate() {
                    let call_id = format!("call-{}", n + 1);
                    let mut text = arguments.to_string();
                    for (from, to) in self.subs.lock().unwrap().iter() {
                        text = text.replace(from, to);
                    }
                    let arguments: Value = serde_json::from_str(&text).unwrap();
                    events.push(ProviderEvent::ToolCallStart {
                        request_id: r.clone(),
                        tool_call_id: call_id.clone(),
                        index,
                        tool_id: (*name).into(),
                        name: (*name).into(),
                    });
                    events.push(ProviderEvent::ToolCallComplete {
                        request_id: r.clone(),
                        tool_call_id: call_id,
                        index: index + 1,
                        arguments: arguments.clone(),
                    });
                    index += 2;
                }
                events.push(ProviderEvent::MessageComplete {
                    request_id: r,
                    index,
                    finish_reason: "tool_calls".into(),
                });
                return Ok(Box::pin(futures::stream::iter(events)));
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
        Self::new_tweaked(model, local_only, keys, |_| {}).await
    }

    /// [`Harness::new_with`], with `tweak` applied to the settings.
    async fn new_tweaked(
        model: EchoModel,
        local_only: bool,
        keys: &[&str],
        tweak: impl FnOnce(&mut AppSettings),
    ) -> Self {
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
        let mut settings = AppSettings {
            active_provider: "ollama".into(),
            active_model: "echo".into(),
            local_only,
            keychain_mode: KeychainMode::File,
            ..AppSettings::default()
        };
        tweak(&mut settings);
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
            documents: None,
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
        documents: None,
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
        let titles = permissions::collection_titles(&self.state.db, &def).await;
        let title = |id: &str| titles.get(id).cloned();
        permissions::required(
            &def,
            &permissions::Context {
                search_backend: "duckduckgo",
                provider: "ollama",
                model: "echo",
                configured: None,
                collection_title: Some(&title),
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
            documents: None,
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
            documents: None,
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
        documents: None,
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
        documents: None,
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
        documents: None,
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
        documents: None,
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
            documents: None,
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
        "New: SUMMARY: Sunny all week."
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
            documents: None,
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

// ── Only when something changed ──────────────────────────────────────────────

/// Serves one page at `/p` whose body is whatever `body` holds right now.
async fn serve_changing(body: Arc<Mutex<String>>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let body = body.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let _ = socket.read(&mut buf).await;
                let html = format!(
                    "<html><head><title>Watched</title></head><body><main>{}</main></body></html>",
                    body.lock().unwrap()
                );
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
                    html.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    format!("http://{addr}")
}

fn watching(base: &str) -> Value {
    json!({ "steps": [
        { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/p")] },
        { "id": "check", "type": "condition", "value": "{{steps.fetch.text}}", "is": "changed" },
        { "id": "sum", "type": "summarize", "prompt": "What changed?", "input": "{{steps.fetch.text}}" },
        { "id": "doc", "type": "template", "template": "Now: {{steps.sum.text}}" },
    ]})
}

fn step_ids(run: &repo::WorkflowRunDetail) -> Vec<&str> {
    run.steps.iter().map(|s| s.step_id.as_str()).collect()
}

#[tokio::test]
async fn changed_passes_once_then_stops_the_run_until_the_page_changes() {
    let page = Arc::new(Mutex::new("<p>Version one</p>".to_string()));
    let base = serve_changing(page.clone()).await;
    let h = Harness::new(EchoModel::default()).await;
    let id = h.save(watching(&base)).await;
    let asked = || h.model.requests.lock().unwrap().len();

    let first = h.run(&id).await;
    assert_eq!(first.run.status, "completed", "{:?}", first.run.error);
    assert_eq!(first.run.outcome, None);
    assert_eq!(step_ids(&first), ["fetch", "check", "sum", "doc"]);
    let check = step(&first, "check", None);
    let out = check.output.as_ref().unwrap();
    assert_eq!(
        (out["passed"].clone(), out["changed"].clone()),
        (json!(true), json!(true))
    );
    assert_eq!(out["previousHash"], Value::Null);
    assert_eq!(out["text"], "First run \u{2014} nothing to compare yet.");
    assert_eq!(out["hash"].as_str().unwrap().len(), 64);
    // The page itself isn't kept in the condition's record.
    assert!(!out.to_string().contains("Version one"));
    assert_eq!(asked(), 1);

    // The same page again: completed, "nothing new", nothing after the check ran.
    let second = h.run(&id).await;
    assert_eq!(second.run.status, "completed");
    assert_eq!(second.run.error, None);
    assert_eq!(second.run.outcome.as_deref(), Some("nothing_new"));
    assert_eq!(second.run.outcome_step.as_deref(), Some("check"));
    assert_eq!(step_ids(&second), ["fetch", "check"]);
    let out = step(&second, "check", None).output.clone().unwrap();
    assert_eq!(out["passed"], json!(false));
    assert_eq!(
        out["previousHash"],
        step(&first, "check", None).output.as_ref().unwrap()["hash"]
    );
    assert_eq!(out["text"], "Same as the last run.");
    assert_eq!(asked(), 1, "no model call when nothing changed");
    // The run list carries the outcome too.
    let listed = repo::list_runs(&h.state.db, &id, 10).await.unwrap();
    assert_eq!(listed[0].outcome.as_deref(), Some("nothing_new"));
    assert_eq!(listed[0].status, "completed");

    // Only whitespace moved: still nothing new.
    *page.lock().unwrap() = "<p>Version   one</p>\n\n".to_string();
    let third = h.run(&id).await;
    assert_eq!(third.run.outcome.as_deref(), Some("nothing_new"));

    // The page changes: the run carries on.
    *page.lock().unwrap() = "<p>Version two</p>".to_string();
    let fourth = h.run(&id).await;
    assert_eq!(fourth.run.outcome, None);
    assert_eq!(step_ids(&fourth), ["fetch", "check", "sum", "doc"]);
    assert_eq!(asked(), 2);
}

#[tokio::test]
async fn a_change_is_reported_again_when_the_run_that_saw_it_failed_later() {
    let page = Arc::new(Mutex::new("<p>Version one</p>".to_string()));
    let base = serve_changing(page.clone()).await;
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": [format!("{base}/p")] },
            { "id": "check", "type": "condition", "value": "{{steps.fetch.text}}", "is": "changed" },
            // Fails after the check passed: no such field on a page.
            { "id": "doc", "type": "template", "template": "{{steps.fetch.pages.0.nothing_here}}" },
        ]}))
        .await;

    let first = h.run(&id).await;
    assert_eq!(first.run.status, "failed");
    assert_eq!(
        step(&first, "check", None).output.as_ref().unwrap()["passed"],
        json!(true)
    );

    // Same page, but the run that saw it never finished: it is still news.
    let second = h.run(&id).await;
    assert_eq!(second.run.outcome, None);
    let out = step(&second, "check", None).output.clone().unwrap();
    assert_eq!(out["passed"], json!(true));
    assert_eq!(out["previousHash"], Value::Null);
}

#[tokio::test]
async fn a_run_that_stops_at_a_condition_is_not_a_failure_even_with_later_steps_unrun() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "src", "type": "template", "template": "  " },
            { "id": "check", "type": "condition", "value": "{{steps.src.text}}", "is": "not_empty" },
            { "id": "doc", "type": "template", "template": "never" },
        ]}))
        .await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed");
    assert_eq!(run.run.outcome.as_deref(), Some("nothing_new"));
    assert_eq!(step_ids(&run), ["src", "check"]);
    assert_eq!(step(&run, "check", None).status, "completed");
}

#[tokio::test]
async fn each_condition_test_passes_or_stops() {
    let h = Harness::new(EchoModel::default()).await;
    let cases = [
        ("not_empty", "  hello ", None, true),
        ("not_empty", "  \n ", None, false),
        ("empty", "   ", None, true),
        ("empty", "x", None, false),
        ("contains", "A new Release is out", Some("release"), true),
        ("contains", "nothing here", Some("release"), false),
        ("not_contains", "nothing here", Some("release"), true),
        ("not_contains", "Release", Some(" RELEASE "), false),
        ("equals", "  Yes ", Some("yes"), true),
        ("equals", "yes please", Some("yes"), false),
    ];
    for (is, value, text, passes) in cases {
        let mut check = json!({
            "id": "check", "type": "condition", "value": "{{steps.src.text}}", "is": is
        });
        if let Some(text) = text {
            check["text"] = json!(text);
        }
        let id = h
            .save(json!({ "steps": [
                { "id": "src", "type": "template", "template": value },
                check,
                { "id": "after", "type": "template", "template": "ran" },
            ] }))
            .await;
        let run = h.run(&id).await;
        assert_eq!(run.run.status, "completed", "{is} {value:?}");
        assert_eq!(
            step_ids(&run).contains(&"after"),
            passes,
            "{is} {value:?} {text:?}"
        );
        assert_eq!(run.run.outcome.is_some(), !passes, "{is} {value:?}");
        let out = step(&run, "check", None).output.as_ref().unwrap();
        assert_eq!(out["passed"], json!(passes));
        assert_eq!(out["changed"], Value::Null);
        assert!(!out["text"].as_str().unwrap().is_empty());
    }
}

#[tokio::test]
async fn a_condition_on_a_missing_value_fails_like_any_step_unless_it_may_skip() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "check", "type": "condition", "value": "{{inputs.nope}}", "is": "changed" },
        ]}))
        .await;
    // Rejected before it starts: the path doesn't exist.
    assert!(h
        .manual_runner()
        .run(&id, &HashMap::new(), "manual")
        .await
        .is_err());
    // A path that exists at validation but renders no value fails the step.
    let id = h
        .save(json!({ "steps": [
            { "id": "fetch", "type": "template", "template": "x" },
            { "id": "check", "type": "condition", "value": "{{steps.fetch.nothing}}", "is": "changed", "onError": "skip" },
            { "id": "after", "type": "template", "template": "ran" },
        ]}))
        .await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed");
    assert_eq!(step(&run, "check", None).status, "skipped");
    assert_eq!(step(&run, "after", None).status, "completed");
    assert_eq!(run.run.outcome, None);
}

fn message_workflow(only_if_changed: bool) -> Value {
    json!({
        "inputs": [{ "id": "msg", "label": "Message" }],
        "steps": [
            { "id": "ping", "type": "notify", "title": "Update {{run.date}}", "body": "{{inputs.msg}}",
              "onlyIfChanged": only_if_changed },
            { "id": "save", "type": "save_artifact", "title": "Dated {{run.date}}", "content": "{{inputs.msg}}",
              "onlyIfChanged": only_if_changed },
        ]
    })
}

async fn run_with(
    h: &Harness,
    id: &str,
    msg: &str,
    notify: &(dyn Fn(&str, &str) -> Result<(), String> + Sync),
) -> repo::WorkflowRunDetail {
    let runner = Runner {
        notify: Some(notify),
        ..h.manual_runner()
    };
    runner
        .run(
            id,
            &HashMap::from([("msg".to_string(), msg.to_string())]),
            "manual",
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn only_if_changed_skips_a_notification_and_a_save_that_say_the_same() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h.save(message_workflow(true)).await;
    let shown = Mutex::new(Vec::new());
    let notify = |title: &str, body: &str| {
        shown
            .lock()
            .unwrap()
            .push((title.to_string(), body.to_string()));
        Ok(())
    };

    let first = run_with(&h, &id, "3 new posts", &notify).await;
    assert_eq!(first.run.status, "completed", "{:?}", first.run.error);
    assert_eq!(shown.lock().unwrap().len(), 1);
    let sent = step(&first, "ping", None).output.clone().unwrap();
    assert_eq!(sent["sent"], json!(true));
    assert!(sent["hash"].as_str().unwrap().len() == 64);
    let saved = step(&first, "save", None).output.clone().unwrap();
    let artifact_id = saved["artifactId"].as_str().unwrap().to_string();
    assert!(saved["hash"].is_string());
    let before = artifacts::get(&h.state.db, &h.state.encryption, &artifact_id)
        .await
        .unwrap()
        .unwrap();

    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let second = run_with(&h, &id, "3 new posts", &notify).await;
    assert_eq!(second.run.status, "completed");
    assert_eq!(second.run.outcome, None, "skipping isn't stopping");
    assert_eq!(
        shown.lock().unwrap().len(),
        1,
        "nothing sent the second time"
    );
    assert_eq!(
        step(&second, "ping", None).output.clone().unwrap()["unchanged"],
        json!(true)
    );
    assert_eq!(
        step(&second, "ping", None).output.clone().unwrap()["sent"],
        json!(false)
    );
    let again = step(&second, "save", None).output.clone().unwrap();
    assert_eq!(again["unchanged"], json!(true));
    assert_eq!(again["artifactId"], json!(artifact_id));
    assert_eq!(again["hash"], saved["hash"]);
    // Nothing written: the artifact is exactly as it was.
    let after = artifacts::get(&h.state.db, &h.state.encryption, &artifact_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(after.updated_at, before.updated_at);
    assert_eq!(after.content_hash, before.content_hash);

    // New content: both go ahead.
    let third = run_with(&h, &id, "4 new posts", &notify).await;
    assert_eq!(shown.lock().unwrap().len(), 2);
    assert_eq!(
        step(&third, "ping", None).output.clone().unwrap()["sent"],
        json!(true)
    );
    assert!(step(&third, "save", None).output.clone().unwrap()["unchanged"].is_null());
    let after = artifacts::get(&h.state.db, &h.state.encryption, &artifact_id)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(after.content_hash, before.content_hash);

    // Without the setting, an identical run notifies again.
    let plain = h.save(message_workflow(false)).await;
    run_with(&h, &plain, "same", &notify).await;
    run_with(&h, &plain, "same", &notify).await;
    assert_eq!(shown.lock().unwrap().len(), 4);
}

#[tokio::test]
async fn a_save_is_made_again_when_the_unchanged_document_is_gone() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "save", "type": "save_artifact", "title": "Doc", "content": "same", "onlyIfChanged": true },
        ]}))
        .await;
    let first = h.run(&id).await;
    let artifact_id = step(&first, "save", None).output.clone().unwrap()["artifactId"]
        .as_str()
        .unwrap()
        .to_string();
    sqlx::query("DELETE FROM artifacts WHERE id = ?")
        .bind(&artifact_id)
        .execute(&h.state.db)
        .await
        .unwrap();
    let second = h.run(&id).await;
    let out = step(&second, "save", None).output.clone().unwrap();
    assert!(out["unchanged"].is_null());
    assert_ne!(out["artifactId"], json!(artifact_id));
}

#[tokio::test]
async fn a_reused_condition_row_is_not_the_baseline_for_the_next_run() {
    let page = Arc::new(Mutex::new("<p>One</p>".to_string()));
    let base = serve_changing(page.clone()).await;
    let h = Harness::new(EchoModel::default()).await;
    let id = h.save(watching(&base)).await;
    let first = h.run(&id).await;
    *page.lock().unwrap() = "<p>Two</p>".to_string();
    let second = h.run(&id).await;
    assert_eq!(second.run.outcome, None);

    // A rerun of the FIRST run reuses its fetch and check (page "One").
    let rerun = h.rerun(&first, "doc").await.unwrap();
    assert_eq!(rerun.run.status, "completed");
    assert_eq!(step(&rerun, "check", None).status, "reused");

    // The baseline is still the second run's "Two", so "Two" again is nothing new.
    let fourth = h.run(&id).await;
    assert_eq!(fourth.run.outcome.as_deref(), Some("nothing_new"));
    assert_eq!(
        step(&fourth, "check", None).output.as_ref().unwrap()["previousHash"],
        step(&second, "check", None).output.as_ref().unwrap()["hash"]
    );
}

#[tokio::test]
async fn a_scheduled_run_with_nothing_new_is_reported_as_such_and_has_no_documents() {
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "doc", "type": "template", "template": "same every day" },
            { "id": "check", "type": "condition", "value": "{{steps.doc.text}}", "is": "changed" },
            { "id": "save", "type": "save_artifact", "title": "Daily", "content": "{{steps.doc.text}}" },
        ]}))
        .await;
    h.schedule(
        &id,
        json!({ "kind": "daily", "time": "08:00" }),
        true,
        "2026-09-29T06:00:00.000Z",
    )
    .await;
    let running = std::sync::Arc::new(RunningWorkflows::default());
    let first = h.tick(&running, "2026-09-29T06:00:30Z").await;
    assert_eq!(first[0].status, "completed");
    assert_eq!(first[0].outcome, None);
    assert_eq!(first[0].documents.len(), 1);

    let second = h.tick(&running, "2026-09-30T06:00:30Z").await;
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].status, "completed");
    assert_eq!(second[0].error, None);
    assert_eq!(second[0].outcome.as_deref(), Some("nothing_new"));
    assert!(second[0].documents.is_empty());
}

// ── Data in: fetched data, a workflow folder, parsing ───────────────────────

/// Serves (path, content type, body) on loopback; anything else is a 404.
async fn serve_typed(files: Vec<(&'static str, &'static str, &'static str)>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let files = Arc::new(files);
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let files = files.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                let found = files.iter().find(|(p, _, _)| *p == path);
                let (status, content_type, body) = match found {
                    Some((_, ct, body)) => ("200 OK", *ct, *body),
                    None => ("404 Not Found", "text/plain", "missing"),
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    format!("http://{addr}")
}

const SALES_CSV: &str = "Week,Revenue\n1,100\n2,250\n";
const SALES_JSON: &str = r#"{"weeks": [{"Week": 1, "Revenue": 100}, {"Week": 2, "Revenue": 250}]}"#;

#[tokio::test]
async fn fetched_csv_and_json_arrive_as_they_are_and_html_is_still_read() {
    let base = serve_typed(vec![
        ("/sales.csv", "text/csv; charset=utf-8", SALES_CSV),
        ("/sales.json", "application/json", SALES_JSON),
        ("/download.csv", "application/octet-stream", SALES_CSV),
        ("/page", "text/html; charset=utf-8", PAGE_A),
    ])
    .await;
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": [
                format!("{base}/sales.csv"), format!("{base}/sales.json"),
                format!("{base}/download.csv"), format!("{base}/page"),
            ]},
            { "id": "table", "type": "parse_data", "input": "{{steps.fetch.pages.0.text}}", "format": "csv" },
            { "id": "cell", "type": "template", "template": "{{steps.table.rows.1.Revenue}}" },
        ]}))
        .await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed", "{:?}", run.run.error);
    let pages = &step(&run, "fetch", None).output.as_ref().unwrap()["pages"];
    assert_eq!(pages[0]["text"], SALES_CSV);
    assert_eq!(pages[0]["contentType"], "text/csv");
    assert_eq!(pages[0]["title"], Value::Null);
    assert_eq!(pages[1]["text"], SALES_JSON);
    assert_eq!(pages[1]["contentType"], "application/json");
    assert_eq!(pages[2]["text"], SALES_CSV, "a .csv address is data");
    assert_eq!(pages[2]["contentType"], "application/octet-stream");
    assert_eq!(pages[3]["title"], "Rust news");
    assert_eq!(pages[3]["contentType"], "text/html");
    assert!(!pages[3]["text"].as_str().unwrap().contains("track()"));

    let table = step(&run, "table", None).output.as_ref().unwrap();
    assert_eq!(table["count"], 2);
    assert_eq!(table["columns"], json!(["Week", "Revenue"]));
    assert_eq!(
        step(&run, "cell", None).output.as_ref().unwrap()["text"],
        "250"
    );
}

fn folder_workflow(folder: &Path, steps: Value) -> Value {
    json!({ "folder": folder.to_str().unwrap(), "steps": steps })
}

#[tokio::test]
async fn read_file_and_parse_data_feed_a_loop() {
    let data = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(data.path().join("reports")).unwrap();
    let csv = "Region,Revenue\nNorth,\"1,200\"\nSouth,300\n";
    std::fs::write(data.path().join("reports").join("metrics.csv"), csv).unwrap();
    let h = Harness::new(EchoModel::default()).await;
    let mut definition = folder_workflow(
        data.path(),
        json!([
            { "id": "f", "type": "read_file", "path": "reports/{{inputs.name}}" },
            { "id": "d", "type": "parse_data", "input": "{{steps.f.text}}", "format": "csv" },
            { "id": "each", "type": "for_each", "items": "steps.d.rows", "steps": [
                { "id": "line", "type": "template", "template": "{{item.Region}}={{item.Revenue}}" }
            ]},
        ]),
    );
    definition["inputs"] = json!([{ "id": "name", "label": "File", "default": "metrics.csv" }]);
    let id = h.save(definition).await;

    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed", "{:?}", run.run.error);
    let file = step(&run, "f", None).output.as_ref().unwrap();
    assert_eq!(file["path"], "reports/metrics.csv");
    assert_eq!(file["name"], "metrics.csv");
    assert_eq!(file["bytes"], csv.len());
    assert_eq!(file["text"], csv);
    assert!(file["modified"].as_str().unwrap().contains('T'));
    let lines: Vec<&str> = run
        .steps
        .iter()
        .filter(|s| s.step_id == "line")
        .map(|s| s.output.as_ref().unwrap()["text"].as_str().unwrap())
        .collect();
    assert_eq!(lines, ["North=1,200", "South=300"]);
    let recorded = step(&run, "d", None).input.as_ref().unwrap();
    assert_eq!(recorded["format"], "csv");
}

#[tokio::test]
async fn read_file_refusals_fail_the_step_in_plain_words() {
    let data = tempfile::tempdir().unwrap();
    std::fs::write(data.path().join("a.txt"), "hello").unwrap();
    let h = Harness::new(EchoModel::default()).await;
    for (path, expected) in [
        ("../a.txt", "no \"..\""),
        ("C:\\Windows\\win.ini", "not a full path"),
        ("/etc/passwd", "not a full path"),
        ("missing.txt", "no file called"),
    ] {
        let id = h
            .save(folder_workflow(
                data.path(),
                json!([{ "id": "f", "type": "read_file", "path": path }]),
            ))
            .await;
        let run = h.run(&id).await;
        assert_eq!(run.run.status, "failed", "{path}");
        let error = step(&run, "f", None).error.clone().unwrap();
        assert!(error.contains(expected), "{path}: {error}");
    }
    // A folder that has gone is reported at run time.
    let gone = data.path().join("not-here");
    let id = h
        .save(folder_workflow(
            &gone,
            json!([{ "id": "f", "type": "read_file", "path": "a.txt" }]),
        ))
        .await;
    let run = h.run(&id).await;
    let error = step(&run, "f", None).error.clone().unwrap();
    assert!(error.contains("folder can't be opened"), "{error}");

    // No folder at all is caught before a run starts.
    let id = h
        .save(json!({ "steps": [{ "id": "f", "type": "read_file", "path": "a.txt" }] }))
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
        documents: None,
    };
    let error = runner
        .run(&id, &HashMap::new(), "manual")
        .await
        .unwrap_err();
    assert!(
        error.contains("Step \"f\" reads a file, so choose the workflow's folder first."),
        "{error}"
    );
}

#[tokio::test]
async fn a_scheduled_run_pauses_for_a_new_folder() {
    let data = tempfile::tempdir().unwrap();
    std::fs::write(data.path().join("a.txt"), "hello").unwrap();
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(folder_workflow(
            data.path(),
            json!([{ "id": "f", "type": "read_file", "path": "a.txt" }]),
        ))
        .await;
    let folder = permissions::read_folder(data.path().to_str().unwrap());
    assert_eq!(h.required(&id).await, vec![folder.clone()]);
    let shown = serde_json::to_value(permissions::view(folder.clone())).unwrap();
    assert_eq!(shown["kind"], "readFolder");
    assert_eq!(shown["path"], data.path().to_str().unwrap());

    // Approved for it: asks nothing.
    let detail = h
        .unattended_runner(vec![folder.clone()], CancellationToken::new())
        .run(&id, &HashMap::new(), "schedule")
        .await
        .unwrap();
    assert_eq!(detail.run.status, "completed", "{:?}", detail.run.error);
    assert!(h.reviews.list().is_empty());

    // Not approved: it pauses and asks, and "Don't allow" fails the step.
    let runner = h.unattended_runner(vec![], CancellationToken::new());
    let no_inputs = HashMap::new();
    let run = runner.run(&id, &no_inputs, "schedule");
    let answer = async {
        let review = h.next_review().await;
        assert_eq!(review.step_id, "f");
        assert_eq!(review.permission.permission, folder);
        assert_eq!(review.url, None);
        assert!(h.reviews.answer(&review.run_id, Decision::Deny));
    };
    let (detail, ()) = tokio::join!(run, answer);
    let detail = detail.unwrap();
    assert_eq!(detail.run.status, "failed");
    assert_eq!(
        detail.steps[0].error.as_deref(),
        Some("You didn't allow this.")
    );
}

// ── Updating a saved deck or draft ──────────────────────────────────────────

use conduit_desktop::agent_tools::{
    EDIT_BLOCKS_TOOL, READ_DECK_TOOL, UPDATE_SLIDE_TOOL, UPDATE_SLOTS_TOOL, WRITE_SECTION_TOOL,
};
use conduit_desktop::db::repository::{drafts, messages, slides};
use conduit_desktop::stream_manager::TurnOwner;
use conduit_desktop::workflows::documents::{DocumentChange, DocumentChanges};
use provider_core::schema::{
    DeckSnapshotCause, DeckStage, DraftSnapshotCause, DraftStage, OutlineSection,
};

/// A slide with two slots the model may change and one the user wrote (pinned).
const WEEKLY_SLIDE: &str = r#"<h1 data-text="title">Revenue</h1><p data-text="number">10</p><p data-text="note" data-owner="user">Written by me</p>"#;

struct SavedDeck {
    id: String,
    conversation_id: String,
    slide_id: String,
}

async fn saved_deck(h: &Harness) -> SavedDeck {
    let (pool, enc) = (&h.state.db, &h.state.encryption);
    let chat = conversations::create(pool, None).await.unwrap();
    let deck = slides::create(
        pool,
        enc,
        "Weekly numbers",
        "ink",
        ".slide{}",
        Some(&chat.id),
    )
    .await
    .unwrap();
    slides::set_stage(pool, enc, &deck.id, DeckStage::Slides)
        .await
        .unwrap();
    let (slide, _) = slides::add_slide(pool, enc, &deck.id, "custom", WEEKLY_SLIDE, "", None)
        .await
        .unwrap();
    SavedDeck {
        id: deck.id,
        conversation_id: chat.id,
        slide_id: slide.id,
    }
}

/// A draft with an "Intro" section of two paragraphs, the second one the
/// user's own (pinned).
struct SavedDraft {
    id: String,
    conversation_id: String,
    /// The model's paragraph ("Tea is a leaf.").
    ai_block: String,
    /// The user's paragraph.
    mine: String,
}

fn block_with(draft: &provider_core::schema::DraftDetail, text: &str) -> String {
    draft
        .blocks
        .iter()
        .find(|b| draft.markdown[b.start as usize..b.end as usize].contains(text))
        .unwrap_or_else(|| panic!("no block holds {text:?}"))
        .id
        .clone()
}

async fn saved_draft(h: &Harness) -> SavedDraft {
    let (pool, enc) = (&h.state.db, &h.state.encryption);
    let draft = drafts::create(pool, enc, "Monthly report for the team")
        .await
        .unwrap();
    drafts::set_outline(
        pool,
        enc,
        &draft.id,
        vec![OutlineSection {
            heading: "Intro".into(),
            intent: String::new(),
            target_words: None,
        }],
        false,
    )
    .await
    .unwrap();
    drafts::set_stage(pool, enc, &draft.id, DraftStage::Draft)
        .await
        .unwrap();
    let loaded = drafts::require(pool, enc, &draft.id).await.unwrap();
    drafts::model_write_section(pool, enc, &loaded, "Intro", "Tea is a leaf.\n\nIt is old.")
        .await
        .unwrap();
    let written = drafts::get(pool, enc, &draft.id).await.unwrap().unwrap();
    // The user types over the second paragraph: theirs, and pinned.
    let edited = written
        .markdown
        .replace("It is old.", "It is very old, says me.");
    let now = drafts::save_markdown(pool, enc, &draft.id, &edited)
        .await
        .unwrap();
    SavedDraft {
        id: draft.id,
        conversation_id: draft.conversation_id,
        ai_block: block_with(&now, "Tea is a leaf."),
        mine: block_with(&now, "says me"),
    }
}

fn deck_workflow(deck_id: &str) -> Value {
    json!({ "steps": [
        { "id": "data", "type": "template", "template": "1,2\n3,4" },
        { "id": "deck", "type": "edit_deck", "deck": deck_id,
          "instructions": "Update the number.", "input": "{{steps.data.text}}" },
    ]})
}

fn draft_workflow(draft_id: &str) -> Value {
    json!({ "steps": [
        { "id": "data", "type": "template", "template": "Sales rose 12%." },
        { "id": "draft", "type": "edit_draft", "draft": draft_id,
          "instructions": "Add a section 'This week' with these results.", "input": "{{steps.data.text}}" },
    ]})
}

/// Records what a run announces about decks and drafts.
fn listening() -> (DocumentChanges, Arc<Mutex<Vec<DocumentChange>>>) {
    let changes = DocumentChanges::default();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    changes.set_listener(move |change| sink.lock().unwrap().push(change.clone()));
    (changes, seen)
}

fn offered(request: &ProviderRequest) -> Vec<String> {
    let mut names: Vec<String> = request
        .tool_definitions
        .iter()
        .map(|d| d.name.clone())
        .collect();
    names.sort();
    names
}

async fn deck_snapshots(h: &Harness, deck_id: &str) -> Vec<(DeckSnapshotCause, String)> {
    slides::list_snapshots(&h.state.db, deck_id)
        .await
        .unwrap()
        .into_iter()
        .map(|s| (s.cause, s.label))
        .collect()
}

/// `h` with a model that makes these tool calls (once) before answering.
async fn with_tool_calls(h: Harness, tool_calls: Vec<(&'static str, Value)>) -> Harness {
    let model = EchoModel {
        tool_calls,
        subs: h.model.subs.clone(),
        requests: h.model.requests.clone(),
        calls: h.model.calls.clone(),
        ..EchoModel::default()
    };
    let resolver_model = model.clone();
    Harness {
        model,
        streams: StreamManager::with_adapter_resolver(Arc::new(move |id: &str| {
            Some(Box::new(EchoModel {
                tag: id.to_string(),
                ..resolver_model.clone()
            }) as Box<dyn ProviderAdapter>)
        })),
        ..h
    }
}

#[tokio::test]
async fn edit_deck_changes_an_unpinned_slot_and_refuses_a_pinned_one() {
    let h = Harness::new(EchoModel::default()).await;
    let deck = saved_deck(&h).await;
    *h.model.subs.lock().unwrap() = vec![("@slide@", deck.slide_id.clone())];
    let h = with_tool_calls(
        h,
        vec![
            (
                UPDATE_SLOTS_TOOL,
                json!({ "edits": [
                    { "slide_id": "@slide@", "slot": "number", "html": "42" },
                    { "slide_id": "@slide@", "slot": "note", "html": "Overwritten" },
                ] }),
            ),
            // The model tries to release the user's text. Headless, it can't.
            (
                UPDATE_SLIDE_TOOL,
                json!({ "slide_id": "@slide@", "layout": "custom", "release_pinned": ["note"],
                    "html": r#"<h1 data-text="title">Revenue</h1><p data-text="number">42</p><p data-text="note" data-owner="user">Overwritten</p>"# }),
            ),
        ],
    )
    .await;
    let id = h.save(deck_workflow(&deck.id)).await;
    let connectors = conduit_desktop::connector_runtime::ConnectorRuntimeManager::new();
    let (changes, seen) = listening();
    let runner = Runner {
        connectors: Some(&connectors),
        documents: Some(&changes),
        ..h.manual_runner()
    };
    let detail = runner.run(&id, &HashMap::new(), "manual").await.unwrap();
    assert_eq!(detail.run.status, "completed", "{:?}", detail.run.error);

    // The output the page shows.
    let out = step(&detail, "deck", None).output.clone().unwrap();
    assert_eq!(out["deckId"], deck.id.as_str());
    assert_eq!(out["title"], "Weekly numbers");
    assert_eq!(out["changed"], json!([deck.slide_id]));
    assert_eq!(
        out["skippedPinned"],
        json!([{ "slideId": deck.slide_id, "slot": "note" }])
    );
    assert_eq!(out["layoutChecked"], false);
    assert!(
        out["reply"].as_str().unwrap().starts_with("SUMMARY:"),
        "{out}"
    );
    assert_eq!(
        out["model"],
        json!({ "provider": "ollama", "model": "echo" })
    );

    // The slot changed; the user's text did not, in either tool.
    let now = slides::get(&h.state.db, &h.state.encryption, &deck.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        now.slides[0].html,
        r#"<h1 data-text="title">Revenue</h1><p data-text="number">42</p><p data-text="note" data-owner="user">Written by me</p>"#
    );

    // Only the deck tools, with the words for a turn nobody watches.
    let requests = h.model.requests.lock().unwrap().clone();
    assert_eq!(
        offered(&requests[0]),
        [
            "add_slide",
            "delete_slide",
            "move_slide",
            "read_deck",
            "update_slide",
            "update_slots"
        ]
    );
    let update_slide = requests[0]
        .tool_definitions
        .iter()
        .find(|d| d.name == "update_slide")
        .unwrap();
    assert!(update_slide.input_schema["properties"]["release_pinned"].is_null());
    assert!(!update_slide.description.contains("release_pinned"));
    let system = requests[0].system_prompt.as_deref().unwrap();
    assert!(system.contains("nobody is watching") && system.contains("Slide canvas"));
    let developer = requests[0].developer_prompt.as_deref().unwrap();
    assert!(developer.contains("Deck \"Weekly numbers\"") && developer.contains("[pinned: note]"));
    let user = requests[0].messages.last().unwrap().parts[0]
        .content
        .clone()
        .unwrap();
    assert_eq!(user, "Update the number.\n\n<input>\n1,2\n3,4\n</input>");
    assert!(requests[0].generation_controls.is_none());

    // The deck's own chat holds the workflow's message, labelled by metadata.
    let chat = messages::load_conversation_messages(&h.state.db, &deck.conversation_id)
        .await
        .unwrap();
    let from_workflow: Vec<_> = chat
        .iter()
        .filter(|m| {
            m.metadata
                .as_ref()
                .is_some_and(|v| v.get("workflow").is_some())
        })
        .collect();
    assert_eq!(from_workflow.len(), 1);
    assert_eq!(
        from_workflow[0].metadata,
        Some(
            json!({ "workflow": { "id": id, "runId": detail.run.id, "name": "Morning briefing",
                "model": { "provider": "ollama", "model": "echo" } } })
        )
    );
    // The replies say which model wrote them.
    let replies: Vec<_> = chat
        .iter()
        .filter(|m| m.role == provider_core::schema::MessageRole::Assistant)
        .collect();
    assert!(!replies.is_empty());
    for reply in replies {
        assert_eq!(
            reply.metadata.as_ref().map(|m| m["model"].clone()),
            Some(json!({ "provider": "ollama", "model": "echo" }))
        );
    }

    // History: before (manual) and after (ai turn), and before restores the old deck.
    assert_eq!(
        deck_snapshots(&h, &deck.id).await,
        vec![
            (
                DeckSnapshotCause::AiTurn,
                "Workflow: Morning briefing".to_string()
            ),
            (
                DeckSnapshotCause::Manual,
                "Before Morning briefing".to_string()
            ),
        ]
    );
    let history = slides::list_snapshots(&h.state.db, &deck.id).await.unwrap();
    assert_eq!(out["beforeSnapshotId"], history[1].id.as_str());
    let restored =
        slides::restore_snapshot(&h.state.db, &h.state.encryption, &deck.id, &history[1].id)
            .await
            .unwrap();
    assert_eq!(restored.slides[0].html, WEEKLY_SLIDE);

    // The page was told, once.
    assert_eq!(
        *seen.lock().unwrap(),
        vec![DocumentChange::Deck(
            conduit_desktop::workflows::documents::DeckChanged {
                deck_id: deck.id.clone(),
                workflow_name: "Morning briefing".into(),
                run_id: detail.run.id.clone(),
            }
        )]
    );
    assert!(h.streams.turn_holder(&deck.conversation_id).is_none());
}

#[tokio::test]
async fn edit_deck_with_nothing_to_change_still_completes_and_says_nothing_changed() {
    let h = Harness::new(EchoModel::default()).await;
    let deck = saved_deck(&h).await;
    let id = h.save(deck_workflow(&deck.id)).await;
    let connectors = conduit_desktop::connector_runtime::ConnectorRuntimeManager::new();
    let (changes, seen) = listening();
    let runner = Runner {
        connectors: Some(&connectors),
        documents: Some(&changes),
        ..h.manual_runner()
    };
    let detail = runner.run(&id, &HashMap::new(), "manual").await.unwrap();
    assert_eq!(detail.run.status, "completed", "{:?}", detail.run.error);
    let out = step(&detail, "deck", None).output.clone().unwrap();
    assert_eq!(out["changed"], json!([]));
    assert_eq!(out["skippedPinned"], json!([]));
    assert_eq!(out["reply"], "SUMMARY: 1,2");
    // Nothing changed: no second history entry, and nobody is told.
    assert_eq!(
        deck_snapshots(&h, &deck.id).await,
        vec![(
            DeckSnapshotCause::Manual,
            "Before Morning briefing".to_string()
        )]
    );
    assert!(seen.lock().unwrap().is_empty());

    // The "before" snapshot is the one made now; run again and it matches that
    // one, which is then the one to go back to.
    let first = slides::list_snapshots(&h.state.db, &deck.id).await.unwrap();
    assert_eq!(out["beforeSnapshotId"], first[0].id.as_str());
    let again = runner.run(&id, &HashMap::new(), "manual").await.unwrap();
    let out = step(&again, "deck", None).output.clone().unwrap();
    assert_eq!(out["beforeSnapshotId"], first[0].id.as_str());
    assert_eq!(
        slides::list_snapshots(&h.state.db, &deck.id)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn edit_draft_edits_a_block_adds_a_section_and_keeps_the_users_paragraph() {
    let h = Harness::new(EchoModel::default()).await;
    let draft = saved_draft(&h).await;
    *h.model.subs.lock().unwrap() = vec![
        ("@ai@", draft.ai_block.clone()),
        ("@mine@", draft.mine.clone()),
    ];
    let h = with_tool_calls(
        h,
        vec![
            (
                EDIT_BLOCKS_TOOL,
                json!({ "edits": [{ "block_id": "@ai@", "markdown": "Tea is a leaf, picked by hand." }] }),
            ),
            (
                EDIT_BLOCKS_TOOL,
                json!({ "edits": [{ "block_id": "@mine@", "markdown": "Overwritten" }],
                    "release_pinned": ["@mine@"] }),
            ),
            (
                WRITE_SECTION_TOOL,
                json!({ "heading": "This week", "markdown": "Sales rose 12%." }),
            ),
        ],
    )
    .await;
    let id = h.save(draft_workflow(&draft.id)).await;
    let connectors = conduit_desktop::connector_runtime::ConnectorRuntimeManager::new();
    let (changes, seen) = listening();
    let runner = Runner {
        connectors: Some(&connectors),
        documents: Some(&changes),
        ..h.manual_runner()
    };
    let detail = runner.run(&id, &HashMap::new(), "manual").await.unwrap();
    assert_eq!(detail.run.status, "completed", "{:?}", detail.run.error);

    let now = drafts::get(&h.state.db, &h.state.encryption, &draft.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        now.markdown,
        "## Intro\n\nTea is a leaf, picked by hand.\n\nIt is very old, says me.\n\n## This week\n\nSales rose 12%.\n"
    );
    // The new section is in the outline; the old one is untouched.
    let headings: Vec<&str> = now.outline.iter().map(|s| s.heading.as_str()).collect();
    assert_eq!(headings, ["Intro", "This week"]);

    let out = step(&detail, "draft", None).output.clone().unwrap();
    assert_eq!(out["draftId"], draft.id.as_str());
    assert_eq!(out["title"], now.title.as_str());
    assert_eq!(out["skippedPinned"], json!([{ "blockId": draft.mine }]));
    let changed: Vec<&str> = out["changed"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert!(changed.contains(&draft.ai_block.as_str()), "{changed:?}");
    assert!(!changed.contains(&draft.mine.as_str()), "{changed:?}");
    assert_eq!(
        changed.len(),
        3,
        "the edited block, the new heading and paragraph"
    );
    assert!(out.get("layoutChecked").is_none());
    // Sections, not blocks: the edited one, and the new one once.
    assert_eq!(out["changedSections"], json!(["Intro", "This week"]));

    let requests = h.model.requests.lock().unwrap().clone();
    assert_eq!(
        offered(&requests[0]),
        ["edit_blocks", "read_draft", "write_section"]
    );
    let edit = requests[0]
        .tool_definitions
        .iter()
        .find(|d| d.name == "edit_blocks")
        .unwrap();
    assert!(edit.input_schema["properties"]["release_pinned"].is_null());
    assert_eq!(
        requests[0]
            .generation_controls
            .as_ref()
            .and_then(|c| c.parallel_tool_calls),
        Some(false)
    );
    let developer = requests[0].developer_prompt.as_deref().unwrap();
    assert!(developer.contains("Blocks (block_id") && developer.contains("pinned"));

    let history = drafts::list_snapshots(&h.state.db, &draft.id)
        .await
        .unwrap();
    let labels: Vec<_> = history
        .iter()
        .take(2)
        .map(|s| (s.cause, s.label.clone()))
        .collect();
    assert_eq!(
        labels,
        [
            (
                DraftSnapshotCause::AiTurn,
                Some("Workflow: Morning briefing".to_string())
            ),
            (
                DraftSnapshotCause::Manual,
                Some("Before Morning briefing".to_string())
            ),
        ]
    );
    assert_eq!(out["beforeSnapshotId"], history[1].id.as_str());
    // Undo puts the old text and the old outline back.
    let back =
        drafts::restore_snapshot(&h.state.db, &h.state.encryption, &draft.id, &history[1].id)
            .await
            .unwrap();
    assert!(back.markdown.contains("Tea is a leaf.") && !back.markdown.contains("This week"));
    assert_eq!(back.outline.len(), 1);

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert!(matches!(&seen[0], DocumentChange::Draft(d) if d.draft_id == draft.id));
    assert!(h.streams.turn_holder(&draft.conversation_id).is_none());
}

fn quick_wait() -> RunBudget {
    RunBudget {
        busy_wait: std::time::Duration::from_millis(400),
        busy_poll: std::time::Duration::from_millis(50),
        ..RunBudget::default()
    }
}

#[tokio::test]
async fn an_update_waits_for_a_chat_turn_and_fails_plainly_when_it_never_ends() {
    let h = Harness::new(EchoModel::default()).await;
    let deck = saved_deck(&h).await;
    let draft = saved_draft(&h).await;
    let deck_id = h.save(deck_workflow(&deck.id)).await;
    let draft_id = h.save(draft_workflow(&draft.id)).await;
    let connectors = conduit_desktop::connector_runtime::ConnectorRuntimeManager::new();
    let runner = Runner {
        connectors: Some(&connectors),
        budget: quick_wait(),
        ..h.manual_runner()
    };
    // A chat message is being answered in the deck's conversation.
    let chat_turn = h
        .streams
        .try_begin_turn(&deck.conversation_id, TurnOwner::Chat)
        .unwrap();
    let began = std::time::Instant::now();
    let detail = runner
        .run(&deck_id, &HashMap::new(), "manual")
        .await
        .unwrap();
    assert!(began.elapsed() >= std::time::Duration::from_millis(400));
    assert_eq!(detail.run.status, "failed");
    assert_eq!(
        step(&detail, "deck", None).error.as_deref(),
        Some("The deck was busy in chat for over a minute, so the update didn't run.")
    );
    assert!(h.model.requests.lock().unwrap().is_empty(), "no model call");
    assert!(
        deck_snapshots(&h, &deck.id).await.is_empty(),
        "nothing was snapshotted or changed"
    );

    // The same for a draft.
    let _draft_turn = h
        .streams
        .try_begin_turn(&draft.conversation_id, TurnOwner::Chat)
        .unwrap();
    let detail = runner
        .run(&draft_id, &HashMap::new(), "manual")
        .await
        .unwrap();
    assert_eq!(
        step(&detail, "draft", None).error.as_deref(),
        Some("The draft was busy in chat for over a minute, so the update didn't run.")
    );

    // The chat reply finishes while the update waits: it gets through, with no
    // retry setting involved.
    let release = async {
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        drop(chat_turn);
    };
    let no_inputs = HashMap::new();
    let (detail, ()) = tokio::join!(runner.run(&deck_id, &no_inputs, "manual"), release);
    let detail = detail.unwrap();
    assert_eq!(detail.run.status, "completed", "{:?}", detail.run.error);
}

#[tokio::test]
async fn a_waiting_update_ends_on_stop_and_on_the_time_limit() {
    let h = Harness::new(EchoModel::default()).await;
    let deck = saved_deck(&h).await;
    let id = h.save(deck_workflow(&deck.id)).await;
    let connectors = conduit_desktop::connector_runtime::ConnectorRuntimeManager::new();
    let _chat_turn = h
        .streams
        .try_begin_turn(&deck.conversation_id, TurnOwner::Chat)
        .unwrap();
    // A wait much longer than the test: only stop or the time limit can end it.
    let long = RunBudget {
        busy_wait: std::time::Duration::from_secs(60),
        busy_poll: std::time::Duration::from_millis(50),
        ..RunBudget::default()
    };

    let stop = CancellationToken::new();
    let runner = Runner {
        connectors: Some(&connectors),
        budget: long,
        stop: stop.clone(),
        ..h.manual_runner()
    };
    let stopper = async {
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        stop.cancel();
    };
    let no_inputs = HashMap::new();
    let (detail, ()) = tokio::join!(runner.run(&id, &no_inputs, "manual"), stopper);
    assert_eq!(detail.unwrap().run.status, "stopped");

    let runner = Runner {
        connectors: Some(&connectors),
        budget: RunBudget {
            wall_clock: std::time::Duration::from_millis(300),
            ..long
        },
        ..h.manual_runner()
    };
    let detail = runner.run(&id, &no_inputs, "manual").await.unwrap();
    assert_eq!(detail.run.status, "failed");
    assert!(
        detail.run.error.as_deref().unwrap().contains("time limit"),
        "{:?}",
        detail.run.error
    );
}

#[tokio::test]
async fn a_single_fetched_page_is_the_text_with_no_heading_and_data_is_not_empty() {
    let base = serve_typed(vec![
        ("/sales.csv", "text/csv", SALES_CSV),
        ("/empty.csv", "text/csv", ""),
        ("/page", "text/html; charset=utf-8", PAGE_A),
    ])
    .await;
    let h = Harness::new(EchoModel::default()).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "one", "type": "fetch_page", "urls": [format!("{base}/sales.csv")] },
            { "id": "mixed", "type": "fetch_page", "urls": [
                format!("{base}/sales.csv"), format!("{base}/nothing-here"),
            ], "onError": "skip" },
            { "id": "two", "type": "fetch_page", "urls": [
                format!("{base}/sales.csv"), format!("{base}/page"),
            ]},
            { "id": "empty", "type": "fetch_page", "urls": [format!("{base}/empty.csv")] },
        ]}))
        .await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed", "{:?}", run.run.error);
    let one = step(&run, "one", None).output.as_ref().unwrap();
    assert_eq!(one["text"], SALES_CSV, "{one}");
    assert_eq!(one["pages"][0]["lookedEmpty"], false);
    // One readable page among a failure: still no heading.
    let mixed = step(&run, "mixed", None).output.as_ref().unwrap();
    assert_eq!(mixed["text"], SALES_CSV, "{mixed}");
    // Several pages join under their headings, as before.
    let two = step(&run, "two", None).output.as_ref().unwrap();
    let text = two["text"].as_str().unwrap();
    assert!(
        text.starts_with("## ") && text.contains("Week,Revenue"),
        "{text}"
    );
    // An empty data file is still empty.
    let empty = step(&run, "empty", None).output.as_ref().unwrap();
    assert_eq!(empty["pages"][0]["lookedEmpty"], true);
}

fn chat_request(conversation_id: &str) -> ProviderRequest {
    use provider_core::schema::{Message, MessagePart, MessagePartKind, MessageRole};
    let now = "2026-10-07T10:00:00.000Z".to_string();
    ProviderRequest {
        request_id: "chat-1".into(),
        conversation_id: conversation_id.into(),
        model_id: "echo".into(),
        messages: vec![Message {
            id: "chat-m1".into(),
            conversation_id: conversation_id.into(),
            role: MessageRole::User,
            author_label: None,
            provider_message_id: None,
            request_id: None,
            interrupted_at: None,
            metadata: None,
            parts: vec![MessagePart {
                id: "chat-m1/p0".into(),
                message_id: "chat-m1".into(),
                index: 0,
                kind: MessagePartKind::Text,
                content: Some("Make the title shorter".into()),
                mime_type: None,
                tool_call_id: None,
                artifact_id: None,
                attachment_id: None,
                blob_ref: None,
                metadata: None,
                created_at: now.clone(),
            }],
            created_at: now,
        }],
        system_prompt: None,
        developer_prompt: None,
        attachments: None,
        tool_definitions: conduit_desktop::agent_tools::builtin_tool_definitions()
            .into_iter()
            .filter(|d| d.name == READ_DECK_TOOL)
            .collect(),
        generation_controls: None,
        response_format: None,
        web_search: None,
    }
}

/// A chat message in `conversation_id`, as the app sends it.
async fn send_chat(
    h: &Harness,
    connectors: &conduit_desktop::connector_runtime::ConnectorRuntimeManager,
    conversation_id: &str,
) -> Result<(), String> {
    let (sink, _) = conduit_desktop::event_sink::collector::<ProviderEvent>();
    h.streams
        .run_agent_turn(
            &h.state,
            connectors,
            chat_request(conversation_id),
            sink,
            conduit_desktop::event_sink::EventSink::discard(),
        )
        .await
        .map(|_| ())
}

#[tokio::test]
async fn a_chat_message_is_refused_while_a_workflow_holds_the_conversation_and_works_after() {
    let h = Harness::new(EchoModel::default()).await;
    let deck = saved_deck(&h).await;
    let connectors = conduit_desktop::connector_runtime::ConnectorRuntimeManager::new();
    let update = h
        .streams
        .try_begin_turn(
            &deck.conversation_id,
            TurnOwner::Workflow("Weekly numbers".into()),
        )
        .unwrap();
    let err = send_chat(&h, &connectors, &deck.conversation_id)
        .await
        .unwrap_err();
    assert_eq!(
        err,
        "The workflow \u{201c}Weekly numbers\u{201d} is updating this right now. Try again when it has finished."
    );
    // Refused before anything was saved or sent.
    assert!(
        messages::load_conversation_messages(&h.state.db, &deck.conversation_id)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(h.model.requests.lock().unwrap().is_empty());

    // Two chat turns don't overlap either.
    drop(update);
    let chat = h
        .streams
        .try_begin_turn(&deck.conversation_id, TurnOwner::Chat)
        .unwrap();
    let err = send_chat(&h, &connectors, &deck.conversation_id)
        .await
        .unwrap_err();
    assert!(err.contains("already working on a reply"), "{err}");

    // Free again: the same message goes through, and releases the conversation.
    drop(chat);
    send_chat(&h, &connectors, &deck.conversation_id)
        .await
        .unwrap();
    assert!(h.streams.turn_holder(&deck.conversation_id).is_none());
}

#[tokio::test]
async fn the_conversation_is_released_after_a_failed_stopped_or_timed_out_update() {
    // A model error mid-turn.
    let h = Harness::new(EchoModel::default()).await;
    let deck = saved_deck(&h).await;
    let id = h.save(deck_workflow(&deck.id)).await;
    let connectors = conduit_desktop::connector_runtime::ConnectorRuntimeManager::new();
    h.model
        .failures
        .store(1, std::sync::atomic::Ordering::SeqCst);
    let runner = Runner {
        connectors: Some(&connectors),
        ..h.manual_runner()
    };
    let detail = runner.run(&id, &HashMap::new(), "manual").await.unwrap();
    assert_eq!(detail.run.status, "failed");
    assert_eq!(
        step(&detail, "deck", None).error.as_deref(),
        Some("The model is busy.")
    );
    assert!(h.streams.turn_holder(&deck.conversation_id).is_none());

    // A model that never finishes, against a short time limit.
    let h = Harness::new(EchoModel {
        hang: true,
        ..EchoModel::default()
    })
    .await;
    let deck = saved_deck(&h).await;
    let id = h.save(deck_workflow(&deck.id)).await;
    let runner = Runner {
        connectors: Some(&connectors),
        budget: RunBudget {
            wall_clock: std::time::Duration::from_millis(400),
            ..RunBudget::default()
        },
        ..h.manual_runner()
    };
    let detail = runner.run(&id, &HashMap::new(), "manual").await.unwrap();
    assert_eq!(detail.run.status, "failed");
    assert!(
        detail.run.error.as_deref().unwrap().contains("time limit"),
        "{:?}",
        detail.run.error
    );
    assert!(h.streams.turn_holder(&deck.conversation_id).is_none());
    // The safety net was made before the model started; nothing else.
    assert_eq!(
        deck_snapshots(&h, &deck.id).await,
        vec![(
            DeckSnapshotCause::Manual,
            "Before Morning briefing".to_string()
        )]
    );

    // Stopped.
    let stop = CancellationToken::new();
    let runner = Runner {
        connectors: Some(&connectors),
        stop: stop.clone(),
        ..h.manual_runner()
    };
    let stopper = async {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        stop.cancel();
    };
    let no_inputs = HashMap::new();
    let (detail, ()) = tokio::join!(runner.run(&id, &no_inputs, "manual"), stopper);
    assert_eq!(detail.unwrap().run.status, "stopped");
    assert!(h.streams.turn_holder(&deck.conversation_id).is_none());
}

#[tokio::test]
async fn a_deleted_deck_or_draft_fails_the_step_without_a_model_call() {
    let h = Harness::new(EchoModel::default()).await;
    let deck = saved_deck(&h).await;
    let draft = saved_draft(&h).await;
    slides::delete(&h.state.db, &deck.id).await.unwrap();
    drafts::delete(&h.state.db, &draft.id).await.unwrap();
    let connectors = conduit_desktop::connector_runtime::ConnectorRuntimeManager::new();
    let runner = Runner {
        connectors: Some(&connectors),
        ..h.manual_runner()
    };
    let id = h.save(deck_workflow(&deck.id)).await;
    let detail = runner.run(&id, &HashMap::new(), "manual").await.unwrap();
    assert_eq!(
        step(&detail, "deck", None).error.as_deref(),
        Some("The deck this step updates was deleted.")
    );
    let id = h.save(draft_workflow(&draft.id)).await;
    let detail = runner.run(&id, &HashMap::new(), "manual").await.unwrap();
    assert_eq!(
        step(&detail, "draft", None).error.as_deref(),
        Some("The draft this step updates was deleted.")
    );
    assert!(h.model.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_outline_cannot_be_updated() {
    let h = Harness::new(EchoModel::default()).await;
    let (pool, enc) = (&h.state.db, &h.state.encryption);
    let chat = conversations::create(pool, None).await.unwrap();
    let deck = slides::create(pool, enc, "Plan", "ink", ".slide{}", Some(&chat.id))
        .await
        .unwrap();
    let draft = drafts::create(pool, enc, "Notes for next week")
        .await
        .unwrap();
    let connectors = conduit_desktop::connector_runtime::ConnectorRuntimeManager::new();
    let runner = Runner {
        connectors: Some(&connectors),
        ..h.manual_runner()
    };
    let id = h.save(deck_workflow(&deck.id)).await;
    let detail = runner.run(&id, &HashMap::new(), "manual").await.unwrap();
    assert_eq!(
        step(&detail, "deck", None).error.as_deref(),
        Some("The deck \u{201c}Plan\u{201d} is still an outline; finish it in Slides first.")
    );
    let id = h.save(draft_workflow(&draft.id)).await;
    let detail = runner.run(&id, &HashMap::new(), "manual").await.unwrap();
    assert!(step(&detail, "draft", None)
        .error
        .as_deref()
        .unwrap()
        .contains("is still an outline; approve the outline in Writing first."));
    assert!(h.model.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_update_given_empty_data_fails_without_asking_a_model() {
    let h = Harness::new(EchoModel::default()).await;
    let deck = saved_deck(&h).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "data", "type": "template", "template": "   " },
            { "id": "deck", "type": "edit_deck", "deck": deck.id,
              "instructions": "Update the number.", "input": "{{steps.data.text}}" },
        ]}))
        .await;
    let connectors = conduit_desktop::connector_runtime::ConnectorRuntimeManager::new();
    let runner = Runner {
        connectors: Some(&connectors),
        ..h.manual_runner()
    };
    let detail = runner.run(&id, &HashMap::new(), "manual").await.unwrap();
    assert_eq!(detail.run.status, "failed");
    assert_eq!(
        step(&detail, "deck", None).error.as_deref(),
        Some("There was nothing to update the deck with: the input came out empty.")
    );
    assert!(h.model.requests.lock().unwrap().is_empty());
    assert!(deck_snapshots(&h, &deck.id).await.is_empty());
}

#[tokio::test]
async fn a_scheduled_update_pauses_for_each_new_document_and_remembers_the_answer() {
    let h = Harness::new(EchoModel::default()).await;
    let deck = saved_deck(&h).await;
    let id = h.save(deck_workflow(&deck.id)).await;
    let connectors = conduit_desktop::connector_runtime::ConnectorRuntimeManager::new();
    // Turning the schedule on approves the model; the document is asked about at run time.
    let required = h.required(&id).await;
    assert_eq!(
        required,
        vec![Permission::Model {
            provider: "ollama".into()
        }]
    );

    // Not allowed: nothing is called, snapshotted or changed.
    let runner = Runner {
        connectors: Some(&connectors),
        ..h.unattended_runner(required.clone(), CancellationToken::new())
    };
    let no_inputs = HashMap::new();
    let run = runner.run(&id, &no_inputs, "schedule");
    let answer = async {
        let review = h.next_review().await;
        assert_eq!(review.step_id, "deck");
        assert_eq!(
            serde_json::to_value(&review.permission).unwrap(),
            json!({
                "kind": "editDocument", "documentKind": "deck", "id": deck.id,
                "title": "Weekly numbers",
                "label": "Change the deck \u{201c}Weekly numbers\u{201d}", "local": null,
            })
        );
        assert!(h.reviews.answer(&review.run_id, Decision::Deny));
    };
    let (detail, ()) = tokio::join!(run, answer);
    let detail = detail.unwrap();
    assert_eq!(detail.run.status, "failed");
    assert_eq!(
        step(&detail, "deck", None).error.as_deref(),
        Some("You didn't allow this.")
    );
    assert!(h.model.requests.lock().unwrap().is_empty());
    assert!(deck_snapshots(&h, &deck.id).await.is_empty());

    // Approved for this deck: it runs without asking.
    let mut approved = required;
    approved.push(permissions::edit_document(
        "deck",
        &deck.id,
        "Weekly numbers",
    ));
    let runner = Runner {
        connectors: Some(&connectors),
        ..h.unattended_runner(approved.clone(), CancellationToken::new())
    };
    let detail = runner.run(&id, &no_inputs, "schedule").await.unwrap();
    assert_eq!(detail.run.status, "completed", "{:?}", detail.run.error);
    assert!(h.reviews.list().is_empty());

    // Renamed since: it asks again.
    slides::rename(&h.state.db, &deck.id, "Weekly figures")
        .await
        .unwrap();
    let runner = Runner {
        connectors: Some(&connectors),
        ..h.unattended_runner(approved, CancellationToken::new())
    };
    let run = runner.run(&id, &no_inputs, "schedule");
    let answer = async {
        let review = h.next_review().await;
        assert_eq!(
            review.permission.label.as_deref(),
            Some("Change the deck \u{201c}Weekly figures\u{201d}")
        );
        assert!(h.reviews.answer(&review.run_id, Decision::AllowOnce));
    };
    let (detail, ()) = tokio::join!(run, answer);
    assert_eq!(detail.unwrap().run.status, "completed");
}

#[tokio::test]
async fn an_update_uses_the_steps_model_and_records_its_usage_there() {
    let h = Harness::new(EchoModel {
        usage: Some(10),
        ..EchoModel::default()
    })
    .await;
    let deck = saved_deck(&h).await;
    let id = h
        .save(json!({ "steps": [
            { "id": "deck", "type": "edit_deck", "deck": deck.id, "instructions": "Update it.",
              "model": { "provider": "lmstudio", "model": "deck-model" } },
        ]}))
        .await;
    let connectors = conduit_desktop::connector_runtime::ConnectorRuntimeManager::new();
    let runner = Runner {
        connectors: Some(&connectors),
        ..h.manual_runner()
    };
    let detail = runner.run(&id, &HashMap::new(), "manual").await.unwrap();
    assert_eq!(detail.run.status, "completed", "{:?}", detail.run.error);
    assert_eq!(calls(&h), vec![pair("lmstudio", "deck-model")]);
    assert_eq!(
        model_of(&detail, "deck"),
        json!({ "provider": "lmstudio", "model": "deck-model" })
    );
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT provider_id, model_id FROM usage_summary")
            .fetch_all(&h.state.db)
            .await
            .unwrap();
    assert!(!rows.is_empty());
    assert!(rows.iter().all(|r| *r == pair("lmstudio", "deck-model")));
    // No input given: the message is just the instructions.
    let requests = h.model.requests.lock().unwrap().clone();
    assert_eq!(
        requests[0].messages.last().unwrap().parts[0]
            .content
            .as_deref(),
        Some("Update it.")
    );
}

// ── Drafting a workflow from words ───────────────────────────────────────────

mod drafting {
    use super::*;
    use conduit_desktop::db::repository::{messages, tool_calls};
    use conduit_desktop::workflows::author::{self, DraftRequest};
    use provider_core::schema::{
        Message, MessagePart, MessagePartKind, MessageRole, ToolCallRecord, ToolCallStatus,
    };

    fn valid_reply() -> String {
        json!({
            "name": "Page summary",
            "description": "Summarize a page.",
            "notes": [],
            "definition": {
                "inputs": [{ "id": "page", "label": "Page", "default": "https://example.com" }],
                "steps": [
                    { "id": "fetch", "type": "fetch_page", "urls": ["{{inputs.page}}"] },
                    { "id": "sum", "type": "summarize", "prompt": "Summarize.", "input": "{{steps.fetch.text}}" },
                    { "id": "save", "type": "save_artifact", "title": "Summary", "content": "{{steps.sum.text}}" }
                ]
            }
        })
        .to_string()
    }

    fn broken_reply() -> String {
        json!({
            "name": "Broken",
            "definition": { "steps": [
                { "id": "a", "type": "notify", "title": "Hi", "body": "{{steps.later.text}}" }
            ]}
        })
        .to_string()
    }

    const BROKEN_PROBLEM: &str =
        "Step \"a\" reads steps.later.text, which doesn't exist at that point.";

    fn with_drafts(replies: Vec<String>) -> EchoModel {
        EchoModel {
            drafts: Arc::new(Mutex::new(replies)),
            usage: Some(100),
            ..EchoModel::default()
        }
    }

    fn ask(description: &str) -> DraftRequest {
        DraftRequest {
            description: description.to_string(),
            transcript: None,
        }
    }

    fn last_text(request: &ProviderRequest) -> String {
        request.messages.last().unwrap().parts[0]
            .content
            .clone()
            .unwrap()
    }

    #[tokio::test]
    async fn a_description_becomes_a_valid_draft() {
        let h = Harness::new(with_drafts(vec![valid_reply()])).await;
        let draft = author::draft(&h.state, &h.streams, ask("Summarize a page I choose"))
            .await
            .unwrap();
        assert_eq!(draft.name, "Page summary");
        assert_eq!(draft.description, "Summarize a page.");
        assert_eq!(draft.attempts, 1);
        assert!(draft.problems.is_empty(), "{:?}", draft.problems);
        assert!(draft.notes.is_empty());
        assert_eq!(draft.definition["steps"][1]["id"], "sum");
        let wire = serde_json::to_value(&draft).unwrap();
        for key in [
            "name",
            "description",
            "definition",
            "problems",
            "attempts",
            "notes",
        ] {
            assert!(wire.get(key).is_some(), "{key}");
        }

        let requests = h.model.requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.model_id, "echo");
        assert!(request.tool_definitions.is_empty());
        let system = request.system_prompt.clone().unwrap();
        assert!(system.contains("fetch_page") && system.contains("edit_deck"));
        assert!(last_text(request).contains("Summarize a page I choose"));
        // Not a chat: hidden, and its usage is recorded.
        assert!(conversations::list(&h.state.db).await.unwrap().is_empty());
        let rows: Vec<(String, String)> =
            sqlx::query_as("SELECT provider_id, model_id FROM usage_summary")
                .fetch_all(&h.state.db)
                .await
                .unwrap();
        assert_eq!(rows, vec![("ollama".to_string(), "echo".to_string())]);
        // Nothing saved.
        assert!(repo::list(&h.state.db).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn problems_are_sent_back_and_a_fixed_reply_is_used() {
        let h = Harness::new(with_drafts(vec![broken_reply(), valid_reply()])).await;
        let draft = author::draft(&h.state, &h.streams, ask("Do it"))
            .await
            .unwrap();
        assert_eq!(draft.attempts, 2);
        assert!(draft.problems.is_empty(), "{:?}", draft.problems);
        assert_eq!(draft.name, "Page summary");
        let requests = h.model.requests.lock().unwrap().clone();
        assert_eq!(requests.len(), 2);
        let sent = last_text(&requests[1]);
        assert!(
            sent.starts_with("Fix these problems and reply with the whole JSON again:"),
            "{sent}"
        );
        assert!(sent.contains(BROKEN_PROBLEM), "{sent}");
        // The model sees its own reply and the problems.
        assert_eq!(requests[1].messages.len(), 3);
    }

    #[tokio::test]
    async fn a_draft_still_wrong_after_two_rounds_is_returned_with_its_problems() {
        let h = Harness::new(with_drafts(vec![broken_reply()])).await;
        let draft = author::draft(&h.state, &h.streams, ask("Do it"))
            .await
            .unwrap();
        assert_eq!(draft.attempts, 3);
        assert_eq!(h.model.requests.lock().unwrap().len(), 3);
        assert_eq!(draft.problems, vec![BROKEN_PROBLEM]);
        assert_eq!(draft.definition["steps"][0]["id"], "a");
    }

    #[tokio::test]
    async fn a_reply_with_no_json_is_asked_again_and_then_given_up_on() {
        let h = Harness::new(with_drafts(vec!["Sure, I can help!".into(), valid_reply()])).await;
        let draft = author::draft(&h.state, &h.streams, ask("Do it"))
            .await
            .unwrap();
        assert_eq!(draft.attempts, 2);
        let requests = h.model.requests.lock().unwrap().clone();
        assert!(last_text(&requests[1]).contains("wasn't valid JSON"));

        let h = Harness::new(with_drafts(vec!["No.".into()])).await;
        let error = author::draft(&h.state, &h.streams, ask("Do it"))
            .await
            .unwrap_err();
        assert_eq!(error, author::NOTHING_RETURNED);
        assert_eq!(h.model.requests.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn ids_the_model_cannot_know_are_left_empty_and_noted() {
        let reply = json!({
            "name": "Weekly deck",
            "notes": ["Pick the deck to update."],
            "definition": {
                "folder": "C:\\Users\\me\\Documents",
                "model": { "provider": "openai", "model": "gpt-x" },
                "steps": [
                    { "id": "read", "type": "read_file", "path": "numbers.csv" },
                    { "id": "deck", "type": "edit_deck", "deck": "deck-1234",
                      "instructions": "Update the numbers.", "input": "{{steps.read.text}}" }
                ]
            }
        })
        .to_string();
        let h = Harness::new(with_drafts(vec![reply])).await;
        let draft = author::draft(&h.state, &h.streams, ask("Weekly numbers into my deck"))
            .await
            .unwrap();
        // Only the user's own choices are missing, so nothing is sent back.
        assert_eq!(draft.attempts, 1);
        assert_eq!(draft.definition["steps"][1]["deck"], "");
        assert!(draft.definition.get("folder").is_none());
        assert!(draft.definition.get("model").is_none());
        assert_eq!(
            draft.notes,
            vec![
                "Pick the deck to update.",
                "Choose the folder the workflow reads from."
            ]
        );
        assert!(draft
            .problems
            .iter()
            .any(|p| p.contains("needs a deck to update")));
        assert!(draft
            .problems
            .iter()
            .any(|p| p.contains("choose the workflow's folder first")));
    }

    #[tokio::test]
    async fn drafting_that_runs_too_long_is_stopped() {
        let h = Harness::new(EchoModel {
            hang: true,
            ..EchoModel::default()
        })
        .await;
        let started = std::time::Instant::now();
        let error = author::draft_within(
            &h.state,
            &h.streams,
            ask("Do it"),
            &CancellationToken::new(),
            std::time::Duration::from_millis(300),
        )
        .await
        .unwrap_err();
        assert!(error.contains("took too long"), "{error}");
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }

    #[tokio::test]
    async fn drafting_can_be_cancelled() {
        let h = Harness::new(EchoModel {
            hang: true,
            ..EchoModel::default()
        })
        .await;
        let stop = CancellationToken::new();
        let later = stop.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
            later.cancel();
        });
        let error = author::draft_within(
            &h.state,
            &h.streams,
            ask("Do it"),
            &stop,
            std::time::Duration::from_secs(60),
        )
        .await
        .unwrap_err();
        assert_eq!(error, "Drafting was stopped.");
    }

    #[tokio::test]
    async fn an_empty_description_is_refused() {
        let h = Harness::new(with_drafts(vec![valid_reply()])).await;
        let error = author::draft(&h.state, &h.streams, ask("   "))
            .await
            .unwrap_err();
        assert_eq!(error, "Describe what the workflow should do.");
        assert!(h.model.requests.lock().unwrap().is_empty());
    }

    fn text_message(conversation: &str, role: MessageRole, text: &str, at: &str) -> Message {
        let id = uuid::Uuid::new_v4().to_string();
        Message {
            id: id.clone(),
            conversation_id: conversation.to_string(),
            role,
            author_label: None,
            provider_message_id: None,
            request_id: None,
            interrupted_at: None,
            metadata: None,
            parts: vec![MessagePart {
                id: format!("{id}/p0"),
                message_id: id,
                index: 0,
                kind: MessagePartKind::Text,
                content: Some(text.to_string()),
                mime_type: None,
                tool_call_id: None,
                artifact_id: None,
                attachment_id: None,
                blob_ref: None,
                metadata: None,
                created_at: at.to_string(),
            }],
            created_at: at.to_string(),
        }
    }

    #[tokio::test]
    async fn a_chat_becomes_a_transcript_of_questions_and_tool_calls_only() {
        let h = Harness::new(with_drafts(vec![valid_reply()])).await;
        let pool = &h.state.db;
        let chat = conversations::create(pool, None).await.unwrap();
        messages::insert_message(
            pool,
            &text_message(
                &chat.id,
                MessageRole::User,
                "Research Rust news. My key is api_key=sk-abc123456789",
                "2026-10-07T10:00:00.000Z",
            ),
        )
        .await
        .unwrap();
        let reply = text_message(
            &chat.id,
            MessageRole::Assistant,
            "THE WHOLE REPORT TEXT",
            "2026-10-07T10:00:05.000Z",
        );
        messages::insert_message(pool, &reply).await.unwrap();
        sqlx::query("UPDATE messages SET request_id = 'req-1' WHERE id = ?")
            .bind(&reply.id)
            .execute(pool)
            .await
            .unwrap();
        for (id, tool, args, result, status) in [
            (
                "c1",
                "web_search",
                json!({ "query": "rust news this week" }),
                json!({ "hits": "TOOL OUTPUT ONE" }),
                ToolCallStatus::Completed,
            ),
            (
                "c2",
                "web_fetch",
                json!({ "url": "https://example.org/a" }),
                json!("TOOL OUTPUT TWO"),
                ToolCallStatus::Failed,
            ),
        ] {
            tool_calls::insert_tool_call(
                pool,
                &ToolCallRecord {
                    id: id.to_string(),
                    tool_id: tool.to_string(),
                    request_id: "req-1".to_string(),
                    status,
                    arguments: Some(args),
                    result: Some(result),
                    error: None,
                    approved_at: None,
                    completed_at: None,
                },
            )
            .await
            .unwrap();
        }

        let transcript = author::chat_transcript(&h.state, &chat.id).await.unwrap();
        assert!(
            transcript.contains("User: Research Rust news."),
            "{transcript}"
        );
        assert!(
            transcript.contains("web_search {\"query\":\"rust news this week\"} -> done"),
            "{transcript}"
        );
        assert!(transcript.contains("web_fetch"));
        assert!(transcript.contains("-> failed"));
        assert!(!transcript.contains("sk-abc123456789"), "{transcript}");
        assert!(!transcript.contains("TOOL OUTPUT"), "{transcript}");
        assert!(!transcript.contains("WHOLE REPORT"), "{transcript}");

        // The chat variant sends it with the default request.
        let draft = author::draft(
            &h.state,
            &h.streams,
            DraftRequest {
                description: author::DEFAULT_CHAT_REQUEST.to_string(),
                transcript: Some(transcript),
            },
        )
        .await
        .unwrap();
        assert!(draft.problems.is_empty());
        let sent = last_text(&h.model.requests.lock().unwrap()[0]);
        assert!(sent.contains("<chat>") && sent.contains("web_search"));
        assert!(sent.contains(author::DEFAULT_CHAT_REQUEST));
    }

    #[tokio::test]
    async fn a_chat_with_nothing_in_it_has_no_transcript() {
        let h = Harness::new(EchoModel::default()).await;
        let chat = conversations::create(&h.state.db, None).await.unwrap();
        let error = author::chat_transcript(&h.state, &chat.id)
            .await
            .unwrap_err();
        assert_eq!(error, "That chat has no messages to turn into a workflow.");
        let error = author::chat_transcript(&h.state, "missing")
            .await
            .unwrap_err();
        assert_eq!(error, "That chat no longer exists.");
    }
}

// ── Research and Documents steps ─────────────────────────────────────────────

const LANES_QUESTION: &str = "How many kilometres of bike lanes did the city build?";

/// A search backend (SearXNG's JSON) and the one page it finds, on loopback.
async fn serve_research() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let own = base.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let own = own.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]);
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                let filler = "The rest of this page is navigation, a newsletter sign-up form, links to older articles, a cookie notice, contact details for the press office, opening hours of the service centre, a list of upcoming public meetings, accessibility information, a site map and the usual legal notices that every page on this site carries at the bottom of the screen.";
                let (kind, body) = if path.starts_with("/search") {
                    (
                        "application/json",
                        json!({ "results": [
                            { "url": format!("{own}/lanes"), "title": "Lanes report", "content": "City report" }
                        ]})
                        .to_string(),
                    )
                } else if path == "/lanes" {
                    (
                        "text/html; charset=utf-8",
                        format!("<html><head><title>Lanes report</title></head><body><main><p>City report. In 2025 the city built 42 kilometres of protected bike lanes across six districts, the most in a single year.</p><p>{filler}</p><p>{filler}</p><p>{filler}</p></main></body></html>"),
                    )
                } else {
                    ("text/plain", "missing".to_string())
                };
                let status = if kind == "text/plain" {
                    "404 Not Found"
                } else {
                    "200 OK"
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: {kind}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    base
}

/// Answers each research call the way a good model would for [`serve_research`]'s page.
fn research_script() -> Script {
    Arc::new(|system, user| {
        let reply = if system.contains("You plan web research") {
            json!({ "subQuestions": [LANES_QUESTION], "scope": null,
                    "preferDomains": [], "avoidDomains": [], "depth": "standard" })
        } else if system.contains("You extract facts") {
            if !user.contains("Page title: Lanes report") {
                return Some(json!({ "claims": [] }).to_string());
            }
            json!({
                "claims": [
                    { "subQuestion": 1, "claim": "The city built 42 km of protected lanes in 2025.",
                      "quote": "In 2025 the city built 42 kilometres of protected bike lanes" },
                    { "subQuestion": 1, "claim": "The city built 90 km in one month.",
                      "quote": "the city built 90 kilometres of lanes in a single month" }
                ],
                "source": { "kind": "official", "credibility": "high", "reason": "the city's report" }
            })
        } else if system.contains("You check the progress") {
            json!({ "answered": [1], "followUps": [] })
        } else if system.contains("You review a research report") {
            json!({ "fixes": [] })
        } else if system.contains("You write research reports") {
            json!({
                "summary": "The city built 42 km of protected lanes [C1].",
                "findings": [{ "subQuestion": 1, "text": "42 km were built [C1]." }],
                "disagreements": null
            })
        } else {
            return None;
        };
        Some(reply.to_string())
    })
}

fn research_model() -> EchoModel {
    EchoModel {
        script: Some(research_script()),
        usage: Some(20),
        ..EchoModel::default()
    }
}

impl Harness {
    /// Web search through the local server at `base`, switched on and agreed to.
    async fn with_web(model: EchoModel, local_only: bool, keys: &[&str], base: &str) -> Self {
        let base = base.to_string();
        Self::new_tweaked(model, local_only, keys, move |s| {
            s.web_search_enabled = true;
            s.web_search_consent_acknowledged = true;
            s.web_search.local_backend = LocalSearchBackend::Searxng;
            s.web_search.searxng_base_url = Some(base);
        })
        .await
    }

    async fn conversation_of(&self, workflow_id: &str) -> String {
        repo::get(&self.state.db, &self.state.encryption, workflow_id)
            .await
            .unwrap()
            .unwrap()
            .conversation_id
            .expect("the workflow has a conversation")
    }

    async fn research_rows(&self) -> Vec<(String, String, String)> {
        sqlx::query_as("SELECT conversation_id, status, message_id FROM research_runs")
            .fetch_all(&self.state.db)
            .await
            .unwrap()
    }
}

fn research_workflow(extra: Value) -> Value {
    let mut research = json!({
        "id": "r", "type": "research",
        "question": "{{inputs.topic}}", "depth": "quick"
    });
    if let (Some(extra), Some(fields)) = (extra.as_object(), research.as_object_mut()) {
        fields.extend(extra.clone());
    }
    json!({
        "inputs": [{ "id": "topic", "label": "Topic", "default": LANES_QUESTION }],
        "steps": [research]
    })
}

#[tokio::test]
async fn a_research_step_runs_end_to_end_and_saves_the_report() {
    let base = serve_research().await;
    let h = Harness::with_web(research_model(), false, &[], &base).await;
    let id = h.save(research_workflow(json!({}))).await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed", "{:?}", run.run.error);

    let out = step(&run, "r", None).output.as_ref().unwrap();
    let conversation = h.conversation_of(&id).await;
    assert_eq!(out["conversationId"], conversation.as_str());
    assert_eq!(out["title"], LANES_QUESTION);
    assert!(out["summary"].as_str().unwrap().contains("42 km"), "{out}");
    assert_eq!(out["sources"].as_array().unwrap().len(), 1);
    assert_eq!(out["sources"][0]["title"], "Lanes report");
    assert_eq!(out["sources"][0]["url"], format!("{base}/lanes").as_str());
    assert_eq!(out["sources"][0]["credibility"], "high");
    assert_eq!(out["unanswered"], json!([]));
    assert_eq!(out["verifiedQuotes"], 1);
    assert_eq!(out["droppedClaims"], 1, "the planted quote was dropped");
    assert_eq!(
        out["model"],
        json!({ "provider": "ollama", "model": "echo" })
    );

    // The report is a document in the workflow's own conversation.
    let saved = artifacts::list(&h.state.db, &conversation).await.unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(out["reportArtifactId"], saved[0].id.as_str());
    let content = artifacts::get(&h.state.db, &h.state.encryption, &saved[0].id)
        .await
        .unwrap()
        .and_then(|a| a.content_text)
        .unwrap();
    assert_eq!(content, out["text"].as_str().unwrap());
    assert!(content.contains("42 km"), "{content}");

    // A research run is recorded against the workflow's conversation, with no card.
    assert_eq!(
        h.research_rows().await,
        vec![(conversation.clone(), "done".to_string(), String::new())]
    );
    // Its model calls count: usage rows, in the research run's own conversation.
    let usage: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM usage_summary")
        .fetch_one(&h.state.db)
        .await
        .unwrap();
    assert!(usage >= 4, "planner, extractor, gap check/writer: {usage}");
    assert!(h
        .model
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|r| r.conversation_id != conversation && r.tool_definitions.is_empty()));
}

#[tokio::test]
async fn a_research_step_uses_its_own_model() {
    let base = serve_research().await;
    let h = Harness::with_web(research_model(), false, &["openrouter"], &base).await;
    let id = h
        .save(research_workflow(
            json!({ "model": { "provider": "openrouter", "model": "cheap" } }),
        ))
        .await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed", "{:?}", run.run.error);
    let calls = h.model.calls.lock().unwrap().clone();
    assert!(calls.len() >= 4, "{calls:?}");
    assert!(
        calls
            .iter()
            .all(|c| c == &("openrouter".into(), "cheap".into())),
        "{calls:?}"
    );
    assert_eq!(
        step(&run, "r", None).output.as_ref().unwrap()["model"],
        json!({ "provider": "openrouter", "model": "cheap" })
    );
}

#[tokio::test]
async fn stopping_a_research_step_ends_the_run_and_the_research_as_stopped() {
    let base = serve_research().await;
    let model = EchoModel {
        hang: true,
        ..research_model()
    };
    let h = Harness::with_web(model, false, &[], &base).await;
    let id = h.save(research_workflow(json!({}))).await;
    let detail = h
        .run_and_stop(&id, std::time::Duration::from_millis(400))
        .await;
    assert_eq!(detail.run.status, "stopped");
    assert_eq!(detail.steps[0].status, "stopped");
    let rows = h.research_rows().await;
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].1, "stopped");
}

#[tokio::test]
async fn the_run_time_limit_stops_research_cleanly() {
    let base = serve_research().await;
    let model = EchoModel {
        hang: true,
        ..research_model()
    };
    let h = Harness::with_web(model, false, &[], &base).await;
    let id = h.save(research_workflow(json!({}))).await;
    let runner = Runner {
        state: &h.state,
        streams: &h.streams,
        fetch_policy: AddressPolicy { public_only: false },
        stop: Default::default(),
        unattended: None,
        budget: RunBudget {
            wall_clock: std::time::Duration::from_millis(500),
            ..RunBudget::default()
        },
        notify: None,
        questions: None,
        connectors: None,
        documents: None,
    };
    let detail = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        runner.run(&id, &HashMap::new(), "manual"),
    )
    .await
    .expect("the run ends at its time limit")
    .unwrap();
    assert_eq!(detail.run.status, "failed");
    assert!(
        detail.run.error.as_deref().unwrap().contains("time limit"),
        "{:?}",
        detail.run.error
    );
    assert_eq!(h.research_rows().await[0].1, "failed");
}

#[tokio::test]
async fn research_is_refused_in_local_only_mode_and_without_web_search() {
    // Local-only (the harness default): the existing wording, no model call.
    let h = Harness::new(research_model()).await;
    let id = h.save(research_workflow(json!({}))).await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "failed");
    assert!(
        run.run
            .error
            .as_deref()
            .unwrap()
            .contains("Research isn't available in local-only mode"),
        "{:?}",
        run.run.error
    );
    assert!(h.model.requests.lock().unwrap().is_empty());
    assert!(h.research_rows().await.is_empty());

    // Web search not set up.
    let h = Harness::new_with(research_model(), false, &[]).await;
    let id = h.save(research_workflow(json!({}))).await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "failed");
    assert!(
        run.run
            .error
            .as_deref()
            .unwrap()
            .contains("Research needs web search"),
        "{:?}",
        run.run.error
    );
    assert!(h.model.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn an_empty_question_fails_without_asking_a_model() {
    let base = serve_research().await;
    let h = Harness::with_web(research_model(), false, &[], &base).await;
    let id = h
        .save(json!({
            "inputs": [{ "id": "topic", "label": "Topic", "default": "" }],
            "steps": [{ "id": "r", "type": "research", "question": "{{inputs.topic}}" }]
        }))
        .await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "failed");
    assert!(
        run.run
            .error
            .as_deref()
            .unwrap()
            .contains("question came out empty"),
        "{:?}",
        run.run.error
    );
    assert!(h.model.requests.lock().unwrap().is_empty());
    assert!(h.research_rows().await.is_empty());
}

#[tokio::test]
async fn a_scheduled_research_step_asks_for_the_research_permission() {
    let base = serve_research().await;
    let h = Harness::with_web(research_model(), false, &[], &base).await;
    let id = h.save(research_workflow(json!({}))).await;
    assert_eq!(
        h.required(&id).await,
        vec![
            Permission::Model {
                provider: "ollama".into()
            },
            Permission::Research
        ]
    );
    // Model approved, research not: the run pauses on research, and a "no" ends it
    // before any model call.
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
        assert_eq!(review.step_id, "r");
        assert_eq!(review.permission.permission, Permission::Research);
        assert!(h.reviews.answer(&review.run_id, Decision::Deny));
    };
    let (detail, ()) = tokio::join!(run, answer);
    let detail = detail.unwrap();
    assert_eq!(detail.run.status, "failed");
    assert!(h.model.requests.lock().unwrap().is_empty());

    // Fully approved: it runs without asking.
    let approved = h.required(&id).await;
    let detail = h
        .unattended_runner(approved, CancellationToken::new())
        .run(&id, &no_inputs, "schedule")
        .await
        .unwrap();
    assert_eq!(detail.run.status, "completed", "{:?}", detail.run.error);
    assert!(h.reviews.list().is_empty());
}

#[test]
fn a_research_step_is_checked_when_the_workflow_is_saved() {
    let check = |step: Value| {
        conduit_desktop::workflows::definition::check_value(&json!({ "steps": [step] }))
    };
    assert!(check(json!({ "id": "r", "type": "research", "question": "Why?" })).is_ok());
    let deep = check(json!({ "id": "r", "type": "research", "question": "Why?", "depth": "deep" }));
    assert!(deep.unwrap_err().contains("isn't a research depth"));
    let empty = check(json!({ "id": "r", "type": "research", "question": " " }));
    assert!(empty.unwrap_err().contains("needs a question"));
    let looped = conduit_desktop::workflows::definition::check_value(&json!({ "steps": [
        { "id": "l", "type": "for_each", "items": "inputs.x", "steps": [
            { "id": "r", "type": "research", "question": "Why?" } ] } ],
        "inputs": [{ "id": "x", "label": "x" }]
    }));
    assert!(looped
        .unwrap_err()
        .contains("only works on the steps at the top level"));
    let bounds = |k: u64| {
        check(
            json!({ "id": "d", "type": "search_documents", "collections": ["c"],
                      "query": "q", "topK": k }),
        )
    };
    assert!(bounds(0).is_err());
    assert!(bounds(21).is_err());
    assert!(bounds(1).is_ok() && bounds(20).is_ok());
    let none =
        check(json!({ "id": "d", "type": "search_documents", "collections": [], "query": "q" }));
    assert!(none.unwrap_err().contains("at least one collection"));
}

// Documents search

fn docs_workflow(collections: &[&str], top_k: Option<u32>) -> Value {
    let mut step = json!({
        "id": "docs", "type": "search_documents",
        "collections": collections, "query": "{{inputs.q}}"
    });
    if let Some(k) = top_k {
        step["topK"] = json!(k);
    }
    json!({ "inputs": [{ "id": "q", "label": "Query", "default": "tomato garden" }], "steps": [step] })
}

/// A collection of two documents, embedded by the fake: one about gardens,
/// one about quantum computers.
async fn library(h: &Harness) -> String {
    use conduit_desktop::db::repository::knowledge as library;
    use conduit_desktop::knowledge::ingest::{ingest_text, EmbeddingConfig};
    let collection = library::create_collection(
        &h.state.db,
        library::NewCollection {
            name: "Project notes".to_string(),
            provider_id: "ollama".to_string(),
            embedding_model: "fake-embed-1".to_string(),
            embedding_dimensions: VOCAB.len() as i64,
        },
    )
    .await
    .unwrap();
    let embedding = EmbeddingConfig {
        provider_id: "ollama".to_string(),
        model_id: "fake-embed-1".to_string(),
        adapter: Box::new(EchoModel::default()),
        adapter_ctx: AdapterContext {
            api_key: None,
            base_url: None,
            http: provider_core::transport::HttpClient::new(),
            local_only: false,
        },
    };
    let garden =
        "Growing a tomato garden starts with good soil. A tomato garden bed needs sun. ".repeat(8);
    let physics =
        "A qubit is the unit of a quantum computer. Quantum research keeps a qubit stable. "
            .repeat(8);
    for (title, text) in [("Garden notes", garden), ("Physics notes", physics)] {
        ingest_text(
            &h.state.db,
            &h.state.encryption,
            &embedding,
            &collection.id,
            &format!("test://{title}"),
            title,
            &text,
        )
        .await
        .unwrap();
    }
    collection.id
}

async fn consenting() -> Harness {
    Harness::new_tweaked(EchoModel::default(), true, &[], |s| {
        s.embedding_consent_providers = vec!["ollama".to_string()];
    })
    .await
}

#[tokio::test]
async fn a_documents_step_returns_cited_passages_and_honours_top_k() {
    let h = consenting().await;
    let collection = library(&h).await;
    let id = h.save(docs_workflow(&[collection.as_str()], Some(1))).await;
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "completed", "{:?}", run.run.error);
    let out = step(&run, "docs", None).output.as_ref().unwrap();
    assert_eq!(out["count"], 1);
    let passage = &out["passages"][0];
    assert_eq!(passage["document"], "Garden notes");
    assert_eq!(passage["collection"], "Project notes");
    assert_eq!(passage["citation"], "Garden notes (Project notes)");
    assert!(passage["text"].as_str().unwrap().contains("tomato"));
    assert!(
        out["text"]
            .as_str()
            .unwrap()
            .starts_with("[1] Garden notes (Project notes)\n"),
        "{}",
        out["text"]
    );

    // Without topK, up to six; the query steers which document comes first.
    let id = h.save(docs_workflow(&[collection.as_str()], None)).await;
    let mut inputs = HashMap::new();
    inputs.insert("q".to_string(), "quantum qubit".to_string());
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
        documents: None,
    };
    let run = runner.run(&id, &inputs, "manual").await.unwrap();
    let out = step(&run, "docs", None).output.as_ref().unwrap();
    assert!(out["count"].as_u64().unwrap() >= 1 && out["count"].as_u64().unwrap() <= 6);
    assert_eq!(out["passages"][0]["document"], "Physics notes");
}

#[tokio::test]
async fn a_documents_step_without_consent_fails_plainly_and_never_asks() {
    let h = Harness::new(EchoModel::default()).await;
    let collection = library(&h).await;
    let id = h.save(docs_workflow(&[collection.as_str()], None)).await;
    // Unattended and nothing approved: the failure comes first, no review is raised.
    let detail = h
        .unattended_runner(vec![], CancellationToken::new())
        .run(&id, &HashMap::new(), "schedule")
        .await
        .unwrap();
    assert_eq!(detail.run.status, "failed");
    let error = detail.run.error.unwrap();
    assert!(
        error.contains(
            "Documents search needs your OK to use Ollama \u{2014} open Documents to allow it."
        ),
        "{error}"
    );
    assert!(h.reviews.list().is_empty());
}

#[tokio::test]
async fn a_documents_step_reports_a_deleted_collection_and_an_empty_query() {
    let h = consenting().await;
    let collection = library(&h).await;
    let id = h.save(docs_workflow(&[collection.as_str()], None)).await;
    let mut empty = HashMap::new();
    empty.insert("q".to_string(), "  ".to_string());
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
        documents: None,
    };
    let run = runner.run(&id, &empty, "manual").await.unwrap();
    assert_eq!(run.run.status, "failed");
    assert!(run.run.error.unwrap().contains("query came out empty"));

    conduit_desktop::db::repository::knowledge::delete_collection(&h.state.db, &collection)
        .await
        .unwrap();
    let run = h.run(&id).await;
    assert_eq!(run.run.status, "failed");
    assert!(run
        .run
        .error
        .unwrap()
        .contains("collection this step searches was deleted"),);
}

#[tokio::test]
async fn a_scheduled_documents_step_is_reviewed_by_collection_title() {
    let h = consenting().await;
    let collection = library(&h).await;
    let id = h.save(docs_workflow(&[collection.as_str()], Some(2))).await;
    let required = h.required(&id).await;
    let expected = Permission::Documents {
        collections: vec![permissions::CollectionRef {
            id: collection.clone(),
            title: "Project notes".into(),
        }],
    };
    assert_eq!(required, vec![expected.clone()]);

    let runner = h.unattended_runner(vec![], CancellationToken::new());
    let no_inputs = HashMap::new();
    let run = runner.run(&id, &no_inputs, "schedule");
    let answer = async {
        let review = h.next_review().await;
        assert_eq!(review.permission.permission, expected);
        assert_eq!(
            review.permission.label.as_deref(),
            Some("Search your documents: Project notes")
        );
        assert!(h.reviews.answer(&review.run_id, Decision::AllowOnce));
    };
    let (detail, ()) = tokio::join!(run, answer);
    assert_eq!(detail.unwrap().run.status, "completed");
}
