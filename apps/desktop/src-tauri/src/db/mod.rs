//! SQLite connection pool and migration orchestration (Phase 3, Milestone 1).
//!
//! The pool is owned by `AppState` and shared across repositories. SQLite
//! serializes writers, so the pool is a single connection (`max_connections(1)`)
//! — extra connections would only add WAL read contention. PRAGMAs that must
//! hold per-connection (`foreign_keys`, `journal_mode`, `busy_timeout`) are set
//! via `SqliteConnectOptions` so they apply on every (re)connect.
//!
//! Repository modules over this schema live in [`repository`] and are populated
//! across M2–M5.

pub mod backfill;
pub mod cleanup;
pub mod fold;
pub mod migrations;
pub mod reconcile;
pub mod recover;
pub mod repository;

pub use migrations::{open_with_migrations, reconcile_on_startup, run_migrations, MigrationRecovery, MIGRATOR};

use std::{path::Path, str::FromStr, time::Duration};

use sqlx::{
    sqlite::{
        SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous, SqlitePool, SqlitePoolOptions,
    },
};
use thiserror::Error;

/// Canonical SQLite pool type used across Phase 3 repositories.
pub type DbPool = SqlitePool;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("sqlite connect failed: {0}")]
    Connect(String),
    #[error("sqlite query failed: {0}")]
    Query(String),
    #[error("migration failed: {0}")]
    Migrate(String),
    #[error("database integrity check failed: {0}")]
    Integrity(String),
    #[error("foreign key check reported {0} violation(s)")]
    ForeignKeyCheck(usize),
    #[error("migration history mismatch between schema_migrations and _sqlx_migrations")]
    MigrationHistoryMismatch,
    #[error("migration recovery I/O failed: {0}")]
    RecoveryIo(String),
}

impl From<sqlx::Error> for DbError {
    fn from(error: sqlx::Error) -> Self {
        DbError::Query(error.to_string())
    }
}

/// Open the pool at `db_path` (creating the file if absent) with the Phase 3
/// PRAGMAs applied on every connection.
pub async fn init_pool(db_path: &Path) -> Result<DbPool, DbError> {
    // Forward-slash the path so the sqlite:// URL is well-formed on Windows.
    let path_str = db_path.to_string_lossy().replace('\\', "/");
    let url = format!("sqlite://{path_str}?mode=rwc");

    let options = SqliteConnectOptions::from_str(&url)
        .map_err(|e| DbError::Connect(e.to_string()))?
        .create_if_missing(true)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal)
        .busy_timeout(Duration::from_millis(5000))
        .foreign_keys(true)
        .pragma("temp_store", "MEMORY");

    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .map_err(|e| DbError::Connect(e.to_string()))
}

#[cfg(test)]
/// In-crate test helpers: an in-memory pool with the schema migrated, for
/// repository unit tests that can't reach `tests/common`.
pub mod tests {
    use super::DbPool;
    use sqlx::sqlite::SqlitePoolOptions;

    pub async fn pool() -> DbPool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("connect in-memory");
        super::run_migrations(&pool)
            .await
            .expect("migrations apply cleanly");
        pool
    }
}