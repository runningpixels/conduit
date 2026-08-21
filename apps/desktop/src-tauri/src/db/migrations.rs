//! Forward-only migration runner + startup integrity / reconciliation.
//!
//! Mechanics are delegated to sqlx's `Migrator` (its `_sqlx_migrations` table
//! tracks applied versions and checksums). A public `schema_migrations` table —
//! required by the local-data design and the table cloud sync would read —
//! is created by the first migration and mirrored from `_sqlx_migrations` after
//! every run so the two never drift.
//!
//! Migration files live in `apps/desktop/src-tauri/migrations/` and are embedded
//! at compile time via `sqlx::migrate!`.

use std::{
    borrow::Cow,
    fs,
    path::{Path, PathBuf},
};

use sqlx::{
    migrate::{Migration, MigrationType, Migrator},
    sqlite::SqlitePool,
};
use thiserror::Error;

use super::DbError;
use crate::{db::init_pool, time::now_unix};

/// Compiled-in migrator. The path is relative to this crate's
/// `CARGO_MANIFEST_DIR` (`apps/desktop/src-tauri/migrations`).
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Migrator that applies only the initial schema (migration `0001`). Used to
/// generate historical SQLite fixtures for `tests/fixture_migration.rs`.
pub fn migrator_initial_schema_only() -> Migrator {
    Migrator {
        migrations: Cow::Owned(vec![Migration::new(
            1,
            Cow::Borrowed("initial schema"),
            MigrationType::Simple,
            Cow::Borrowed(include_str!("../../migrations/0001_initial_schema.sql")),
            false,
        )]),
        ..Migrator::DEFAULT
    }
}

/// Materialize a SQLite database at the `0001` schema level (migration `0001`
/// applied, public `schema_migrations` mirrored). The resulting file is a valid
/// input for forward-migration tests that exercise `0004` and later.
pub async fn materialize_fixture_through_initial_schema(pool: &SqlitePool) -> Result<(), DbError> {
    migrator_initial_schema_only()
        .run(pool)
        .await
        .map_err(|e| DbError::Migrate(e.to_string()))?;
    sync_schema_migrations(pool).await
}

/// Information surfaced to the user when a migration failed and the live DB was
/// rolled back to a fresh store. Stored on `AppState` so the renderer can show
/// the "Conduit could not upgrade your local data" dialog once.
#[derive(Debug, Clone)]
pub struct MigrationRecovery {
    /// Absolute path of the `.corrupt-<unix>.bak` backup of the failed DB.
    pub backup_path: PathBuf,
    /// The migration error that caused the recovery.
    pub error: String,
}

/// Run all pending migrations against `pool`, then mirror the applied set into
/// the public `schema_migrations` audit table.
pub async fn run_migrations(pool: &SqlitePool) -> Result<(), DbError> {
    MIGRATOR
        .run(pool)
        .await
        .map_err(|e| DbError::Migrate(e.to_string()))?;
    sync_schema_migrations(pool).await?;
    Ok(())
}

/// Rebuild `schema_migrations` from sqlx's internal `_sqlx_migrations` so the
/// public audit table is always an exact reflection of what the runner applied.
async fn sync_schema_migrations(pool: &SqlitePool) -> Result<(), DbError> {
    sqlx::query("DELETE FROM schema_migrations")
        .execute(pool)
        .await?;
    sqlx::query(
        "INSERT INTO schema_migrations (version, name, applied_at, checksum) \
         SELECT version, description, installed_on, lower(hex(checksum)) \
         FROM _sqlx_migrations WHERE success = 1",
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Startup integrity check: `integrity_check`, `foreign_key_check`, and
/// migration-history consistency. Returns `Ok(())` only when the database is
/// structurally sound.
pub async fn reconcile_on_startup(pool: &SqlitePool) -> Result<(), DbError> {
    let (integrity,): (String,) = sqlx::query_as("PRAGMA integrity_check")
        .fetch_one(pool)
        .await?;
    if integrity != "ok" {
        return Err(DbError::Integrity(integrity));
    }

    let fk_violations = sqlx::query("PRAGMA foreign_key_check")
        .fetch_all(pool)
        .await?;
    if !fk_violations.is_empty() {
        return Err(DbError::ForeignKeyCheck(fk_violations.len()));
    }

    let (public,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM schema_migrations")
        .fetch_one(pool)
        .await?;
    let (internal,): (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM _sqlx_migrations WHERE success = 1")
            .fetch_one(pool)
            .await?;
    if public != internal {
        return Err(DbError::MigrationHistoryMismatch);
    }

    Ok(())
}

/// Open the database, run migrations, and run the startup integrity check.
///
/// If migrations fail, applies the user-safe failure mode required by
/// Recovery contract: the corrupt DB is backed up to
/// `conduit.sqlite.corrupt-<unix>.bak`, a `.migration-failed` marker is written,
/// and a fresh store is created and migrated from scratch. The returned
/// [`MigrationRecovery`] (if any) lets the UI inform the user. The `streams/`
/// directory is left untouched so a downgrade/re-import is still possible.
pub async fn open_with_migrations(
    db_path: &Path,
) -> Result<(SqlitePool, Option<MigrationRecovery>), DbError> {
    let pool = init_pool(db_path).await?;
    let first_attempt = run_migrations(&pool).await;

    // A checksum mismatch is not corruption on its own — see
    // `repair_checksum_drift`. Try to prove the schema is sound and re-stamp
    // before treating the store as unrecoverable.
    let outcome = match first_attempt {
        Err(DbError::Migrate(ref message)) if is_checksum_drift(message) => {
            match repair_checksum_drift(&pool).await {
                Ok(true) => {
                    eprintln!(
                        "conduit: migration checksums drifted but the schema matched; \
                         re-stamped and kept the existing store"
                    );
                    run_migrations(&pool).await
                }
                Ok(false) => first_attempt,
                Err(repair_error) => {
                    eprintln!("conduit: checksum-drift repair failed: {repair_error}");
                    first_attempt
                }
            }
        }
        other => other,
    };

    match outcome {
        Ok(()) => {
            reconcile_on_startup(&pool).await?;
            Ok((pool, None))
        }
        Err(error) => {
            // Release the corrupt file before we move it. `close()` waits for
            // every connection to actually shut down; a bare `drop` only marks
            // the pool closed and returns, leaving a live handle that makes the
            // `remove_file` below fail on Windows.
            pool.close().await;
            drop(pool);
            let recovery = handle_migration_failure(db_path, &error)?;
            let fresh = init_pool(db_path).await?;
            // A fresh DB must migrate cleanly; if even that fails, surface it.
            run_migrations(&fresh).await?;
            reconcile_on_startup(&fresh).await?;
            Ok((fresh, Some(recovery)))
        }
    }
}

/// Does this migration error mean "the file changed", as opposed to real
/// corruption? sqlx has no error code for it, so the message is the only
/// signal; the wording comes from `sqlx::migrate::MigrateError::VersionMismatch`.
fn is_checksum_drift(message: &str) -> bool {
    message.contains("previously applied but has been modified")
}

/// Re-stamp drifted migration checksums when the schema they produced is
/// provably still correct. Returns `true` if anything was repaired.
///
/// sqlx hashes each migration *file* and refuses to run when the hash no longer
/// matches what the database recorded. That check cannot tell a rewritten
/// `ALTER TABLE` from a fixed typo in a comment, and the consequence of the
/// false positive is severe: `open_with_migrations` treats the store as corrupt
/// and starts the user over on an empty database.
///
/// It is not hypothetical. This repository has shipped three different
/// checksums for `0001_initial_schema.sql`, and every one of the differences
/// was in a comment. Databases on disk carry all three.
///
/// So rather than trust the hash, check the thing the hash is a proxy for: does
/// this database's schema match what today's migrations actually produce? A
/// reference database is built in a tempdir, migrated to the same version the
/// live one reached, and the two `sqlite_master` snapshots are compared. Equal
/// means the drift was cosmetic and the recorded checksums are safe to update.
/// Unequal means the SQL genuinely changed underneath an applied migration, and
/// the caller falls through to the back-up-and-start-fresh path.
///
/// Deliberately conservative — it declines to repair when:
///   * the database has a migration version this build does not know about
///     (a downgrade: the schema is ahead of the code),
///   * any applied migration is recorded as failed, or
///   * the schemas differ in any way.
async fn repair_checksum_drift(pool: &SqlitePool) -> Result<bool, DbError> {
    let applied: Vec<(i64, Vec<u8>, bool)> =
        sqlx::query_as("SELECT version, checksum, success FROM _sqlx_migrations ORDER BY version")
            .fetch_all(pool)
            .await?;
    if applied.is_empty() {
        return Ok(false);
    }
    if applied.iter().any(|(_, _, success)| !success) {
        return Ok(false);
    }

    let known: std::collections::HashMap<i64, &Migration> =
        MIGRATOR.iter().map(|m| (m.version, m)).collect();

    let mut drifted = Vec::new();
    for (version, checksum, _) in &applied {
        let Some(current) = known.get(version) else {
            // The store is ahead of this build. Re-stamping would claim we
            // produced a schema we know nothing about.
            return Ok(false);
        };
        if current.checksum.as_ref() != checksum.as_slice() {
            drifted.push((*version, current.checksum.to_vec()));
        }
    }
    if drifted.is_empty() {
        return Ok(false);
    }

    let highest_applied = applied.iter().map(|(v, _, _)| *v).max().unwrap_or(0);
    let live = schema_snapshot(pool).await?;
    let reference = reference_schema(highest_applied).await?;
    if live != reference {
        return Ok(false);
    }

    for (version, checksum) in drifted {
        sqlx::query("UPDATE _sqlx_migrations SET checksum = ? WHERE version = ?")
            .bind(checksum)
            .bind(version)
            .execute(pool)
            .await?;
    }
    Ok(true)
}

/// Every schema object in the database, normalized for comparison.
///
/// `sqlite_%` rows are SQLite's own bookkeeping and `_sqlx_migrations` is the
/// table being repaired, so both are excluded. Whitespace is collapsed because
/// SQLite stores `sql` verbatim from the statement that created the object, and
/// reindentation is exactly the kind of cosmetic change this is meant to allow.
async fn schema_snapshot(pool: &SqlitePool) -> Result<Vec<(String, String, String)>, DbError> {
    let rows: Vec<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT type, name, sql FROM sqlite_master \
         WHERE name NOT LIKE 'sqlite_%' AND name <> '_sqlx_migrations' \
         ORDER BY type, name",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(kind, name, sql)| {
            let normalized = sql
                .unwrap_or_default()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ");
            (kind, name, normalized)
        })
        .collect())
}

/// Build a throwaway database migrated to `through_version` and snapshot it.
/// This is what the live schema is compared against.
async fn reference_schema(through_version: i64) -> Result<Vec<(String, String, String)>, DbError> {
    let dir = tempfile::tempdir()
        .map_err(|e| DbError::RecoveryIo(format!("reference schema tempdir: {e}")))?;
    let reference_db = dir.path().join("reference.sqlite");
    let pool = init_pool(&reference_db).await?;

    let subset = Migrator {
        migrations: Cow::Owned(
            MIGRATOR
                .iter()
                .filter(|m| m.version <= through_version)
                .cloned()
                .collect(),
        ),
        ..Migrator::DEFAULT
    };
    subset
        .run(&pool)
        .await
        .map_err(|e| DbError::Migrate(e.to_string()))?;

    let snapshot = schema_snapshot(&pool).await?;
    pool.close().await;
    Ok(snapshot)
}

#[derive(Debug, Error)]
enum RecoveryError {
    #[error("{0}")]
    Io(String),
}

/// Back up the failed DB, write the failure marker, and remove the live file so
/// `init_pool` can create a fresh one. Returns the recovery info for the UI.
fn handle_migration_failure(db_path: &Path, error: &DbError) -> Result<MigrationRecovery, DbError> {
    let unix = now_unix();
    let backup_path = PathBuf::from(format!("{}.corrupt-{unix}.bak", db_path.display()));
    let marker_path = crate::local_data::failure_marker_path(db_path);

    let map_io = |e: std::io::Error| RecoveryError::Io(e.to_string());

    // Copy then remove (rename can fail if a stale handle lingers on Windows).
    if db_path.exists() {
        fs::copy(db_path, &backup_path).map_err(|e| DbError::RecoveryIo(map_io(e).to_string()))?;

        // Copy the WAL sidecars alongside the backup. A checkpoint on close
        // normally empties the WAL, but if it did not, the last committed
        // transactions live there and a `.bak` without them is a backup that
        // silently loses the user's most recent conversations.
        for suffix in ["-wal", "-shm"] {
            let sidecar = PathBuf::from(format!("{}{suffix}", db_path.display()));
            if sidecar.exists() {
                let _ = fs::copy(&sidecar, format!("{}{suffix}", backup_path.display()));
            }
        }

        // The live file must go, or `init_pool` below reopens the same corrupt
        // database, the retry migration fails too, and startup aborts with the
        // original error instead of recovering. Report it rather than swallow
        // it — the message names the file the user has to delete by hand.
        fs::remove_file(db_path).map_err(|e| {
            DbError::RecoveryIo(format!(
                "backed up the failed database to {} but could not remove the live file {}: {}.                  Close any other running copy of Conduit, or delete that file manually, and                  start Conduit again.",
                backup_path.display(),
                db_path.display(),
                map_io(e)
            ))
        })?;
        // WAL sidecars: harmless if absent, removed so the fresh DB starts clean.
        let _ = fs::remove_file(format!("{}-wal", db_path.display()));
        let _ = fs::remove_file(format!("{}-shm", db_path.display()));
    }

    let marker_body = format!(
        "Conduit migration failed at {unix}.\nError: {error}\n\
         A backup of the previous local store was saved to {}.\n\
         Starting with a fresh local store; streams/ was left untouched.",
        backup_path.display()
    );
    let _ = fs::write(&marker_path, marker_body);

    // Also log to the diagnostics-redaction-free stderr for support bundles.
    eprintln!(
        "conduit: migration failed; backup at {}; starting fresh",
        backup_path.display()
    );

    Ok(MigrationRecovery {
        backup_path,
        error: error.to_string(),
    })
}
