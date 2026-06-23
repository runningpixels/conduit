//! M1: the pool opens with the Phase 3 PRAGMAs (WAL, foreign_keys, busy_timeout).
use conduit_desktop::db;
use tempfile::tempdir;

#[tokio::test]
async fn init_pool_sets_pragmas() {
    let dir = tempdir().expect("tempdir");
    let db_path = dir.path().join("conduit.sqlite");

    let pool = db::init_pool(&db_path).await.expect("init_pool");

    let (journal_mode,): (String,) = sqlx::query_as("PRAGMA journal_mode")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(journal_mode.to_lowercase(), "wal");

    let (foreign_keys,): (i64,) = sqlx::query_as("PRAGMA foreign_keys")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(foreign_keys, 1);

    let (busy_timeout,): (i64,) = sqlx::query_as("PRAGMA busy_timeout")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(busy_timeout, 5000);

    // foreign_keys is a per-connection PRAGMA; assert it survives a fresh
    // acquire from the pool.
    drop(pool);
    let pool = db::init_pool(&db_path).await.expect("re-init");
    let (foreign_keys,): (i64,) = sqlx::query_as("PRAGMA foreign_keys")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(foreign_keys, 1, "foreign_keys must hold on every connection");
}