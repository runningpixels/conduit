//! Phase 4 M4.2: connector runtime supervisor — start/stop, restart-on-crash
//! with a bounded backoff, per-call timeout, cancellation, and grant/support
//! reconciliation. The stdio transport itself is exercised in the `mcp-runtime`
//! crate's `stdio_fixture` test; here we drive the full supervisor against the
//! shared `echo_connector` fixture binary.

mod common;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use conduit_desktop::connector_runtime::{ConnectorRuntimeManager, RESTART_MAX};
use conduit_desktop::db::repository::connectors::{
    self, ConnectorDefinition, ConnectorGrant, ConnectorVersion,
};
use conduit_desktop::paths::AppPaths;
use conduit_desktop::state::AppState;
use mcp_runtime::ErrorCategory;
use serde_json::json;
use tokio_util::sync::CancellationToken;

/// Locate (building once if needed) the `echo_connector` fixture binary from
/// the `mcp-runtime` workspace member.
fn echo_bin() -> &'static Path {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        // apps/desktop/src-tauri -> ../../../target
        let workspace_root = manifest.join("../../..");
        let target = workspace_root.join("target");
        let exe = target
            .join("debug")
            .join(format!("echo_connector{}", std::env::consts::EXE_SUFFIX));
        // Always (re)build so source changes to the fixture are picked up.
        // `cargo build` is a fast no-op when the bin is up to date, and the
        // `OnceLock` ensures only one build runs across parallel tests.
        let status = std::process::Command::new("cargo")
            .args(["build", "--bin", "echo_connector", "-p", "mcp-runtime"])
            .current_dir(&workspace_root)
            .status()
            .expect("failed to invoke cargo to build echo_connector");
        assert!(status.success(), "cargo build echo_connector failed");
        assert!(
            exe.exists(),
            "echo_connector not found at {exe:?} after build"
        );
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
        exports: root.join("exports"),
        branding: root.join("branding"),
    }
}

/// Seed a connector definition + version (stdio → echo_connector) + an active
/// grant, returning the version id. `support_state` and `grant_status` let
/// callers exercise the reconciliation rejections.
async fn seed_connector(
    pool: &conduit_desktop::db::DbPool,
    support_state: Option<&str>,
    grant_status: &str,
) -> String {
    seed_connector_with(pool, support_state, grant_status, None, None).await
}

async fn seed_connector_with(
    pool: &conduit_desktop::db::DbPool,
    support_state: Option<&str>,
    grant_status: &str,
    allowlist: Option<&[&str]>,
    env: Option<serde_json::Value>,
) -> String {
    let def = ConnectorDefinition {
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
    let capability_allowlist =
        allowlist.map(|names| serde_json::Value::Array(names.iter().map(|n| json!(n)).collect()));
    let transport_env = env.unwrap_or_else(|| json!({}));
    let version = ConnectorVersion {
        id: "echo:1.0.0".into(),
        connector_id: "echo".into(),
        version: "1.0.0".into(),
        transport_config: json!({ "command": bin, "args": [], "env": transport_env }),
        scope_grants: None,
        capability_allowlist,
        rollout_channel: None,
        support_state: support_state.map(|s| s.to_string()),
        created_at: "2026-06-22T00:00:00Z".into(),
    };
    connectors::insert_version(pool, &version).await.unwrap();

    let grant = ConnectorGrant {
        id: "g-echo".into(),
        connector_version_id: "echo:1.0.0".into(),
        scope: "user".into(),
        status: grant_status.into(),
        credential_ref: None,
        approved_by: Some("test".into()),
        revoked_at: None,
        notes: None,
        created_at: "2026-06-22T00:00:00Z".into(),
    };
    connectors::upsert_grant(pool, &grant).await.unwrap();

    "echo:1.0.0".to_string()
}

async fn runtime_state(
    pool: &conduit_desktop::db::DbPool,
    vid: &str,
) -> Option<connectors::ConnectorRuntimeState> {
    connectors::get_runtime_state(pool, vid).await.unwrap()
}

async fn wait_for_restart_count(
    pool: &conduit_desktop::db::DbPool,
    vid: &str,
    min: i64,
    deadline: Duration,
) -> bool {
    let end = Instant::now() + deadline;
    loop {
        if let Some(s) = runtime_state(pool, vid).await {
            if s.restart_count >= min {
                return true;
            }
        }
        if Instant::now() >= end {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

async fn wait_for_health(
    pool: &conduit_desktop::db::DbPool,
    vid: &str,
    health: &str,
    deadline: Duration,
) -> bool {
    let end = Instant::now() + deadline;
    loop {
        if let Some(s) = runtime_state(pool, vid).await {
            if s.health == health {
                return true;
            }
        }
        if Instant::now() >= end {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
}

/// Manager with tight supervision timings for fast tests.
fn test_manager() -> ConnectorRuntimeManager {
    ConnectorRuntimeManager::new_with(Duration::from_millis(80), Duration::from_millis(800))
}

#[tokio::test]
async fn start_connector_is_healthy_and_invokes() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_connector(&pool, None, "active").await;

    let server = mgr.start_connector(&state, &vid).await.expect("start");
    assert_eq!(server.name, "echo-connector");
    assert_eq!(runtime_state(&pool, &vid).await.unwrap().health, "healthy");

    let out = mgr
        .invoke_tool(
            &vid,
            "echo",
            &json!({ "text": "hi" }),
            &CancellationToken::new(),
        )
        .await
        .expect("echo");
    assert_eq!(out.text_summary(), "hi");

    mgr.stop_connector(&state, &vid).await.unwrap();
    assert_eq!(runtime_state(&pool, &vid).await.unwrap().health, "down");
}

#[tokio::test]
async fn crash_triggers_supervised_restart() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_connector(&pool, None, "active").await;

    mgr.start_connector(&state, &vid).await.unwrap();

    // `exit` makes the child respond then exit -> the supervisor restarts it.
    let out = mgr
        .invoke_tool(&vid, "exit", &json!({}), &CancellationToken::new())
        .await
        .expect("exit call");
    assert_eq!(out.text_summary(), "bye");

    assert!(
        wait_for_restart_count(&pool, &vid, 1, Duration::from_secs(3)).await,
        "supervisor should restart after crash"
    );
    // After restart the connector should be healthy again and callable.
    assert!(wait_for_health(&pool, &vid, "healthy", Duration::from_secs(2)).await);
    let out = mgr
        .invoke_tool(
            &vid,
            "echo",
            &json!({ "text": "after-restart" }),
            &CancellationToken::new(),
        )
        .await
        .expect("echo after restart");
    assert_eq!(out.text_summary(), "after-restart");

    mgr.stop_connector(&state, &vid).await.unwrap();
}

#[tokio::test]
async fn repeated_crashes_hit_cap_and_go_down() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_connector(&pool, None, "active").await;

    mgr.start_connector(&state, &vid).await.unwrap();

    // Crash more times than the restart cap. Each `exit` crashes; the supervisor
    // restarts until the cap, then marks the connector `down` and stops.
    for _ in 0..(RESTART_MAX + 1) {
        let _ = mgr
            .invoke_tool(&vid, "exit", &json!({}), &CancellationToken::new())
            .await;
        // give the supervisor a tick to react
        tokio::time::sleep(Duration::from_millis(120)).await;
    }

    assert!(
        wait_for_health(&pool, &vid, "down", Duration::from_secs(4)).await,
        "connector should be down after exceeding the restart cap"
    );
    let s = runtime_state(&pool, &vid).await.unwrap();
    assert!(
        s.restart_count >= RESTART_MAX as i64,
        "restart_count={}",
        s.restart_count
    );
    assert!(
        mgr.active_connector(&vid).is_none(),
        "restart-capped connector should be removed from the active registry"
    );
}

#[tokio::test]
async fn per_call_timeout_tears_down_and_reports() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager(); // 800ms call timeout; `slow` sleeps 60s
    let vid = seed_connector(&pool, None, "active").await;

    mgr.start_connector(&state, &vid).await.unwrap();
    let res = mgr
        .invoke_tool(&vid, "slow", &json!({}), &CancellationToken::new())
        .await;
    assert!(res.is_err());
    let err = res.unwrap_err();
    assert_eq!(err.category, ErrorCategory::Timeout, "got {err:?}");
}

#[tokio::test]
async fn cancel_mid_call_reports_cancelled() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_connector(&pool, None, "active").await;

    mgr.start_connector(&state, &vid).await.unwrap();

    let cancel = CancellationToken::new();
    let cancel_cancel = cancel.clone();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        cancel_cancel.cancel();
    });
    let res = mgr.invoke_tool(&vid, "slow", &json!({}), &cancel).await;
    canceller.await.unwrap();
    assert!(res.is_err());
    assert_eq!(res.unwrap_err().category, ErrorCategory::Cancelled);
}

#[tokio::test]
async fn start_rejected_for_revoked_grant() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_connector(&pool, None, "revoked").await;

    let err = mgr
        .start_connector(&state, &vid)
        .await
        .expect_err("must reject");
    assert!(err.contains("grant"));
}

#[tokio::test]
async fn start_rejected_for_admin_disabled() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_connector(&pool, Some("adminDisabled"), "active").await;

    let err = mgr
        .start_connector(&state, &vid)
        .await
        .expect_err("must reject");
    assert!(err.contains("admin-disabled") || err.contains("adminDisabled"));
}

#[tokio::test]
async fn discovery_caches_all_tools() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_connector(&pool, None, "active").await;

    mgr.start_connector(&state, &vid).await.unwrap();
    // start_connector already ran discovery; re-discover returns the cache set.
    let caps = mgr
        .discover_capabilities(&state, &vid)
        .await
        .expect("discover");
    let names: Vec<&str> = caps.iter().map(|c| c.name.as_str()).collect();
    assert!(names.contains(&"echo"));
    assert!(names.contains(&"post_message"));
    // The fixture exposes only tools (no resources/prompts).
    assert!(caps.iter().all(|c| c.kind == "tool"));
    // Re-discovery is a replace-batch (no orphans): same count on re-run.
    let again = mgr.discover_capabilities(&state, &vid).await.unwrap();
    assert_eq!(again.len(), caps.len());
    mgr.stop_connector(&state, &vid).await.unwrap();
}

#[tokio::test]
async fn discovery_filters_through_allowlist() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_connector_with(&pool, None, "active", Some(&["echo", "read_time"]), None).await;

    mgr.start_connector(&state, &vid).await.unwrap();
    let caps = mgr
        .discover_capabilities(&state, &vid)
        .await
        .expect("discover");
    let names: Vec<&str> = caps.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names.len(), 2);
    assert!(names.contains(&"echo"));
    assert!(names.contains(&"read_time"));
    assert!(!names.contains(&"post_message"));
    mgr.stop_connector(&state, &vid).await.unwrap();
}

#[tokio::test]
async fn discovery_empty_result_clears_stale_cached_capabilities() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_connector_with(&pool, None, "active", Some(&["does_not_exist"]), None).await;

    connectors::upsert_capabilities(
        &pool,
        &vid,
        &[connectors::new_capability(
            &vid,
            "tool",
            "stale_tool",
            Some(json!({})),
        )],
    )
    .await
    .unwrap();

    mgr.start_connector(&state, &vid).await.unwrap();

    let cached = connectors::list_capabilities(&pool, &vid).await.unwrap();
    assert!(
        cached.is_empty(),
        "empty discovery should clear stale cached rows"
    );
}

#[tokio::test]
async fn initialize_timeout_marks_connector_down() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_connector_with(
        &pool,
        None,
        "active",
        None,
        Some(json!({ "ECHO_CONNECTOR_INITIALIZE_DELAY_MS": "2000" })),
    )
    .await;

    let err = mgr
        .start_connector(&state, &vid)
        .await
        .expect_err("initialize should time out");
    assert!(err.contains("initialize exceeded"), "got {err}");
    assert_eq!(runtime_state(&pool, &vid).await.unwrap().health, "down");
}

#[tokio::test]
async fn discovery_timeout_is_reported() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_connector_with(
        &pool,
        None,
        "active",
        None,
        Some(json!({ "ECHO_CONNECTOR_LIST_TOOLS_DELAY_MS": "2000" })),
    )
    .await;

    mgr.start_connector(&state, &vid).await.unwrap();
    let err = mgr
        .discover_capabilities(&state, &vid)
        .await
        .expect_err("manual discovery should time out");
    assert!(err.contains("discovery exceeded"), "got {err}");
}

#[tokio::test]
async fn consent_classification_timeout_is_reported() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_connector_with(
        &pool,
        None,
        "active",
        None,
        Some(json!({ "ECHO_CONNECTOR_LIST_TOOLS_DELAY_MS": "2000" })),
    )
    .await;

    mgr.start_connector(&state, &vid).await.unwrap();
    let err = match mgr
        .request_consent(
            &state,
            &vid,
            "tc-timeout",
            "post_message",
            &json!({ "channel": "general", "text": "hello" }),
            None,
        )
        .await
    {
        Ok(_) => panic!("consent classification should time out"),
        Err(err) => err,
    };
    assert!(err.contains("consent classification"), "got {err}");
}
