//! A migration file whose *checksum* moved but whose *schema* did not must not
//! cost the user their conversations.
//!
//! sqlx hashes the whole migration file, so editing a comment is indistinguishable
//! from rewriting an `ALTER TABLE`. Before `repair_checksum_drift`, both landed
//! in the same place: `open_with_migrations` backed the store up to
//! `conduit.sqlite.corrupt-<unix>.bak` and handed the user an empty database.
//! `0001_initial_schema.sql` has shipped three checksums for identical SQL, so
//! this was not a theoretical failure — it fired repeatedly.
//!
//! These tests drive the real entry point (`open_with_migrations`) against a
//! database with tampered checksums, and pin both halves of the contract: repair
//! when the schema still matches, back up when it does not.

use conduit_desktop::db::{self, migrations};
use sqlx::Row;
use tempfile::TempDir;

/// A migrated store holding one conversation, so "did we keep the data" has an
/// answer that does not depend on schema introspection.
async fn seeded_store() -> (TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let db_path = dir.path().join("conduit.sqlite");

    let (pool, recovery) = migrations::open_with_migrations(&db_path)
        .await
        .expect("open fresh store");
    assert!(recovery.is_none(), "a fresh store must not need recovery");

    sqlx::query(
        "INSERT INTO conversations (id, title, created_at, updated_at) \
         VALUES ('c1', 'survivor', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
    )
    .execute(&pool)
    .await
    .expect("seed conversation");
    pool.close().await;

    (dir, db_path)
}

/// Rewrite the recorded checksum for `version`, exactly as editing the file
/// would have from the runner's point of view.
async fn tamper_checksum(db_path: &std::path::Path, version: i64) {
    let pool = db::init_pool(db_path).await.expect("open for tampering");
    let affected = sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
        .bind(vec![0xdeu8; 48])
        .bind(version)
        .execute(&pool)
        .await
        .expect("tamper checksum")
        .rows_affected();
    assert_eq!(affected, 1, "expected to tamper exactly one row");
    pool.close().await;
}

async fn conversation_count(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query("SELECT COUNT(*) FROM conversations")
        .fetch_one(pool)
        .await
        .expect("count conversations")
        .get::<i64, _>(0)
}

fn backups_next_to(db_path: &std::path::Path) -> Vec<std::path::PathBuf> {
    conduit_desktop::local_data::backup_paths(db_path)
}

#[tokio::test]
async fn cosmetic_drift_keeps_the_users_data() {
    let (_guard, db_path) = seeded_store().await;
    tamper_checksum(&db_path, 1).await;

    let (pool, recovery) = migrations::open_with_migrations(&db_path)
        .await
        .expect("reopen after drift");

    assert!(
        recovery.is_none(),
        "the schema was unchanged, so this must not be treated as corruption"
    );
    assert_eq!(
        conversation_count(&pool).await,
        1,
        "the seeded conversation must survive a checksum-only change"
    );
    assert!(
        backups_next_to(&db_path).is_empty(),
        "no store should have been backed up and replaced"
    );

    // The repair re-stamps rather than suppressing: the next launch is clean.
    migrations::run_migrations(&pool)
        .await
        .expect("migrations run cleanly after repair");
    migrations::reconcile_on_startup(&pool)
        .await
        .expect("integrity holds after repair");
    pool.close().await;
}

#[tokio::test]
async fn repair_survives_a_restart() {
    let (_guard, db_path) = seeded_store().await;
    tamper_checksum(&db_path, 1).await;

    let (first, _) = migrations::open_with_migrations(&db_path)
        .await
        .expect("first open");
    first.close().await;

    // Second launch: the checksums were fixed on disk, so this is an ordinary
    // startup with nothing left to repair.
    let (second, recovery) = migrations::open_with_migrations(&db_path)
        .await
        .expect("second open");
    assert!(recovery.is_none());
    assert_eq!(conversation_count(&second).await, 1);
    second.close().await;
}

#[tokio::test]
async fn a_schema_that_really_diverged_is_not_silently_re_stamped() {
    let (_guard, db_path) = seeded_store().await;
    tamper_checksum(&db_path, 1).await;

    // Drop a table the migrations created. Now the recorded history claims a
    // schema this database does not have, which is the case the checksum is
    // actually there to catch — repair must decline and the backup path must run.
    let pool = db::init_pool(&db_path).await.expect("open to diverge");
    let dropped = sqlx::query("SELECT 1 FROM sqlite_master WHERE name = 'usage_summary'")
        .fetch_optional(&pool)
        .await
        .expect("look up usage_summary");
    assert!(
        dropped.is_some(),
        "test needs a real table to drop; usage_summary was renamed or removed"
    );
    sqlx::query("DROP TABLE usage_summary")
        .execute(&pool)
        .await
        .expect("drop table");
    pool.close().await;

    let (fresh, recovery) = migrations::open_with_migrations(&db_path)
        .await
        .expect("reopen after real divergence");

    let recovery = recovery.expect("a genuinely divergent schema must be treated as corrupt");
    assert!(
        recovery.backup_path.exists(),
        "the old store must be backed up before it is replaced"
    );
    assert_eq!(
        conversation_count(&fresh).await,
        0,
        "the replacement store starts empty"
    );

    // The backup is the user's data, and it must still be readable.
    let backup = db::init_pool(&recovery.backup_path)
        .await
        .expect("open the backup");
    assert_eq!(
        conversation_count(&backup).await,
        1,
        "the backup must still hold what the live store had"
    );
    backup.close().await;
    fresh.close().await;
}

#[tokio::test]
async fn a_store_from_a_newer_build_is_not_re_stamped() {
    let (_guard, db_path) = seeded_store().await;

    // A version this build has never heard of: the user ran a newer Conduit and
    // downgraded. Re-stamping would assert we produced a schema we do not know.
    let pool = db::init_pool(&db_path).await.expect("open to add version");
    sqlx::query(
        "INSERT INTO _sqlx_migrations \
         (version, description, installed_on, success, checksum, execution_time) \
         VALUES (9999, 'from the future', CURRENT_TIMESTAMP, 1, ?, 0)",
    )
    .bind(vec![0xabu8; 48])
    .execute(&pool)
    .await
    .expect("insert future migration");
    pool.close().await;

    tamper_checksum(&db_path, 1).await;

    let (_fresh, recovery) = migrations::open_with_migrations(&db_path)
        .await
        .expect("reopen after downgrade");
    assert!(
        recovery.is_some(),
        "a store ahead of this build must not be re-stamped in place"
    );
}
