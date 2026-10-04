//! Writing end to end: agent turns in a draft's chat, run by the real loop
//! (`StreamManager::run_agent_turn`) against a scripted provider, the way
//! `tests/agent_turn.rs` drives it.
//!
//! outline → approve → the draft written section by section (the turn keeps
//! going, and the finish-after-document-write guardrail never ends it
//! mid-draft; a model that stops with sections unwritten is asked for the
//! next one) → the user edits a paragraph (pinned) →
//! `edit_blocks` on it is refused, then accepted with `release_pinned` →
//! `replace_in_draft` counts pinned blocks → Markdown and HTML export.

mod common;

use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use conduit_desktop::{
    agent_tools::{
        EDIT_BLOCKS_TOOL, READ_DRAFT_TOOL, REPLACE_IN_DRAFT_TOOL, SET_OUTLINE_TOOL,
        WRITE_SECTION_TOOL,
    },
    connector_runtime::ConnectorRuntimeManager,
    db::repository::{drafts, tool_calls},
    draft_export,
    paths::AppPaths,
    state::AppState,
    stream_manager::StreamManager,
};
use futures::stream::{Stream, StreamExt};
use provider_core::schema::{
    AgentGuardrails, AppSettings, BlockOwner, ConnectorRuntimeEvent, DraftDetail,
    DraftExportFormat, DraftSnapshotCause, DraftStage, Message, MessagePart, MessagePartKind,
    MessageRole, OutlineSection, PermissionLevel, ProviderError, ProviderEvent, ProviderRequest,
    ToolDefinition,
};
use provider_core::{AdapterContext, ModelInfo, ProviderAdapter};
use serde_json::{json, Value};
use sqlx::SqlitePool;
use tauri::ipc::Channel;
use tokio_util::sync::CancellationToken;

// ── Scripted provider (as in tests/agent_turn.rs) ───────────────────────────

type Round = Arc<dyn Fn(&str) -> Vec<ProviderEvent> + Send + Sync>;

/// How long a round waits before its first tool call completes.
type Pauses = Arc<Vec<Duration>>;

#[derive(Clone)]
struct Script {
    rounds: Arc<Vec<Round>>,
    pauses: Pauses,
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
        let pause = self.0.pauses.get(index).copied().unwrap_or_default();
        Ok(Box::pin(futures::stream::iter(events).then(
            move |e| async move {
                if matches!(e, ProviderEvent::ToolCallComplete { .. }) && !pause.is_zero() {
                    tokio::time::sleep(pause).await;
                }
                e
            },
        )))
    }
}

fn text_round(text: &'static str) -> Round {
    Arc::new(move |rid: &str| {
        let r = rid.to_string();
        vec![
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
            ProviderEvent::MessageComplete {
                request_id: r,
                index: 4,
                finish_reason: "stop".into(),
            },
        ]
    })
}

/// One response holding several tool calls, as a model that batches does.
fn tool_calls_round(calls: Vec<(&'static str, Value)>) -> Round {
    Arc::new(move |rid: &str| {
        let r = rid.to_string();
        let mut events = vec![ProviderEvent::MessageStart {
            request_id: r.clone(),
            index: 0,
        }];
        let mut index = 1;
        for (i, (name, arguments)) in calls.iter().enumerate() {
            let id = format!("call-{r}-{i}");
            events.push(ProviderEvent::ToolCallStart {
                request_id: r.clone(),
                tool_call_id: id.clone(),
                index,
                tool_id: (*name).into(),
                name: (*name).into(),
            });
            events.push(ProviderEvent::ToolCallComplete {
                request_id: r.clone(),
                tool_call_id: id,
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
        events
    })
}

fn tool_round(name: &'static str, arguments: Value) -> Round {
    Arc::new(move |rid: &str| {
        let r = rid.to_string();
        let id = format!("call-{r}");
        vec![
            ProviderEvent::MessageStart {
                request_id: r.clone(),
                index: 0,
            },
            ProviderEvent::ToolCallStart {
                request_id: r.clone(),
                tool_call_id: id.clone(),
                index: 1,
                tool_id: name.into(),
                name: name.into(),
            },
            ProviderEvent::ToolCallComplete {
                request_id: r.clone(),
                tool_call_id: id,
                index: 2,
                arguments: arguments.clone(),
            },
            ProviderEvent::MessageComplete {
                request_id: r,
                index: 3,
                finish_reason: "tool_calls".into(),
            },
        ]
    })
}

// ── Harness ─────────────────────────────────────────────────────────────────

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

fn tool(name: &str) -> ToolDefinition {
    ToolDefinition {
        tool_id: name.into(),
        name: name.into(),
        description: name.into(),
        input_schema: json!({ "type": "object", "properties": {} }),
        kind: None,
        host_config: None,
        permission_level: Some(PermissionLevel::SideEffectful),
        display_group: Some("Writing".into()),
        tenant_scope: None,
    }
}

struct Studio {
    _dir: tempfile::TempDir,
    pool: SqlitePool,
    state: AppState,
    draft_id: String,
    conversation_id: String,
    turns: usize,
}

struct Turn {
    events: Vec<ProviderEvent>,
    rounds_started: usize,
    request_ids: Vec<String>,
    requests: Vec<ProviderRequest>,
}

impl Turn {
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

    fn ended_normally(&self) -> bool {
        matches!(
            self.events.iter().rev().find(|e| matches!(
                e,
                ProviderEvent::MessageComplete { .. } | ProviderEvent::Error { .. }
            )),
            Some(ProviderEvent::MessageComplete { finish_reason, .. }) if finish_reason == "stop"
        )
    }
}

impl Studio {
    async fn new(brief: &str) -> Self {
        Self::with_time_limit(brief, 300).await
    }

    async fn with_time_limit(brief: &str, wall_clock_budget_secs: u32) -> Self {
        let pool = common::setup_pool().await;
        let dir = tempfile::tempdir().unwrap();
        let settings = AppSettings {
            active_provider: "ollama".into(),
            active_model: "scripted".into(),
            // The default: finish after a document write is on.
            agent: AgentGuardrails {
                max_steps: 25,
                wall_clock_budget_secs,
                finish_after_document_write: None,
            },
            local_only: true,
            ..AppSettings::default()
        };
        let state =
            AppState::test_instance_with_settings(pool.clone(), test_paths(dir.path()), settings);
        let draft = drafts::create(&pool, &state.encryption, brief)
            .await
            .unwrap();
        Self {
            _dir: dir,
            pool,
            state,
            draft_id: draft.id,
            conversation_id: draft.conversation_id,
            turns: 0,
        }
    }

    async fn draft(&self) -> DraftDetail {
        drafts::get(&self.pool, &self.state.encryption, &self.draft_id)
            .await
            .unwrap()
            .unwrap()
    }

    /// Give the draft an outline of these headings and approve it.
    async fn approved_outline(&self, headings: &[&str]) {
        self.set_outline(headings).await;
        drafts::set_stage(
            &self.pool,
            &self.state.encryption,
            &self.draft_id,
            DraftStage::Draft,
        )
        .await
        .unwrap();
    }

    async fn set_outline(&self, headings: &[&str]) {
        let outline = headings
            .iter()
            .map(|h| OutlineSection {
                heading: h.to_string(),
                intent: format!("About {h}"),
                target_words: None,
            })
            .collect();
        drafts::set_outline(
            &self.pool,
            &self.state.encryption,
            &self.draft_id,
            outline,
            false,
        )
        .await
        .unwrap();
    }

    /// One user turn in the draft's chat, offered the stage's draft tools.
    async fn turn(&mut self, prompt: &str, rounds: Vec<Round>) -> Turn {
        self.turn_paced(prompt, rounds, Vec::new()).await
    }

    /// [`Self::turn`] where round `i` waits `pauses[i]` before its tool call
    /// completes.
    async fn turn_paced(
        &mut self,
        prompt: &str,
        rounds: Vec<Round>,
        pauses: Vec<Duration>,
    ) -> Turn {
        self.turn_stopped(prompt, rounds, pauses, None).await
    }

    /// [`Self::turn_paced`], pressing Stop shortly after round `stop_in`
    /// (1-based) starts, when given.
    async fn turn_stopped(
        &mut self,
        prompt: &str,
        rounds: Vec<Round>,
        pauses: Vec<Duration>,
        stop_in: Option<usize>,
    ) -> Turn {
        self.turns += 1;
        let stage = self.draft().await.stage;
        let tools: &[&str] = match stage {
            DraftStage::Outline => &[READ_DRAFT_TOOL, SET_OUTLINE_TOOL],
            DraftStage::Draft => &[
                READ_DRAFT_TOOL,
                WRITE_SECTION_TOOL,
                EDIT_BLOCKS_TOOL,
                REPLACE_IN_DRAFT_TOOL,
            ],
        };
        let script = Script {
            rounds: Arc::new(rounds),
            pauses: Arc::new(pauses),
            requests: Arc::new(Mutex::new(Vec::new())),
        };
        let resolver_script = script.clone();
        let manager = StreamManager::with_adapter_resolver(Arc::new(move |_id: &str| {
            Some(Box::new(ScriptedAdapter(resolver_script.clone())) as Box<dyn ProviderAdapter>)
        }));
        let runtime = ConnectorRuntimeManager::new_with(
            Duration::from_millis(80),
            Duration::from_millis(800),
        );
        let events = Arc::new(Mutex::new(Vec::<ProviderEvent>::new()));
        let sink = events.clone();
        let channel: Channel<ProviderEvent> = Channel::new(move |body| {
            let event: ProviderEvent = body.deserialize().expect("provider event");
            sink.lock().unwrap().push(event);
            Ok(())
        });
        let runtime_channel: Channel<ConnectorRuntimeEvent> = Channel::new(|_| Ok(()));
        let message_id = format!("user-{}", self.turns);
        let request = ProviderRequest {
            request_id: format!("turn-{}", self.turns),
            conversation_id: self.conversation_id.clone(),
            model_id: "scripted".into(),
            messages: vec![Message {
                id: message_id.clone(),
                conversation_id: self.conversation_id.clone(),
                role: MessageRole::User,
                author_label: None,
                provider_message_id: None,
                request_id: None,
                interrupted_at: None,
                metadata: None,
                parts: vec![MessagePart {
                    id: format!("{message_id}/p0"),
                    message_id: message_id.clone(),
                    index: 0,
                    kind: MessagePartKind::Text,
                    content: Some(prompt.into()),
                    mime_type: None,
                    tool_call_id: None,
                    artifact_id: None,
                    attachment_id: None,
                    blob_ref: None,
                    metadata: None,
                    created_at: "2026-10-04T00:00:00Z".into(),
                }],
                created_at: "2026-10-04T00:00:00Z".into(),
            }],
            system_prompt: None,
            developer_prompt: None,
            attachments: None,
            tool_definitions: tools.iter().map(|name| tool(name)).collect(),
            generation_controls: None,
            response_format: None,
            web_search: None,
        };
        let turn_id = request.request_id.clone();
        let run = manager.run_agent_turn(&self.state, &runtime, request, channel, runtime_channel);
        let stop = async {
            let Some(round) = stop_in else { return };
            for _ in 0..2_000 {
                if script.requests.lock().unwrap().len() >= round {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    manager
                        .cancel_stream(&self.state, &turn_id, None)
                        .await
                        .unwrap();
                    return;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        };
        let (result, ()) = tokio::join!(run, stop);
        result.expect("turn runs");
        let events = events.lock().unwrap().clone();
        let requests = script.requests.lock().unwrap().clone();
        Turn {
            events,
            rounds_started: requests.len(),
            request_ids: requests.iter().map(|r| r.request_id.clone()).collect(),
            requests,
        }
    }

    /// The saved output of each call of `tool` made in `turn`.
    async fn outputs(&self, turn: &Turn, tool: &str) -> Vec<Value> {
        let mut out = Vec::new();
        let mut ids = turn.request_ids.clone();
        ids.dedup();
        for request_id in ids {
            for record in tool_calls::list_tool_calls_by_request(&self.pool, &request_id)
                .await
                .unwrap()
            {
                if record.tool_id == tool {
                    // A failed call keeps its message in `error`.
                    out.push(match (record.result, record.error) {
                        (Some(result), _) => result,
                        (None, Some(error)) => Value::String(error),
                        (None, None) => Value::Null,
                    });
                }
            }
        }
        out
    }
}

fn block_text(draft: &DraftDetail, id: &str) -> String {
    let b = draft.blocks.iter().find(|b| b.id == id).expect(id);
    let units: Vec<u16> = draft.markdown.encode_utf16().collect();
    String::from_utf16(&units[b.start as usize..b.end as usize]).unwrap()
}

fn block_id(draft: &DraftDetail, text: &str) -> String {
    draft
        .blocks
        .iter()
        .find(|b| block_text(draft, &b.id) == text)
        .unwrap_or_else(|| panic!("no block {text:?}"))
        .id
        .clone()
}

#[tokio::test]
async fn a_draft_is_outlined_written_edited_and_exported() {
    let mut studio = Studio::new("A short guide to brewing green tea, for beginners").await;

    // ── Outline ──────────────────────────────────────────────────────────
    let outline = studio
        .turn(
            "A short guide to brewing green tea, for beginners",
            vec![
                tool_round(
                    SET_OUTLINE_TOOL,
                    json!({
                        "title": "Brewing green tea",
                        "sections": [
                            { "heading": "Why green tea", "intent": "Hook the reader", "target_words": 120 },
                            { "heading": "Brewing", "intent": "Water, time, leaves", "target_words": 300 },
                            { "heading": "Serving", "intent": "Cups and pairings", "target_words": 150 },
                        ]
                    }),
                ),
                text_round("Here is an outline. Approve it when it looks right."),
            ],
        )
        .await;
    assert_eq!(
        outline.tool_executions(),
        [(SET_OUTLINE_TOOL.to_string(), false)]
    );
    assert_eq!(outline.rounds_started, 2);
    assert!(outline.ended_normally());
    let draft = studio.draft().await;
    assert_eq!(draft.title, "Brewing green tea");
    assert_eq!(draft.outline.len(), 3);
    assert_eq!(draft.markdown, "");

    // ── Approve ──────────────────────────────────────────────────────────
    drafts::set_stage(
        &studio.pool,
        &studio.state.encryption,
        &studio.draft_id,
        DraftStage::Draft,
    )
    .await
    .unwrap();

    // ── Write, section by section ────────────────────────────────────────
    let written = studio
        .turn(
            "Write the draft from the approved outline.",
            vec![
                tool_round(
                    WRITE_SECTION_TOOL,
                    json!({
                        "heading": "Why green tea",
                        "markdown": "Green tea is gentle and fresh.\n\nIt rewards a little care.",
                        // Dropped from the schema; still accepted and ignored.
                        "more_to_write": true
                    }),
                ),
                tool_round(
                    WRITE_SECTION_TOOL,
                    json!({
                        "heading": "Brewing",
                        "markdown": "## Brewing\n\nUse water at about 80C.\n\nSteep the tea for two minutes."
                    }),
                ),
                // The last section: the turn still gets its closing round
                // (draft tools are not document writes), and nothing is left
                // to continue with.
                tool_round(
                    WRITE_SECTION_TOOL,
                    json!({ "heading": "Serving", "markdown": "Serve it in small cups." }),
                ),
                text_round("The draft is written."),
            ],
        )
        .await;
    assert_eq!(written.rounds_started, 4, "every section round continued");
    assert_eq!(
        written.tool_executions(),
        vec![(WRITE_SECTION_TOOL.to_string(), false); 3]
    );
    assert!(written.ended_normally());
    let draft = studio.draft().await;
    assert_eq!(
        draft.markdown,
        "## Why green tea\n\nGreen tea is gentle and fresh.\n\nIt rewards a little care.\n\n\
         ## Brewing\n\nUse water at about 80C.\n\nSteep the tea for two minutes.\n\n\
         ## Serving\n\nServe it in small cups.\n"
    );
    assert!(draft
        .blocks
        .iter()
        .all(|b| b.owner == BlockOwner::Ai && !b.pinned));
    assert_eq!(draft.blocks.len(), 8);
    let written_snapshot = drafts::snapshot(
        &studio.pool,
        &studio.state.encryption,
        &studio.draft_id,
        DraftSnapshotCause::AiTurn,
        Some("Write the draft from the approved outline."),
    )
    .await
    .unwrap();
    assert!(written_snapshot.is_some());

    // ── The user edits a paragraph: it becomes pinned ────────────────────
    let edited = draft.markdown.replace(
        "Use water at about 80C.",
        "Use water at 75 to 80C, never boiling.",
    );
    let draft = drafts::save_markdown(
        &studio.pool,
        &studio.state.encryption,
        &studio.draft_id,
        &edited,
    )
    .await
    .unwrap();
    let mine = block_id(&draft, "Use water at 75 to 80C, never boiling.");
    let pinned = draft.blocks.iter().find(|b| b.id == mine).unwrap();
    assert_eq!((pinned.owner, pinned.pinned), (BlockOwner::Mixed, true));

    // ── edit_blocks on it: refused, then allowed with release_pinned ─────
    let edits = studio
        .turn(
            "Make the brewing paragraph shorter.",
            vec![
                tool_round(
                    EDIT_BLOCKS_TOOL,
                    json!({ "edits": [{ "block_id": mine, "markdown": "Use hot water." }] }),
                ),
                tool_round(
                    EDIT_BLOCKS_TOOL,
                    json!({
                        "edits": [{ "block_id": mine, "markdown": "Use water below boiling." }],
                        "release_pinned": [mine]
                    }),
                ),
                text_round("Shortened it."),
            ],
        )
        .await;
    assert_eq!(
        edits.tool_executions(),
        [
            (EDIT_BLOCKS_TOOL.to_string(), true),
            (EDIT_BLOCKS_TOOL.to_string(), false)
        ]
    );
    let refusal = &studio.outputs(&edits, EDIT_BLOCKS_TOOL).await[0];
    let message = refusal.to_string();
    assert!(
        message.contains(&mine) && message.contains("release_pinned"),
        "{message}"
    );
    let draft = studio.draft().await;
    assert_eq!(block_text(&draft, &mine), "Use water below boiling.");
    let now = draft.blocks.iter().find(|b| b.id == mine).unwrap();
    assert_eq!((now.owner, now.pinned), (BlockOwner::Ai, false));

    // ── replace_in_draft counts pinned blocks too ────────────────────────
    let edited = draft
        .markdown
        .replace("Serve it in small cups.", "Serve the tea in small cups.");
    let draft = drafts::save_markdown(
        &studio.pool,
        &studio.state.encryption,
        &studio.draft_id,
        &edited,
    )
    .await
    .unwrap();
    let serving = block_id(&draft, "Serve the tea in small cups.");
    let swap = studio
        .turn(
            "Say leaves instead of tea everywhere.",
            vec![
                tool_round(
                    REPLACE_IN_DRAFT_TOOL,
                    json!({ "find": "tea", "replace": "leaves", "whole_word": true }),
                ),
                text_round("Swapped."),
            ],
        )
        .await;
    assert_eq!(
        swap.tool_executions(),
        [(REPLACE_IN_DRAFT_TOOL.to_string(), false)]
    );
    let result = &studio.outputs(&swap, REPLACE_IN_DRAFT_TOOL).await[0];
    // "Green tea is…", "Steep the tea…", "Serve the tea…" (whole words only:
    // the headings' "green tea" counts too).
    assert_eq!(result["pinned_changed"], json!([serving]), "{result}");
    let total = result["total"].as_u64().unwrap();
    assert_eq!(total, 4, "{result}");
    let draft = studio.draft().await;
    assert_eq!(
        block_text(&draft, &serving),
        "Serve the leaves in small cups."
    );
    assert!(
        draft
            .blocks
            .iter()
            .find(|b| b.id == serving)
            .unwrap()
            .pinned
    );
    assert!(!draft.markdown.contains(" tea"));

    // ── Export ───────────────────────────────────────────────────────────
    let md = draft_export::render(&draft.title, &draft.markdown, DraftExportFormat::Markdown);
    assert_eq!(md, draft.markdown);
    let html = draft_export::render(&draft.title, &draft.markdown, DraftExportFormat::Html);
    assert!(html.starts_with("<!DOCTYPE html>"));
    assert!(html.contains("<title>Brewing green tea</title>"));
    assert!(html.contains("<h2>Why green leaves</h2>"), "{html}");
    assert!(html.contains("<p>Use water below boiling.</p>"));
    assert!(html.contains("<p>Serve the leaves in small cups.</p>"));

    // History: created, the AI turn, nothing else recorded by the backend.
    let history = drafts::list_snapshots(&studio.pool, &studio.draft_id)
        .await
        .unwrap();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].cause, DraftSnapshotCause::AiTurn);
}

#[tokio::test]
async fn a_draft_written_in_parts_buys_time_and_stops_with_a_continue_code() {
    // Limit 1s. Round 1 saves a section after 1.5s, with another outline
    // section still unwritten: saved progress, so the turn may run until
    // 2.5s. Round 2 only reads, for 1.2s; the limit hits before round 3 while
    // the draft is still being written.
    let mut studio = Studio::with_time_limit("A field guide to moss", 1).await;
    studio
        .set_outline(&["Where moss grows", "How to grow it"])
        .await;
    drafts::set_stage(
        &studio.pool,
        &studio.state.encryption,
        &studio.draft_id,
        DraftStage::Draft,
    )
    .await
    .unwrap();
    let turn = studio
        .turn_paced(
            "Write the draft from the approved outline.",
            vec![
                tool_round(
                    WRITE_SECTION_TOOL,
                    json!({ "heading": "Where moss grows", "markdown": "In shade." }),
                ),
                tool_round(READ_DRAFT_TOOL, json!({})),
                text_round("never requested"),
            ],
            vec![Duration::from_millis(1500), Duration::from_millis(1200)],
        )
        .await;
    assert_eq!(
        turn.rounds_started, 2,
        "the saved section bought the second round"
    );
    let terminal = turn
        .events
        .iter()
        .rev()
        .find(|e| {
            matches!(
                e,
                ProviderEvent::MessageComplete { .. } | ProviderEvent::Error { .. }
            )
        })
        .unwrap();
    assert!(
        matches!(
            terminal,
            ProviderEvent::Error { error, .. }
                if error.provider_code.as_deref() == Some("turn_time_limit_building")
        ),
        "got {terminal:?}"
    );
    assert!(studio.draft().await.markdown.contains("In shade."));
}

/// The text of the last message of a provider request.
fn last_message_text(request: &ProviderRequest) -> String {
    request
        .messages
        .last()
        .and_then(|m| m.parts.first())
        .and_then(|p| p.content.clone())
        .unwrap_or_default()
}

fn section(heading: &str, markdown: &str) -> Value {
    json!({ "heading": heading, "markdown": markdown })
}

#[tokio::test]
async fn a_model_that_stops_after_each_section_is_asked_for_the_next() {
    let mut studio = Studio::new("Houseplants for dark rooms").await;
    studio
        .approved_outline(&["Why light matters", "Plants that cope", "Care"])
        .await;
    let turn = studio
        .turn(
            "Write the draft from the approved outline.",
            vec![
                tool_round(
                    WRITE_SECTION_TOOL,
                    section("Why light matters", "Plants feed on light."),
                ),
                text_round("I wrote the first section."),
                tool_round(
                    WRITE_SECTION_TOOL,
                    section("Plants that cope", "Snake plants and pothos."),
                ),
                text_round("Second one done."),
                tool_round(WRITE_SECTION_TOOL, section("Care", "Water less.")),
                text_round("The draft is written."),
            ],
        )
        .await;
    assert_eq!(turn.rounds_started, 6, "continued twice, then ended");
    assert!(turn.ended_normally());
    assert_eq!(
        turn.tool_executions(),
        vec![(WRITE_SECTION_TOOL.to_string(), false); 3]
    );
    // Rounds 3 and 5 were asked for the next unwritten section, after the
    // model's own closing words.
    assert_eq!(
        last_message_text(&turn.requests[2]),
        "Next: write the section \"Plants that cope\" with write_section."
    );
    let before = &turn.requests[2].messages[turn.requests[2].messages.len() - 2];
    assert_eq!(before.role, MessageRole::Assistant);
    assert_eq!(
        last_message_text(&turn.requests[4]),
        "Next: write the section \"Care\" with write_section."
    );
    let draft = studio.draft().await;
    assert!(draft.markdown.contains("## Care\n\nWater less."));

    // The tool result says what is left.
    let outputs = studio.outputs(&turn, WRITE_SECTION_TOOL).await;
    assert_eq!(
        outputs
            .iter()
            .map(|o| o["remaining"].clone())
            .collect::<Vec<_>>(),
        [
            json!(["Plants that cope", "Care"]),
            json!(["Care"]),
            json!([])
        ]
    );
}

#[tokio::test]
async fn a_model_that_batches_sections_still_works() {
    let mut studio = Studio::new("Houseplants for dark rooms").await;
    studio
        .approved_outline(&["Why light matters", "Plants that cope", "Care"])
        .await;
    let turn = studio
        .turn(
            "Write the draft from the approved outline.",
            vec![
                tool_calls_round(vec![
                    (WRITE_SECTION_TOOL, section("Why light matters", "Light.")),
                    (WRITE_SECTION_TOOL, section("Plants that cope", "Pothos.")),
                    (WRITE_SECTION_TOOL, section("Care", "Water less.")),
                ]),
                text_round("All three sections are written."),
            ],
        )
        .await;
    assert_eq!(turn.rounds_started, 2);
    assert!(turn.ended_normally());
    assert_eq!(
        studio.draft().await.markdown,
        "## Why light matters\n\nLight.\n\n## Plants that cope\n\nPothos.\n\n## Care\n\nWater less.\n"
    );
}

#[tokio::test]
async fn continuations_are_bounded_and_need_a_section_written_this_turn() {
    let mut studio = Studio::new("Houseplants for dark rooms").await;
    studio
        .approved_outline(&["Why light matters", "Plants that cope", "Care"])
        .await;

    // A reply with no section written: nothing to continue.
    let chat = studio
        .turn(
            "What do you think of the outline?",
            vec![text_round("It reads well.")],
        )
        .await;
    assert_eq!(chat.rounds_started, 1);

    // One section, then the model only talks: asked again at most
    // outline.len() + 2 = 5 times, then the turn ends normally.
    let stubborn = studio
        .turn(
            "Write the draft from the approved outline.",
            vec![tool_round(
                WRITE_SECTION_TOOL,
                section("Why light matters", "Light."),
            )],
        )
        .await;
    assert_eq!(stubborn.rounds_started, 2 + 5);
    assert!(stubborn.ended_normally());
    for request in &stubborn.requests[2..] {
        assert_eq!(
            last_message_text(request),
            "Next: write the section \"Plants that cope\" with write_section."
        );
    }
}

#[tokio::test]
async fn stop_ends_a_draft_turn_that_would_continue() {
    let mut studio = Studio::new("Houseplants for dark rooms").await;
    studio
        .approved_outline(&["Why light matters", "Plants that cope", "Care"])
        .await;
    // Stop arrives while round 3 (the first continuation) is writing.
    let turn = studio
        .turn_stopped(
            "Write the draft from the approved outline.",
            vec![
                tool_round(WRITE_SECTION_TOOL, section("Why light matters", "Light.")),
                text_round("First one done."),
                tool_round(WRITE_SECTION_TOOL, section("Plants that cope", "Pothos.")),
                text_round("never requested"),
            ],
            vec![Duration::ZERO, Duration::ZERO, Duration::from_millis(1_500)],
            Some(3),
        )
        .await;
    assert_eq!(turn.rounds_started, 3, "no round after Stop");
    let draft = studio.draft().await;
    assert!(!draft.markdown.contains("Pothos."), "{}", draft.markdown);
}
