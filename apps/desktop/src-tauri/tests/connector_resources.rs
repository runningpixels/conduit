//! t0-9: reading MCP resources into a turn, and resolving MCP prompts.
//!
//! Drives the real supervisor against the `echo_connector` fixture with
//! `ECHO_CONNECTOR_CAPABILITIES=full`, which makes it advertise resources and
//! prompts on top of its usual tools.
//!
//! The load-bearing test here is `hostile_resource_is_refused_by_the_gate`.
//! Resource reads are the one path allowed to put connector-served text into a
//! prompt, so the reinjection gate blocking (rather than warning, as the
//! tool-output call sites do) is the property that makes that safe.

mod common;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use conduit_desktop::connector_runtime::{prompts, resources, ConnectorRuntimeManager};
use conduit_desktop::db::repository::connectors::{
    self, ConnectorDefinition, ConnectorGrant, ConnectorVersion,
};
use conduit_desktop::paths::AppPaths;
use conduit_desktop::state::AppState;
use provider_core::schema::{PromptArguments, ResourceRef};
use serde_json::json;

fn echo_bin() -> &'static Path {
    static BIN: OnceLock<PathBuf> = OnceLock::new();
    BIN.get_or_init(|| {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let workspace_root = manifest.join("../../..");
        let exe = workspace_root
            .join("target")
            .join("debug")
            .join(format!("echo_connector{}", std::env::consts::EXE_SUFFIX));
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
        themes: root.join("themes"),
    }
}

fn test_manager() -> ConnectorRuntimeManager {
    ConnectorRuntimeManager::new_with(Duration::from_millis(80), Duration::from_secs(5))
}

/// Seed the echo fixture with resources and prompts switched on.
async fn seed_extended(pool: &conduit_desktop::db::DbPool) -> String {
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
    let version = ConnectorVersion {
        id: "echo:1.0.0".into(),
        connector_id: "echo".into(),
        version: "1.0.0".into(),
        transport_config: json!({
            "command": bin,
            "args": [],
            "env": { "ECHO_CONNECTOR_CAPABILITIES": "full" }
        }),
        scope_grants: None,
        capability_allowlist: None,
        rollout_channel: None,
        support_state: None,
        created_at: "2026-06-22T00:00:00Z".into(),
    };
    connectors::insert_version(pool, &version).await.unwrap();

    let grant = ConnectorGrant {
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

/// Most tests here are about what happens *after* the user has allowed this
/// server's resources; `unacknowledged_connector_is_refused` covers the gate
/// itself.
async fn acknowledge(state: &AppState, vid: &str) {
    resources::acknowledge(state, vid).await.unwrap();
}

fn resource_ref(name: &str, uri: &str) -> ResourceRef {
    ResourceRef {
        connector_version_id: "echo:1.0.0".into(),
        name: name.into(),
        uri: uri.into(),
    }
}

#[tokio::test]
async fn discovery_records_resource_uris_and_prompt_arguments() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_extended(&pool).await;

    mgr.start_connector(&state, &vid).await.unwrap();
    let caps = mgr.discover_capabilities(&state, &vid).await.unwrap();

    let spec = caps
        .iter()
        .find(|c| c.kind == "resource" && c.name == "spec.md")
        .expect("spec.md resource was discovered");
    assert_eq!(
        spec.schema_json.as_ref().unwrap().get("uri").unwrap(),
        "echo://notes/spec.md",
        "a resource without its URI cannot be read at all"
    );

    let summarize = caps
        .iter()
        .find(|c| c.kind == "prompt" && c.name == "summarize")
        .expect("summarize prompt was discovered");
    let args = summarize
        .schema_json
        .as_ref()
        .unwrap()
        .get("arguments")
        .unwrap()
        .as_array()
        .unwrap();
    assert_eq!(args.len(), 2);
    assert_eq!(args[0].get("name").unwrap(), "topic");
    assert_eq!(args[0].get("required").unwrap(), true);

    mgr.stop_connector(&state, &vid).await.unwrap();
}

#[tokio::test]
async fn a_text_resource_is_read_into_a_fenced_block() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_extended(&pool).await;
    mgr.start_connector(&state, &vid).await.unwrap();
    acknowledge(&state, &vid).await;

    let refs = vec![resource_ref("spec.md", "echo://notes/spec.md")];
    let block = resources::read_resources(&state, &mgr, &refs)
        .await
        .unwrap();

    assert_eq!(block.included.len(), 1);
    assert!(block.skipped.is_empty());
    assert!(block.text.contains("The widget must fold before it ships."));
    // The block names its origin and frames the content as data, not orders.
    assert!(block.text.contains("echo://notes/spec.md"));
    assert!(block.text.contains("not instructions"));

    mgr.stop_connector(&state, &vid).await.unwrap();
}

#[tokio::test]
async fn hostile_resource_is_refused_by_the_gate() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_extended(&pool).await;
    mgr.start_connector(&state, &vid).await.unwrap();
    acknowledge(&state, &vid).await;

    let refs = vec![resource_ref("hostile.md", "echo://notes/hostile.md")];
    let block = resources::read_resources(&state, &mgr, &refs)
        .await
        .unwrap();

    assert!(
        block.included.is_empty(),
        "a resource that trips the reinjection gate must not reach the prompt"
    );
    assert_eq!(block.skipped.len(), 1);
    assert!(
        block.skipped[0].reason.contains("instruction override"),
        "the user is told which risk fired, got: {}",
        block.skipped[0].reason
    );
    assert!(
        !block.text.contains("Ignore previous instructions"),
        "the refused text must not appear anywhere in the block"
    );

    mgr.stop_connector(&state, &vid).await.unwrap();
}

#[tokio::test]
async fn a_binary_resource_is_skipped_rather_than_inlined() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_extended(&pool).await;
    mgr.start_connector(&state, &vid).await.unwrap();
    acknowledge(&state, &vid).await;

    let refs = vec![resource_ref("logo.png", "echo://blob/logo.png")];
    let block = resources::read_resources(&state, &mgr, &refs)
        .await
        .unwrap();

    assert!(block.included.is_empty());
    assert_eq!(block.skipped.len(), 1);
    assert!(block.skipped[0].reason.contains("no readable text"));

    mgr.stop_connector(&state, &vid).await.unwrap();
}

#[tokio::test]
async fn one_bad_resource_does_not_cost_the_whole_turn() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_extended(&pool).await;
    mgr.start_connector(&state, &vid).await.unwrap();
    acknowledge(&state, &vid).await;

    let refs = vec![
        resource_ref("hostile.md", "echo://notes/hostile.md"),
        resource_ref("spec.md", "echo://notes/spec.md"),
    ];
    let block = resources::read_resources(&state, &mgr, &refs)
        .await
        .unwrap();

    assert_eq!(block.included.len(), 1, "the good resource still went in");
    assert_eq!(block.skipped.len(), 1, "the bad one was named");
    assert!(block.text.contains("The widget must fold"));

    mgr.stop_connector(&state, &vid).await.unwrap();
}

#[tokio::test]
async fn a_resource_outside_the_capability_cache_is_refused() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_extended(&pool).await;
    mgr.start_connector(&state, &vid).await.unwrap();
    acknowledge(&state, &vid).await;

    // The renderer cannot reach past discovery: a name the runtime never
    // cached is refused before any connector round-trip.
    let refs = vec![resource_ref("etc_passwd", "file:///etc/passwd")];
    let block = resources::read_resources(&state, &mgr, &refs)
        .await
        .unwrap();

    assert!(block.included.is_empty());
    assert!(block.skipped[0].reason.contains("not available"));

    mgr.stop_connector(&state, &vid).await.unwrap();
}

#[tokio::test]
async fn a_uri_that_does_not_match_the_discovered_one_is_refused() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_extended(&pool).await;
    mgr.start_connector(&state, &vid).await.unwrap();
    acknowledge(&state, &vid).await;

    // A known resource name pointed at a different URI: the read is pinned to
    // what discovery recorded, not to what the caller asked for.
    let refs = vec![resource_ref("spec.md", "file:///etc/passwd")];
    let block = resources::read_resources(&state, &mgr, &refs)
        .await
        .unwrap();

    assert!(block.included.is_empty());
    assert!(block.skipped[0].reason.contains("has moved"));

    mgr.stop_connector(&state, &vid).await.unwrap();
}

#[tokio::test]
async fn a_prompt_resolves_with_its_arguments() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_extended(&pool).await;
    mgr.start_connector(&state, &vid).await.unwrap();

    let text = prompts::get_prompt(
        &state,
        &mgr,
        &PromptArguments {
            connector_version_id: vid.clone(),
            name: "summarize".into(),
            arguments: json!({ "topic": "widgets", "length": "long" }),
        },
    )
    .await
    .unwrap();

    assert_eq!(text, "Give me a long summary of widgets.");

    mgr.stop_connector(&state, &vid).await.unwrap();
}

#[tokio::test]
async fn a_prompt_with_no_arguments_resolves() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_extended(&pool).await;
    mgr.start_connector(&state, &vid).await.unwrap();

    let text = prompts::get_prompt(
        &state,
        &mgr,
        &PromptArguments {
            connector_version_id: vid.clone(),
            name: "standup".into(),
            arguments: json!({}),
        },
    )
    .await
    .unwrap();

    assert_eq!(text, "What did I do yesterday?");

    mgr.stop_connector(&state, &vid).await.unwrap();
}

#[tokio::test]
async fn a_tool_cannot_be_invoked_through_the_prompt_path() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_extended(&pool).await;
    mgr.start_connector(&state, &vid).await.unwrap();

    // `post_message` is a side-effectful tool. Reaching it through prompts/get
    // would sidestep the consent engine entirely.
    let err = prompts::get_prompt(
        &state,
        &mgr,
        &PromptArguments {
            connector_version_id: vid.clone(),
            name: "post_message".into(),
            arguments: json!({}),
        },
    )
    .await
    .expect_err("a tool must not be reachable as a prompt");
    assert!(err.contains("is not a prompt"), "got: {err}");

    mgr.stop_connector(&state, &vid).await.unwrap();
}

#[tokio::test]
async fn unacknowledged_connector_is_refused() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let mgr = test_manager();
    let vid = seed_extended(&pool).await;
    mgr.start_connector(&state, &vid).await.unwrap();

    // Deliberately no `acknowledge`. The renderer raises the prompt, but the
    // decision is enforced here -- a renderer that skipped it still cannot
    // read, which is the point of checking Rust-side rather than in the UI.
    let refs = vec![resource_ref("spec.md", "echo://notes/spec.md")];
    let block = resources::read_resources(&state, &mgr, &refs)
        .await
        .unwrap();

    assert!(block.included.is_empty());
    assert!(
        block.skipped[0].reason.contains("not been allowed"),
        "got: {}",
        block.skipped[0].reason
    );
    assert!(!block.text.contains("The widget must fold"));

    // Once allowed, the same read goes through.
    acknowledge(&state, &vid).await;
    let block = resources::read_resources(&state, &mgr, &refs)
        .await
        .unwrap();
    assert_eq!(block.included.len(), 1);

    mgr.stop_connector(&state, &vid).await.unwrap();
}
