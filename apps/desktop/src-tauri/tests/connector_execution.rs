//! Phase 4 M4.5: tool execution orchestration — the end-to-end path that
//! resolves a capability, runs consent, invokes the connector, size-caps +
//! redacts the output, persists `tool_calls`/`tool_results`, emits
//! `ToolCallFinished`, and (the §6 invariant) never reinjects tool output into
//! messages. Drives the real supervisor against the `echo_connector` fixture.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use conduit_desktop::connector_runtime::execution::{
    execute_tool_call, EventSink, MAX_OUTPUT_BYTES,
};
use conduit_desktop::connector_runtime::ConnectorRuntimeManager;
use conduit_desktop::db::repository::{connectors, conversations, messages, tool_calls};
use conduit_desktop::paths::AppPaths;
use conduit_desktop::state::AppState;
use conduit_desktop::time::now_iso8601;
use provider_core::schema::{
    ConnectorRuntimeEvent, Message, MessagePart, MessagePartKind, MessageRole, ToolCallStatus,
};
use serde_json::json;
use sqlx::SqlitePool;
use uuid::Uuid;

fn echo_bin() -> &'static Path {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let workspace_root = manifest.join("../../..");
        let target = workspace_root.join("target");
        let exe = target
            .join("debug")
            .join(format!("echo_connector{}", std::env::consts::EXE_SUFFIX));
        let status = std::process::Command::new("cargo")
            .args(["build", "--bin", "echo_connector", "-p", "mcp-runtime"])
            .current_dir(&workspace_root)
            .status()
            .expect("failed to invoke cargo to build echo_connector");
        assert!(status.success(), "cargo build echo_connector failed");
        assert!(exe.exists(), "echo_connector not found at {exe:?} after build");
        exe
    })
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
    }
}

/// Seed a connector (stdio → echo_connector) + active grant and return the
/// version id. `allowlist` lets a test restrict the discovered tools.
async fn seed_connector(pool: &SqlitePool, allowlist: Option<&[&str]>) -> String {
    let def = connectors::ConnectorDefinition {
        id: "echo".into(),
        name: "Echo".into(),
        description: "echo fixture".into(),
        transport: "stdio".into(),
        owner: "test".into(),
        icon: None,
        support_url: None,
        consent_copy: Some("Tenant consent copy".into()),
        policy_metadata: None,
        cloud_id: None,
        created_at: "2026-06-22T00:00:00Z".into(),
        updated_at: "2026-06-22T00:00:00Z".into(),
    };
    connectors::upsert_definition(pool, &def).await.unwrap();

    let bin = echo_bin().to_string_lossy().to_string();
    let capability_allowlist = allowlist
        .map(|names| serde_json::Value::Array(names.iter().map(|n| json!(n)).collect()));
    let version = connectors::ConnectorVersion {
        id: "echo:1.0.0".into(),
        connector_id: "echo".into(),
        version: "1.0.0".into(),
        transport_config: json!({ "command": bin, "args": [], "env": {} }),
        scope_grants: None,
        capability_allowlist,
        rollout_channel: None,
        support_state: None,
        created_at: "2026-06-22T00:00:00Z".into(),
    };
    connectors::insert_version(pool, &version).await.unwrap();

    let grant = connectors::ConnectorGrant {
        id: "g-echo".into(),
        connector_version_id: "echo:1.0.0".into(),
        scope: "user".into(),
        status: "active".into(),
        credential_ref: None,
        approved_by: Some("test".into()),
        revoked_at: None,
        notes: None,
        created_at: "2026-06-22T00:00:00Z".into(),
    };
    connectors::upsert_grant(pool, &grant).await.unwrap();
    "echo:1.0.0".to_string()
}

fn test_manager() -> ConnectorRuntimeManager {
    ConnectorRuntimeManager::new_with(Duration::from_millis(80), Duration::from_millis(800))
}

/// An event recorder: returns the shared event list + an `EventSink` that
/// appends into it.
fn recorder() -> (Arc<StdMutex<Vec<ConnectorRuntimeEvent>>>, EventSink) {
    let events: Arc<StdMutex<Vec<ConnectorRuntimeEvent>>> = Arc::new(StdMutex::new(Vec::new()));
    let events_for_sink = events.clone();
    let sink: EventSink = Arc::new(move |ev| {
        events_for_sink.lock().unwrap().push(ev);
    });
    (events, sink)
}

/// Block until a `ConsentRequested` event for `tool_call_id` shows up, then
/// return true. Async + `tokio::time::sleep` so the spawned execution task can
/// make progress on the same single-threaded test runtime.
async fn wait_for_consent(
    events: &Arc<StdMutex<Vec<ConnectorRuntimeEvent>>>,
    tool_call_id: &str,
    deadline: Duration,
) -> bool {
    let end = std::time::Instant::now() + deadline;
    loop {
        let found = events
            .lock()
            .unwrap()
            .iter()
            .any(|ev| matches!(ev, ConnectorRuntimeEvent::ConsentRequested { prompt } if prompt.tool_call_id == tool_call_id));
        if found {
            return true;
        }
        if std::time::Instant::now() >= end {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Count `ToolCallFinished` events matching a status.
fn finished_count(
    events: &Arc<StdMutex<Vec<ConnectorRuntimeEvent>>>,
    status: ToolCallStatus,
) -> usize {
    events
        .lock()
        .unwrap()
        .iter()
        .filter(|ev| {
            matches!(
                ev,
                ConnectorRuntimeEvent::ToolCallFinished { status: s, .. } if *s == status
            )
        })
        .count()
}

async fn setup() -> (SqlitePool, AppState, ConnectorRuntimeManager, String) {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_connector(&pool, None).await;
    mgr.start_connector(&state, &vid).await.unwrap();
    (pool, state, mgr, vid)
}

#[tokio::test]
async fn auto_tool_runs_and_persists() {
    let (pool, state, mgr, vid) = setup().await;
    let (events, sink) = recorder();
    let tcid = Uuid::new_v4().to_string();

    let outcome = execute_tool_call(
        &state,
        &mgr,
        &vid,
        &tcid,
        "req-1",
        "echo",
        &json!({ "text": "hi there" }),
        &sink,
    )
    .await
    .expect("auto tool completes");

    assert_eq!(outcome.record.status, ToolCallStatus::Completed);
    assert_eq!(outcome.output.unwrap().text_summary(), "hi there");
    assert_eq!(finished_count(&events, ToolCallStatus::Completed), 1);

    // Persisted record is Completed with the redacted result.
    let rec = tool_calls::get_tool_call(&pool, &state.encryption, &tcid)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rec.status, ToolCallStatus::Completed);
    assert!(rec.completed_at.is_some());

    // A tool_results row exists with the (redacted) content.
    let (result, is_error) = tool_calls::latest_tool_result(&pool, &state.encryption, &tcid)
        .await
        .unwrap()
        .unwrap();
    assert!(!is_error);
    assert!(result.to_string().contains("hi there"));
}

#[tokio::test]
async fn side_effectful_tool_blocks_then_approves() {
    let (pool, state, mgr, vid) = setup().await;
    let (events, sink) = recorder();
    let tcid = Uuid::new_v4().to_string();
    let mgr_clone = std::sync::Arc::new(mgr);
    let mgr_for_task = mgr_clone.clone();

    // Run execution in a task; it blocks on consent until we resolve it.
    let state_arc = std::sync::Arc::new(state);
    let state_for_task = state_arc.clone();
    let sink_for_task = sink.clone();
    let vid_for_task = vid.clone();
    let tcid_for_task = tcid.clone();
    let task = tokio::spawn(async move {
        execute_tool_call(
            &state_for_task,
            &mgr_for_task,
            &vid_for_task,
            &tcid_for_task,
            "req-2",
            "post_message",
            &json!({ "channel": "general", "text": "hello" }),
            &sink_for_task,
        )
        .await
    });

    // Wait for the consent prompt, then approve.
    assert!(
        wait_for_consent(&events, &tcid, Duration::from_secs(5)).await,
        "consent prompt should be emitted"
    );
    mgr_clone
        .resolve_consent(&tcid, provider_core::schema::ConsentDecision::Approved)
        .unwrap();

    let outcome = task.await.expect("task join").expect("approved completes");
    assert_eq!(outcome.record.status, ToolCallStatus::Completed);
    assert_eq!(finished_count(&events, ToolCallStatus::Completed), 1);

    // Approval stamped the tool_calls row.
    let rec = tool_calls::get_tool_call(&pool, &state_arc.encryption, &tcid)
        .await
        .unwrap()
        .unwrap();
    assert!(rec.approved_at.is_some());

    // A result row exists (the call was invoked after approval).
    let (result, _) = tool_calls::latest_tool_result(&pool, &state_arc.encryption, &tcid)
        .await
        .unwrap()
        .unwrap();
    assert!(result.to_string().contains("posted to general"));
}

#[tokio::test]
async fn denial_records_cancelled_and_does_not_invoke() {
    let (pool, state, mgr, vid) = setup().await;
    let (events, sink) = recorder();
    let tcid = Uuid::new_v4().to_string();
    let mgr_arc = std::sync::Arc::new(mgr);
    let state_arc = std::sync::Arc::new(state);
    let sink_for_task = sink.clone();
    let vid_for_task = vid.clone();
    let tcid_for_task = tcid.clone();
    let state_for_task = state_arc.clone();
    let mgr_for_task = mgr_arc.clone();
    let task = tokio::spawn(async move {
        execute_tool_call(
            &state_for_task,
            &mgr_for_task,
            &vid_for_task,
            &tcid_for_task,
            "req-3",
            "post_message",
            &json!({ "channel": "general", "text": "hello" }),
            &sink_for_task,
        )
        .await
    });

    assert!(wait_for_consent(&events, &tcid, Duration::from_secs(5)).await);
    mgr_arc
        .resolve_consent(&tcid, provider_core::schema::ConsentDecision::Denied)
        .unwrap();

    let outcome = task.await.expect("task join").expect("denial returns Cancelled outcome");
    assert_eq!(outcome.record.status, ToolCallStatus::Cancelled);
    assert_eq!(finished_count(&events, ToolCallStatus::Cancelled), 1);

    // No tool_results row — the tool was never invoked.
    let none = tool_calls::latest_tool_result(&pool, &state_arc.encryption, &tcid)
        .await
        .unwrap();
    assert!(none.is_none());

    let rec = tool_calls::get_tool_call(&pool, &state_arc.encryption, &tcid)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rec.status, ToolCallStatus::Cancelled);
    assert_eq!(rec.error.as_deref(), Some("user denied consent"));
}

#[tokio::test]
async fn oversized_output_fails() {
    let (pool, state, mgr, vid) = setup().await;
    let (events, sink) = recorder();
    let tcid = Uuid::new_v4().to_string();

    let res = execute_tool_call(
        &state,
        &mgr,
        &vid,
        &tcid,
        "req-4",
        "big",
        &json!({}),
        &sink,
    )
    .await;

    // `big` is readOnly → auto-invoked; output exceeds the cap → failed.
    assert!(res.is_err(), "oversized output should fail");
    let err = res.unwrap_err();
    assert!(err.contains("exceeded"), "got {err}");
    assert!(MAX_OUTPUT_BYTES < 2_000_000);

    assert_eq!(finished_count(&events, ToolCallStatus::Failed), 1);
    let rec = tool_calls::get_tool_call(&pool, &state.encryption, &tcid)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(rec.status, ToolCallStatus::Failed);
    assert!(rec.error.as_deref().unwrap().contains("exceeded"));
    // No result row for an oversized output.
    assert!(tool_calls::latest_tool_result(&pool, &state.encryption, &tcid)
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn redaction_strips_secret_in_persisted_result() {
    let (pool, state, mgr, vid) = setup().await;
    let (_events, sink) = recorder();
    let tcid = Uuid::new_v4().to_string();

    execute_tool_call(
        &state,
        &mgr,
        &vid,
        &tcid,
        "req-5",
        "secret_leak",
        &json!({}),
        &sink,
    )
    .await
    .expect("secret_leak completes");

    let (result, _) = tool_calls::latest_tool_result(&pool, &state.encryption, &tcid)
        .await
        .unwrap()
        .unwrap();
    let stored = result.to_string();
    assert!(stored.contains("[redacted]"), "got {stored}");
    assert!(!stored.contains("supersecret"), "secret leaked into storage: {stored}");
}

#[tokio::test]
async fn unknown_tool_is_refused_before_invoke() {
    let (_pool, state, mgr, vid) = setup().await;
    let (_events, sink) = recorder();
    let tcid = Uuid::new_v4().to_string();

    let res = execute_tool_call(
        &state,
        &mgr,
        &vid,
        &tcid,
        "req-6",
        "does_not_exist",
        &json!({}),
        &sink,
    )
    .await;
    assert!(res.is_err());
    assert!(res.unwrap_err().contains("not available"));
}

/// §6 no-reinjection invariant: tool output is persisted in `tool_results`
/// only, and never written into `message_parts` (which is what a follow-up
/// `ProviderRequest` is built from). Seed a user message, run a tool whose
/// output carries a unique marker, then assert the marker is in
/// `tool_results` but absent from `message_parts`.
#[tokio::test]
async fn tool_output_not_reinjected_into_messages() {
    let (pool, state, mgr, vid) = setup().await;
    let (_events, sink) = recorder();

    // Seed a conversation + one user message.
    let conv = conversations::create(&pool, None).await.unwrap();
    let msg_id = Uuid::new_v4().to_string();
    let part_id = Uuid::new_v4().to_string();
    let user_msg = Message {
        id: msg_id.clone(),
        conversation_id: conv.id,
        role: MessageRole::User,
        author_label: None,
        provider_message_id: None,
        interrupted_at: None,
        metadata: None,
        parts: vec![MessagePart {
            id: part_id,
            message_id: msg_id,
            index: 0,
            kind: MessagePartKind::Text,
            content: Some("please echo the result".into()),
            mime_type: None,
            tool_call_id: None,
            artifact_id: None,
            attachment_id: None,
            blob_ref: None,
            metadata: None,
            created_at: now_iso8601(),
        }],
        created_at: now_iso8601(),
    };
    messages::insert_message(&pool, &user_msg).await.unwrap();

    // Execute a tool whose output carries a unique marker.
    let marker = "MARKER_RESULT_9f3a";
    let tcid = Uuid::new_v4().to_string();
    execute_tool_call(
        &state,
        &mgr,
        &vid,
        &tcid,
        "req-7",
        "echo",
        &json!({ "text": marker }),
        &sink,
    )
    .await
    .expect("echo completes");

    // The marker is in tool_results.
    let (result, _) = tool_calls::latest_tool_result(&pool, &state.encryption, &tcid)
        .await
        .unwrap()
        .unwrap();
    assert!(result.to_string().contains(marker));

    // The marker never reached message_parts (the source for ProviderRequest
    // message construction). Execution writes only to tool_calls/tool_results.
    let leaked: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_parts WHERE content LIKE ?")
        .bind(format!("%{marker}%"))
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(leaked.0, 0, "tool output marker leaked into message_parts");
}