//! M1: the full schema lands and `schema_migrations` is populated.
use conduit_desktop::db;
use sqlx::sqlite::SqlitePoolOptions;

const EXPECTED_TABLES: &[&str] = &[
    "schema_migrations",
    "conversations",
    "messages",
    "message_parts",
    "provider_event_log",
    "tool_calls",
    "tool_results",
    "artifacts",
    "artifact_versions",
    "attachments",
    "connector_definitions",
    "connector_versions",
    "connector_grants",
    "connector_runtime_state",
    "connector_capabilities",
    "provider_accounts",
    "settings",
    "tenant_config_cache",
    "licenses",
    "license_key_sets",
    "sync_state",
];

#[tokio::test]
async fn all_tables_created_by_initial_migration() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .expect("connect in-memory");

    db::run_migrations(&pool)
        .await
        .expect("migrations apply cleanly");

    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .fetch_all(&pool)
            .await
            .expect("read tables");
    let names: Vec<String> = rows.into_iter().map(|r| r.0).collect();

    for expected in EXPECTED_TABLES {
        assert!(
            names.contains(&(*expected).to_string()),
            "missing table: {expected} (had: {:?})",
            names
        );
    }

    // The public audit table mirrors the runner's internal table. The count is
    // the number of shipped migrations (0001 initial schema + 0004 encryption
    // key version; 0002/0003 reserved).
    let (public,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM schema_migrations")
        .fetch_one(&pool)
        .await
        .unwrap();
    let (internal,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM _sqlx_migrations WHERE success = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(public, internal, "schema_migrations out of sync");
    assert_eq!(public, 2, "expected both shipped migrations applied");
}

#[tokio::test]
async fn reconcile_on_startup_passes_on_fresh_db() {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    db::run_migrations(&pool).await.unwrap();
    db::migrations::reconcile_on_startup(&pool)
        .await
        .expect("fresh DB passes integrity check");
}