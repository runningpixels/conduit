mod common;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use conduit_desktop::commands::revoke_connector_grant_inner;
use conduit_desktop::connector_runtime::ConnectorRuntimeManager;
use conduit_desktop::db::repository::connectors::{self, ConnectorDefinition, ConnectorGrant, ConnectorVersion};
use conduit_desktop::paths::AppPaths;
use conduit_desktop::state::AppState;
use serde_json::json;

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
        exports: root.join("exports"),
    }
}

async fn seed_connector(pool: &conduit_desktop::db::DbPool) -> String {
    let def = ConnectorDefinition {
        id: "echo".into(),
        name: "Echo".into(),
        description: "echo fixture".into(),
        transport: "stdio".into(),
        owner: "test".into(),
        icon: None,
        support_url: None,
        consent_copy: None,
        policy_metadata: None,
        cloud_id: None,
        created_at: "2026-06-22T00:00:00Z".into(),
        updated_at: "2026-06-22T00:00:00Z".into(),
    };
    connectors::upsert_definition(pool, &def).await.unwrap();

    let version = ConnectorVersion {
        id: "echo:1.0.0".into(),
        connector_id: "echo".into(),
        version: "1.0.0".into(),
        transport_config: json!({ "command": echo_bin().to_string_lossy().to_string(), "args": [], "env": {} }),
        scope_grants: None,
        capability_allowlist: None,
        rollout_channel: None,
        support_state: None,
        created_at: "2026-06-22T00:00:00Z".into(),
    };
    connectors::insert_version(pool, &version).await.unwrap();

    let grant = ConnectorGrant {
        id: "grant-echo".into(),
        connector_version_id: version.id.clone(),
        scope: "user".into(),
        status: "active".into(),
        credential_ref: None,
        approved_by: Some("test".into()),
        revoked_at: None,
        notes: None,
        created_at: "2026-06-22T00:00:00Z".into(),
    };
    connectors::upsert_grant(pool, &grant).await.unwrap();
    version.id
}

#[tokio::test]
async fn revoke_command_resolves_version_from_grant_and_stops_connector() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let state = AppState::test_instance(pool.clone(), test_paths(dir.path()));
    let runtime = ConnectorRuntimeManager::new_with(
        std::time::Duration::from_millis(80),
        std::time::Duration::from_millis(800),
    );
    let version_id = seed_connector(&pool).await;

    runtime.start_connector(&state, &version_id).await.unwrap();
    assert!(runtime.active_connector(&version_id).is_some());

    revoke_connector_grant_inner(&state, &runtime, "grant-echo")
        .await
        .expect("revoke succeeds");

    assert!(runtime.active_connector(&version_id).is_none());
    let grants = connectors::list_grants(&pool, Some("revoked")).await.unwrap();
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0].id, "grant-echo");
    let runtime_state = connectors::get_runtime_state(&pool, &version_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(runtime_state.health, "down");
}
