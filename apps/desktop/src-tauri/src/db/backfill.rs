//! Legacy journal backfill (M3) — one-time import of the pre-Phase-3 file
//! journals (`streams/<conv>/<req>.json`) into the SQLite event log + view.
//!
//! For each legacy `StreamRecord`: ensure the conversation row exists, append
//! all recorded `events` to `provider_event_log` at `sequence = index`, and
//! rebuild the materialized view from the log (the log is the source of truth —
//! the legacy `record.message` is verified against the fold but the fold wins
//! on mismatch). Interrupted records are marked interrupted. The conversation's
//! `updated_at` is bumped to the original message `created_at` so the history
//! rail preserves original chronology.
//!
//! Idempotent: a turn whose `request_id` already has a `messages` row is
//! skipped. A `streams/.backfilled` marker is written on success so the sweep
//! can short-circuit on later starts; `streams/` is kept on disk as a backup
//! (never deleted) for downgrade/re-import safety.

use std::path::Path;

use provider_core::schema::MessagePart;
use sqlx::SqlitePool;

use crate::{
    db::{
        fold::fold,
        repository::{conversations, event_log, messages},
        DbError,
    },
    stream_persistence::StreamRecord,
};

/// Result of one backfill pass.
#[derive(Debug, Clone, Default)]
pub struct BackfillReport {
    pub files_scanned: usize,
    pub turns_imported: usize,
    pub skipped_already_present: usize,
    /// Records whose folded view disagreed with the legacy `record.message`. The
    /// log-derived view was written anyway (log wins); the count is diagnostic.
    pub verification_mismatches: usize,
    /// Files that could not be read or parsed. The import continues past these.
    pub failed: usize,
}

/// Marker file written into `streams/` once a clean backfill completes, so later
/// starts can skip the directory walk.
const BACKFILLED_MARKER: &str = ".backfilled";

/// Import every legacy `streams/<conv>/<req>.json` into the SQLite store. No-op
/// (returns an empty report) if `streams_dir` is absent or the `.backfilled`
/// marker is already present.
pub async fn backfill_legacy_streams(
    pool: &SqlitePool,
    streams_dir: &Path,
) -> Result<BackfillReport, DbError> {
    let mut report = BackfillReport::default();

    if !streams_dir.exists() {
        return Ok(report);
    }
    if streams_dir.join(BACKFILLED_MARKER).exists() {
        return Ok(report);
    }

    let conv_dirs = match std::fs::read_dir(streams_dir) {
        Ok(it) => it,
        Err(e) => return Err(DbError::RecoveryIo(e.to_string())),
    };

    for entry in conv_dirs.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(conversation_id) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        // The marker file itself may appear as a non-directory entry; skip files.
        if conversation_id == BACKFILLED_MARKER {
            continue;
        }

        let req_files = match std::fs::read_dir(&path) {
            Ok(it) => it,
            Err(_) => continue, // unreadable subdir — skip, don't fail the sweep
        };

        for file_entry in req_files.flatten() {
            let file_path = file_entry.path();
            if file_path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            report.files_scanned += 1;

            match import_one(pool, conversation_id, &file_path).await {
                Ok(ImportOutcome::Imported { mismatch }) => {
                    report.turns_imported += 1;
                    if mismatch {
                        report.verification_mismatches += 1;
                    }
                }
                Ok(ImportOutcome::AlreadyPresent) => report.skipped_already_present += 1,
                Err(e) => {
                    // A corrupt/unreadable legacy file must not abort the sweep.
                    report.failed += 1;
                    let _ = e; // best-effort: continue
                }
            }
        }
    }

    // Write the marker only when every file was consumed (no failures). On a
    // partial failure the next start re-walks; already-present turns are skipped.
    if report.failed == 0 {
        let marker = streams_dir.join(BACKFILLED_MARKER);
        let _ = std::fs::write(&marker, "backfilled\n");
    }

    Ok(report)
}

enum ImportOutcome {
    Imported { mismatch: bool },
    AlreadyPresent,
}

async fn import_one(
    pool: &SqlitePool,
    conversation_id: &str,
    file_path: &Path,
) -> Result<ImportOutcome, DbError> {
    let raw = std::fs::read_to_string(file_path)
        .map_err(|e| DbError::RecoveryIo(format!("read {}: {e}", file_path.display())))?;
    let record: StreamRecord = serde_json::from_str(&raw)
        .map_err(|e| DbError::Query(format!("parse {}: {e}", file_path.display())))?;

    // Idempotent: skip turns already present (re-run after a partial backfill,
    // or a turn that was live-migrated by the stream path).
    if messages::get_message_id_by_request(pool, &record.request_id)
        .await?
        .is_some()
    {
        return Ok(ImportOutcome::AlreadyPresent);
    }

    // The conversation row may not exist (the legacy path never created one).
    conversations::ensure_exists(pool, conversation_id).await?;

    let message_id = record.message.id.clone();
    let original_created_at = record.message.created_at.clone();

    // One transaction: append every event at its recorded index, create the
    // message row with its original id + created_at, and write the folded view.
    let folded = fold(
        &record.events,
        conversation_id,
        &message_id,
        &original_created_at,
    );

    let mut tx = pool.begin().await?;
    for (index, event) in record.events.iter().enumerate() {
        event_log::append_event_in_txn(&mut tx, conversation_id, &record.request_id, index as i64, event)
            .await?;
    }
    sqlx::query(
        "INSERT INTO messages \
         (id, conversation_id, role, request_id, interrupted_at, finalized, finish_reason, created_at) \
         VALUES (?, ?, 'assistant', ?, NULL, 0, NULL, ?)",
    )
    .bind(&message_id)
    .bind(conversation_id)
    .bind(&record.request_id)
    .bind(&original_created_at)
    .execute(&mut *tx)
    .await?;
    messages::replace_view_in_txn(
        &mut tx,
        &message_id,
        &folded.parts,
        folded.finalized,
        folded.finish_reason.as_deref(),
    )
    .await?;
    tx.commit().await?;

    // Interrupted legacy records get the interrupted marker (the fold of an
    // incomplete turn is not finalized, so this also finalizes the row).
    if record.interrupted || record.message.interrupted_at.is_some() {
        messages::mark_interrupted_by_request(pool, &record.request_id).await?;
    }

    // Preserve original chronology in the history rail.
    conversations::touch_at(pool, conversation_id, &original_created_at).await?;

    // Verification: compare the fold to the legacy stored message. Log wins —
    // the folded view above is what we keep — but record the mismatch.
    let mismatch = !legacy_matches_fold(&record.message.parts, &folded.parts);

    Ok(ImportOutcome::Imported { mismatch })
}

/// Compare the legacy `record.message.parts` to the folded parts on the fold's
/// output fields. Used only to flag drift for diagnostics; the folded view is
/// always the one persisted. Legacy part ids are raw block ids; folded ids are
/// `{message_id}/{block_id}`, so the prefix is stripped before comparing.
fn legacy_matches_fold(legacy: &[MessagePart], folded: &[MessagePart]) -> bool {
    if legacy.len() != folded.len() {
        return false;
    }
    legacy.iter().zip(folded.iter()).all(|(l, f)| {
        let folded_tail = f.id.rsplit('/').next().unwrap_or(&f.id);
        l.id == folded_tail
            && l.index == f.index
            && l.kind == f.kind
            && l.content == f.content
            && l.mime_type == f.mime_type
            && l.tool_call_id == f.tool_call_id
    })
}