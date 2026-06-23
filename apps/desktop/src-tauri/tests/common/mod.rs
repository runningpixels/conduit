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

/// A tier-`Off` `Encryption` (identity / plaintext passthrough) for tests that
/// exercise repos which now take `&Encryption` but don't care about encryption.
pub fn setup_encryption() -> Encryption {
    Encryption::off()
}