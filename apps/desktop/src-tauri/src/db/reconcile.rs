//! Reconciliation sweep (M3) — verifies the persistence invariant
//! `view == fold(events)` across every logged turn and repairs drift.
//!
//! For each `(conversation, request)` turn in `provider_event_log`: fold the
//! events, snapshot the persisted materialized view, and compare. On mismatch
//! (missing row, finalization drift, or part drift) the view is rebuilt from the
//! log via `fold::rebuild_view_from_log` and a `rebuilds` counter is
//! incremented. The log is the source of truth — the view is derived and
//! repairable.
//!
//! This is the check that proves the incremental view updater
//! (`messages::apply_event_in_txn`) and the pure `fold` agree. Run on startup
//! after backfill and before interrupted-stream recovery.

use provider_core::schema::MessagePart;

use crate::db::{
    fold::{fold, FoldedView},
    repository::{event_log, messages},
    DbError,
};
use sqlx::SqlitePool;

/// Result of one reconciliation pass.
#[derive(Debug, Clone, Default)]
pub struct ReconcileReport {
    pub turns_checked: usize,
    pub rebuilds: usize,
    /// Turns where the persisted view differed from `fold(events)`. Captured for
    /// diagnostics; the view is always rebuilt to match the log.
    pub mismatches: Vec<TurnMismatch>,
}

#[derive(Debug, Clone)]
pub struct TurnMismatch {
    pub conversation_id: String,
    pub request_id: String,
    pub reason: String,
}

/// Reconcile every logged turn. The log wins: any drift is repaired by
/// rebuilding the view from the log.
pub async fn reconcile_all(pool: &SqlitePool) -> Result<ReconcileReport, DbError> {
    let turns = event_log::load_all_turns(pool).await?;
    let mut report = ReconcileReport {
        turns_checked: turns.len(),
        ..Default::default()
    };

    for (conversation_id, request_id) in turns {
        let reason = compare_turn(pool, &conversation_id, &request_id).await?;
        if let Some(reason) = reason {
            // Log wins — rebuild the view from the intact event log.
            crate::db::fold::rebuild_view_from_log(pool, &conversation_id, &request_id).await?;
            report.rebuilds += 1;
            report.mismatches.push(TurnMismatch {
                conversation_id,
                request_id,
                reason,
            });
        }
    }

    Ok(report)
}

/// Compare `fold(events)` to the persisted view for one turn. Returns
/// `Some(reason)` on mismatch (caller rebuilds), `None` when they agree.
async fn compare_turn(
    pool: &SqlitePool,
    conversation_id: &str,
    request_id: &str,
) -> Result<Option<String>, DbError> {
    let events = event_log::load_events(pool, conversation_id, request_id).await?;
    let message_id = match messages::get_message_id_by_request(pool, request_id).await? {
        Some(id) => id,
        None => return Ok(Some("no message row for logged turn".to_string())),
    };

    let folded = fold(&events, conversation_id, &message_id, "");
    let snapshot = match messages::snapshot_view_for_request(pool, request_id).await? {
        Some(s) => s,
        None => return Ok(Some("view snapshot missing after row found".to_string())),
    };

    if snapshot.finalized != folded.finalized {
        return Ok(Some(format!(
            "finalization drift: view={} fold={}",
            snapshot.finalized, folded.finalized
        )));
    }
    if snapshot.finish_reason != folded.finish_reason {
        return Ok(Some(format!(
            "finish_reason drift: view={:?} fold={:?}",
            snapshot.finish_reason, folded.finish_reason
        )));
    }
    if !parts_match(&snapshot.parts, &folded) {
        return Ok(Some("part drift".to_string()));
    }
    Ok(None)
}

/// Compare persisted parts to the folded view on the fields the fold determines
/// (id, index, kind, content, mime_type, tool_call_id). `created_at`,
/// `message_id`, and the not-yet-implemented references (artifact/attachment/blob/
/// metadata) are not fold outputs and are intentionally ignored.
fn parts_match(persisted: &[MessagePart], folded: &FoldedView) -> bool {
    if persisted.len() != folded.parts.len() {
        return false;
    }
    persisted
        .iter()
        .zip(folded.parts.iter())
        .all(|(p, f)| part_eq(p, f))
}

fn part_eq(a: &MessagePart, b: &MessagePart) -> bool {
    a.id == b.id
        && a.index == b.index
        && a.kind == b.kind
        && a.content == b.content
        && a.mime_type == b.mime_type
        && a.tool_call_id == b.tool_call_id
}