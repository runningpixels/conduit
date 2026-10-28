//! Shared test helpers for Phase 3 integration tests.
//!
//! `tests/common` is a module (not a test target): each integration test does
//! `mod common;` to pull it in. Not every test uses every helper, so dead-code
//! is allowed at the module level to keep the per-test warning surface clean.
#![allow(dead_code)]

use conduit_desktop::{db, encryption::Encryption};
use sqlx::sqlite::SqlitePoolOptions;
use sqlx::SqlitePool;

/// An in-memory SQLite pool with the Phase 3 schema migrated and ready.
pub async fn setup_pool() -> SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("connect in-memory");
    db::run_migrations(&pool)
        .await
        .expect("migrations apply cleanly");
    pool
}

/// Seed one connector named `name` (id `id`, version `<id>:1`) with an active
/// grant and the given `(tool, description)` capabilities, as discovery stores
/// them: the MCP description rides in the schema's `description`. No process
/// is configured, so its tools are cataloged but cannot actually run.
pub async fn seed_connector_tools(pool: &SqlitePool, id: &str, name: &str, tools: &[(&str, &str)]) {
    use conduit_desktop::db::repository::connectors;
    let now = "2026-10-27T00:00:00Z".to_string();
    connectors::upsert_definition(
        pool,
        &connectors::ConnectorDefinition {
            id: id.into(),
            name: name.into(),
            description: format!("{name} fixture"),
            transport: "stdio".into(),
            owner: "test".into(),
            icon: None,
            support_url: None,
            consent_copy: None,
            policy_metadata: None,
            cloud_id: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        },
    )
    .await
    .unwrap();
    let version_id = format!("{id}:1");
    connectors::insert_version(
        pool,
        &connectors::ConnectorVersion {
            id: version_id.clone(),
            connector_id: id.into(),
            version: "1".into(),
            transport_config: serde_json::json!({ "command": "missing-binary", "args": [], "env": {} }),
            scope_grants: None,
            capability_allowlist: None,
            rollout_channel: None,
            support_state: None,
            created_at: now.clone(),
        },
    )
    .await
    .unwrap();
    connectors::upsert_grant(
        pool,
        &connectors::ConnectorGrant {
            id: format!("g-{id}"),
            connector_version_id: version_id.clone(),
            scope: "user".into(),
            status: "active".into(),
            credential_ref: None,
            approved_by: Some("test".into()),
            revoked_at: None,
            notes: None,
            created_at: now,
        },
    )
    .await
    .unwrap();
    let caps: Vec<_> = tools
        .iter()
        .map(|(tool, about)| {
            connectors::new_capability(
                &version_id,
                "tool",
                tool,
                Some(serde_json::json!({
                    "type": "object",
                    "description": about,
                    "properties": {}
                })),
            )
        })
        .collect();
    connectors::upsert_capabilities(pool, &version_id, &caps)
        .await
        .unwrap();
}

/// A tier-`Off` `Encryption` (identity / plaintext passthrough) for tests that
/// exercise repos which now take `&Encryption` but don't care about encryption.
pub fn setup_encryption() -> Encryption {
    Encryption::off()
}
