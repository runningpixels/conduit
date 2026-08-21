//! Blob lifecycle / cleanup (M4).
//!
//! `gc_orphan_blobs` deletes the on-disk blob for `retention_state = 'deleted'`
//! attachment rows whose hash is not referenced by any non-deleted row. Artifact
//! versions are append-only and never GC'd. This is a low-priority startup /
//! idle task; a grace window and scheduled runs are deferred (non-goal).

use std::path::Path;

use sqlx::SqlitePool;

use crate::db::{repository::attachments, DbError};

/// Result of one orphan-blob GC pass.
#[derive(Debug, Clone, Default)]
pub struct GcReport {
    pub blobs_deleted: usize,
    /// A blob whose hash is still referenced by a live row was kept on disk.
    pub blobs_kept_shared: usize,
}

pub async fn gc_orphan_blobs(
    pool: &SqlitePool,
    attachments_dir: &Path,
) -> Result<GcReport, DbError> {
    let mut report = GcReport::default();

    // Deleted-retention rows whose hash is not shared by any live row.
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, path FROM attachments \
         WHERE retention_state = 'deleted' AND hash IS NOT NULL AND NOT EXISTS ( \
           SELECT 1 FROM attachments a2 \
           WHERE a2.hash = attachments.hash AND a2.retention_state <> 'deleted' \
         )",
    )
    .fetch_all(pool)
    .await?;

    for (id, rel_path) in rows {
        let abs = attachments::resolve_blob_path(attachments_dir, &rel_path);
        if abs.exists() {
            if let Err(e) = std::fs::remove_file(&abs) {
                // A failure to remove one blob must not abort the sweep.
                let _ = e;
                continue;
            }
            report.blobs_deleted += 1;
        }
        let _ = id;
    }

    // Count deleted rows whose blob is still shared (kept on disk).
    let shared: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM attachments \
         WHERE retention_state = 'deleted' AND hash IS NOT NULL AND EXISTS ( \
           SELECT 1 FROM attachments a2 \
           WHERE a2.hash = attachments.hash AND a2.retention_state <> 'deleted' \
         )",
    )
    .fetch_one(pool)
    .await?;
    report.blobs_kept_shared = shared.0.max(0) as usize;

    Ok(report)
}
