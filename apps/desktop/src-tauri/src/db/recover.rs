//! Interrupted-stream recovery (M3) — runs on startup after reconciliation.
//!
//! Two crash shapes:
//!
//! 1. **Finalized=false assistant turn** — events were applied (a `messages` row
//!    exists) but no `MessageComplete` ever arrived (the app died mid-stream, or
//!    the UI channel closed). These are marked interrupted: `interrupted_at`,
//!    `finalized = 1`, `finish_reason = 'cancelled'` — the spec §7.2 "recover
//!    with an interrupted assistant message instead of losing the turn".
//!
//! 2. **`MessageStart` with no view row** — the event log has events for a
//!    `request_id` but no `messages` row was ever written (crash between the
//!    first append and the view update — impossible under the
//!    `append_and_apply` single-transaction invariant, but the recovery sweep
//!    defends against it anyway, plus against DBs repaired by hand). The view is
//!    rebuilt from the log, then marked interrupted.
//!
//! Only assistant turns are candidates: user/system/developer messages are
//! persisted synchronously with `finalized = 0` and a NULL `request_id`, and are
//! filtered out by the `request_id IS NOT NULL` predicate.

use sqlx::SqlitePool;

use crate::{
    db::{
        fold::rebuild_view_from_log,
        repository::{event_log, messages},
        DbError,
    },
    time::now_iso8601,
};

/// Result of one recovery pass.
#[derive(Debug, Clone, Default)]
pub struct RecoverReport {
    pub unfinalized_marked: usize,
    pub orphaned_turns_rebuilt: usize,
}

/// Mark every in-progress assistant turn interrupted, and rebuild any turn that
/// has logged events but no view row. Idempotent.
pub async fn recover_interrupted_streams(pool: &SqlitePool) -> Result<RecoverReport, DbError> {
    let mut report = RecoverReport::default();

    // Shape 1: assistant rows that never reached `MessageComplete`.
    let unfinalized: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, request_id FROM messages \
         WHERE finalized = 0 AND request_id IS NOT NULL",
    )
    .fetch_all(pool)
    .await?;
    let now = now_iso8601();
    for (message_id, _request_id) in &unfinalized {
        sqlx::query(
            "UPDATE messages SET interrupted_at = ?, finalized = 1, finish_reason = 'cancelled' \
             WHERE id = ?",
        )
        .bind(&now)
        .bind(message_id)
        .execute(pool)
        .await?;
    }
    report.unfinalized_marked = unfinalized.len();

    // Shape 2: logged turns with no view row at all. Rebuild from the log, then
    // mark interrupted (the fold of an incomplete turn is not finalized).
    let turns = event_log::load_all_turns(pool).await?;
    for (conversation_id, request_id) in turns {
        if messages::get_message_id_by_request(pool, &request_id)
            .await?
            .is_some()
        {
            continue;
        }
        rebuild_view_from_log(pool, &conversation_id, &request_id).await?;
        messages::mark_interrupted_by_request(pool, &request_id).await?;
        report.orphaned_turns_rebuilt += 1;
    }

    Ok(report)
}