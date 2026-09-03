//! `provider_event_log` repository (M2) — the append-only source of truth.
//!
//! One row per `ProviderEvent`, keyed `(conversation_id, request_id, sequence)`.
//! A streaming delta is a single atomic INSERT — never a read-modify-write of
//! an aggregate. [`append_and_apply`] is the persistence invariant: it appends
//! the event and updates the materialized view in **one transaction**, so
//! `view == fold(events)` holds at all times.

use provider_core::schema::ProviderEvent;
use sqlx::{SqlitePool, Transaction};

use crate::{db::repository::messages, db::DbError, time::now_iso8601};

/// Next sequence number for `(conversation_id, request_id)` (0-based).
pub async fn next_sequence_in_txn(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    conversation_id: &str,
    request_id: &str,
) -> Result<i64, DbError> {
    let row: (i64,) = sqlx::query_as(
        "SELECT COALESCE(MAX(sequence), -1) + 1 AS next \
         FROM provider_event_log WHERE conversation_id = ? AND request_id = ?",
    )
    .bind(conversation_id)
    .bind(request_id)
    .fetch_one(&mut **tx)
    .await?;
    Ok(row.0)
}

/// Append one event row at a given sequence (used by the backfill job, which
/// knows the index up front).
pub async fn append_event_in_txn(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    conversation_id: &str,
    request_id: &str,
    sequence: i64,
    event: &ProviderEvent,
) -> Result<(), DbError> {
    let payload = serde_json::to_string(event)
        .map_err(|e| DbError::Query(format!("encode ProviderEvent: {e}")))?;
    let kind = event_kind_tag(event);
    sqlx::query(
        "INSERT INTO provider_event_log \
         (conversation_id, request_id, sequence, event_kind, payload, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(conversation_id)
    .bind(request_id)
    .bind(sequence)
    .bind(kind)
    .bind(&payload)
    .bind(now_iso8601())
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Append one event (own transaction) at the next sequence. Returns the sequence
/// used. Convenience for tests / non-stream callers; the stream path uses
/// [`append_and_apply`] so the append and view update share a transaction.
pub async fn append_event(
    pool: &SqlitePool,
    conversation_id: &str,
    request_id: &str,
    event: &ProviderEvent,
) -> Result<i64, DbError> {
    let mut tx = pool.begin().await?;
    let seq = next_sequence_in_txn(&mut tx, conversation_id, request_id).await?;
    append_event_in_txn(&mut tx, conversation_id, request_id, seq, event).await?;
    tx.commit().await?;
    Ok(seq)
}

/// The persistence invariant: append the event to the log AND update the
/// materialized view in **one transaction**, returning the sequence used. This
/// is the only write path for streaming events — it guarantees
/// `view == fold(events)` after every event.
pub async fn append_and_apply(
    pool: &SqlitePool,
    conversation_id: &str,
    request_id: &str,
    event: &ProviderEvent,
) -> Result<i64, DbError> {
    let mut tx = pool.begin().await?;
    let seq = next_sequence_in_txn(&mut tx, conversation_id, request_id).await?;
    append_event_in_txn(&mut tx, conversation_id, request_id, seq, event).await?;
    messages::apply_event_in_txn(&mut tx, conversation_id, request_id, event).await?;
    tx.commit().await?;
    Ok(seq)
}

/// Load all events for a turn, ordered by sequence.
pub async fn load_events(
    pool: &SqlitePool,
    conversation_id: &str,
    request_id: &str,
) -> Result<Vec<ProviderEvent>, DbError> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT payload FROM provider_event_log \
         WHERE conversation_id = ? AND request_id = ? ORDER BY sequence ASC",
    )
    .bind(conversation_id)
    .bind(request_id)
    .fetch_all(pool)
    .await?;

    rows.into_iter()
        .map(|(payload,)| {
            serde_json::from_str::<ProviderEvent>(&payload)
                .map_err(|e| DbError::Query(format!("decode ProviderEvent: {e}")))
        })
        .collect()
}

/// Every `request_id` that has logged events for a conversation (used by
/// reconciliation / recovery sweeps).
pub async fn load_all_request_ids(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Vec<String>, DbError> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT request_id FROM provider_event_log WHERE conversation_id = ?",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(r,)| r).collect())
}

/// Every `(conversation_id, request_id)` turn that has logged events, across all
/// conversations. Used by the M3 reconciliation and interrupted-stream recovery
/// sweeps.
pub async fn load_all_turns(pool: &SqlitePool) -> Result<Vec<(String, String)>, DbError> {
    let rows: Vec<(String, String)> =
        sqlx::query_as("SELECT DISTINCT conversation_id, request_id FROM provider_event_log")
            .fetch_all(pool)
            .await?;
    Ok(rows)
}

/// Delete all event log rows for a given request_id in a conversation.
/// Used by retry (replace mode) to erase the last turn's event history.
pub async fn delete_events_for_request(
    pool: &SqlitePool,
    conversation_id: &str,
    request_id: &str,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM provider_event_log WHERE conversation_id = ? AND request_id = ?")
        .bind(conversation_id)
        .bind(request_id)
        .execute(pool)
        .await?;
    Ok(())
}

fn event_kind_tag(event: &ProviderEvent) -> &'static str {
    match event {
        ProviderEvent::MessageStart { .. } => "messageStart",
        ProviderEvent::ContentBlockStart { .. } => "contentBlockStart",
        ProviderEvent::ContentDelta { .. } => "contentDelta",
        ProviderEvent::ReasoningDelta { .. } => "reasoningDelta",
        ProviderEvent::ContentBlockStop { .. } => "contentBlockStop",
        ProviderEvent::ToolCallStart { .. } => "toolCallStart",
        ProviderEvent::ToolCallDelta { .. } => "toolCallDelta",
        ProviderEvent::ToolCallComplete { .. } => "toolCallComplete",
        ProviderEvent::Usage { .. } => "usage",
        ProviderEvent::Ping { .. } => "ping",
        ProviderEvent::MessageComplete { .. } => "messageComplete",
        ProviderEvent::Error { .. } => "error",
        // Phase 7 / M-WebSearch: hosted web-search events are journaled just
        // like any other provider event. `SearchUnavailable` is the
        // adapter-emitted "endpoint can't host this tool" event; it is the
        // canonical signal that the user's intent was respected, not silently
        // dropped.
        ProviderEvent::SearchSources { .. } => "searchSources",
        ProviderEvent::Citation { .. } => "citation",
        ProviderEvent::SearchCost { .. } => "searchCost",
        ProviderEvent::SearchUnavailable { .. } => "searchUnavailable",
        // Phase 1 — Agent Feedback & Status UI: agent phase and tool execution
        // progress events are UI-only and intentionally not persisted.
        ProviderEvent::AgentPhase { .. } => "agentPhase",
        ProviderEvent::ToolExecutionStarted { .. } => "toolExecutionStarted",
        ProviderEvent::ToolExecutionFinished { .. } => "toolExecutionFinished",
        ProviderEvent::AskUserRequested { .. } => "askUserRequested",
    }
}
