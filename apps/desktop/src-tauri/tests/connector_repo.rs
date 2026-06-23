//! M5: connector definition upsert, version immutability, grant revoke,
//! runtime state, capability replace-batch.

mod common;

use conduit_desktop::db::repository::connectors::{
    self, ConnectorCapability, ConnectorDefinition, ConnectorGrant, ConnectorRuntimeState,
    ConnectorVersion,
};
use serde_json::json;

fn def(id: &str) -> ConnectorDefinition {
    ConnectorDefinition {
        id: id.into(),
        name: format!("Connector {id}"),
        description: "desc".into(),
        transport: "stdio".into(),
        owner: "owner".into(),
        icon: None,
        support_url: None,
        consent_copy: None,
        policy_metadata: Some(json!({"p": 1})),
        cloud_id: None,
        created_at: "2026-06-22T00:00:00Z".into(),
        updated_at: "2026-06-22T00:00:00Z".into(),
    }
}

fn version(connector_id: &str, ver: &str) -> ConnectorVersion {
    ConnectorVersion {
        id: format!("{connector_id}:{ver}"),
        connector_id: connector_id.into(),
        version: ver.into(),
        transport_config: json!({"cmd": "run"}),
        scope_grants: None,
        capability_allowlist: None,
        rollout_channel: None,
        support_state: None,
        created_at: "2026-06-22T00:00:00Z".into(),
    }
}

#[tokio::test]
async fn definition_upsert_preserves_created_at() {
    let pool = common::setup_pool().await;
    connectors::upsert_definition(&pool, &def("c1")).await.unwrap();

    // Update with a new updated_at + name.
    let mut updated = def("c1");
    updated.name = "Renamed".into();
    updated.updated_at = "2026-06-23T00:00:00Z".into();
    connectors::upsert_definition(&pool, &updated).await.unwrap();

    let fetched = connectors::get(&pool, "c1").await.unwrap().unwrap();
    assert_eq!(fetched.name, "Renamed");
    assert_eq!(fetched.created_at, "2026-06-22T00:00:00Z", "created_at preserved");
    assert_eq!(fetched.updated_at, "2026-06-23T00:00:00Z");
    assert_eq!(connectors::list_definitions(&pool).await.unwrap().len(), 1);
}

#[tokio::test]
async fn versions_are_immutable() {
    let pool = common::setup_pool().await;
    connectors::upsert_definition(&pool, &def("c1")).await.unwrap();
    connectors::insert_version(&pool, &version("c1", "1.0.0"))
        .await
        .unwrap();

    // Re-inserting the same version id is rejected (immutable history).
    let dup = connectors::insert_version(&pool, &version("c1", "1.0.0")).await;
    assert!(dup.is_err());

    // A second distinct version appends.
    connectors::insert_version(&pool, &version("c1", "1.1.0"))
        .await
        .unwrap();
    let versions = connectors::list_versions(&pool, "c1").await.unwrap();
    assert_eq!(versions.len(), 2);
}

#[tokio::test]
async fn grant_revoke_and_runtime_state() {
    let pool = common::setup_pool().await;
    connectors::upsert_definition(&pool, &def("c1")).await.unwrap();
    connectors::insert_version(&pool, &version("c1", "1.0.0"))
        .await
        .unwrap();

    let grant = ConnectorGrant {
        id: "g1".into(),
        connector_version_id: "c1:1.0.0".into(),
        scope: "read".into(),
        status: "approved".into(),
        credential_ref: Some("keychain://c1".into()),
        approved_by: Some("alice".to_string()),
        revoked_at: None,
        notes: None,
        created_at: "2026-06-22T00:00:00Z".into(),
    };
    connectors::upsert_grant(&pool, &grant).await.unwrap();

    let active = connectors::list_grants(&pool, Some("approved"))
        .await
        .unwrap();
    assert_eq!(active.len(), 1);

    connectors::revoke_grant(&pool, "g1", Some("2026-06-24T00:00:00Z"))
        .await
        .unwrap();
    assert_eq!(
        connectors::list_grants(&pool, Some("approved"))
            .await
            .unwrap()
            .len(),
        0
    );
    let revoked = connectors::list_grants(&pool, Some("revoked"))
        .await
        .unwrap();
    assert_eq!(revoked.len(), 1);
    assert_eq!(revoked[0].revoked_at.as_deref(), Some("2026-06-24T00:00:00Z"));

    // Runtime state upserts.
    let state = ConnectorRuntimeState {
        connector_version_id: "c1:1.0.0".into(),
        health: "healthy".into(),
        last_started_at: Some("2026-06-22T00:00:00Z".into()),
        last_error: None,
        restart_count: 0,
    };
    connectors::upsert_runtime_state(&pool, &state).await.unwrap();
    let mut state2 = state.clone();
    state2.health = "degraded".into();
    state2.restart_count = 3;
    connectors::upsert_runtime_state(&pool, &state2).await.unwrap();
    let got = connectors::get_runtime_state(&pool, "c1:1.0.0")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got.health, "degraded");
    assert_eq!(got.restart_count, 3);
}

#[tokio::test]
async fn capabilities_replace_batch() {
    let pool = common::setup_pool().await;
    connectors::upsert_definition(&pool, &def("c1")).await.unwrap();
    connectors::insert_version(&pool, &version("c1", "1.0.0"))
        .await
        .unwrap();

    let caps1 = vec![
        connectors::new_capability("c1:1.0.0", "tool", "search", Some(json!({}))),
        connectors::new_capability("c1:1.0.0", "resource", "docs", None),
    ];
    connectors::upsert_capabilities(&pool, "c1:1.0.0", &caps1).await.unwrap();

    // A second discovery replaces the first batch entirely (no orphans).
    let caps2 = vec![connectors::new_capability(
        "c1:1.0.0",
        "tool",
        "search",
        Some(json!({"v": 2})),
    )];
    connectors::upsert_capabilities(&pool, "c1:1.0.0", &caps2).await.unwrap();

    let rows: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM connector_capabilities WHERE connector_version_id = ?",
    )
    .bind("c1:1.0.0")
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(rows.0, 1, "replace-batch leaves no orphan capabilities");

    // Keep a use of ConnectorCapability's fields alive (schema_json round-trip).
    let _: Option<ConnectorCapability> = None;
}