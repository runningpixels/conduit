//! Generate a committed SQLite fixture at the `0001` schema level.
//!
//! Usage (from the repo root):
//!   cargo run -p conduit-desktop --bin generate-migration-fixture
//!
//! Or with an explicit output path:
//!   cargo run -p conduit-desktop --bin generate-migration-fixture -- \
//!     apps/desktop/src-tauri/tests/fixtures/db/0001_initial_schema.sqlite

use std::path::PathBuf;

use conduit_desktop::db::{init_pool, migrations};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out = std::env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/db/0001_initial_schema.sqlite")
    });

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if out.exists() {
        std::fs::remove_file(&out)?;
    }

    let pool = init_pool(&out).await?;
    migrations::materialize_fixture_through_initial_schema(&pool).await?;
    pool.close().await;

    println!("wrote fixture to {}", out.display());
    Ok(())
}
