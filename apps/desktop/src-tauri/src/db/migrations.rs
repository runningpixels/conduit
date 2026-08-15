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
    match run_migrations(&pool).await {
        Ok(()) => {
            reconcile_on_startup(&pool).await?;
            Ok((pool, None))
        }
        Err(error) => {
            // Release the corrupt file before we move it.
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
    let marker_path = PathBuf::from(format!("{}.migration-failed", db_path.display()));

    let map_io = |e: std::io::Error| RecoveryError::Io(e.to_string());

    // Copy then remove (rename can fail if a stale handle lingers on Windows).
    if db_path.exists() {
        fs::copy(db_path, &backup_path).map_err(|e| DbError::RecoveryIo(map_io(e).to_string()))?;
        let _ = fs::remove_file(db_path);
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
