//! `messages` + `message_parts` repository (M2) — the materialized message view.
//!
//! Two write disciplines meet here:
//!   * the **incremental** view updater (`apply_event_in_txn`) applies a single
//!     `ProviderEvent` to the existing rows (UPDATE/INSERT one part) — used in
//!     the same transaction as the event-log append (the persistence
//!     invariant);
//!   * `insert_message` writes a whole pre-built `Message` (user/system
//!     messages, tests).
//!
//! `load_conversation_messages` is the read path that replaces
//! `stream_persistence::load_conversation_messages`, preserving the
//! lexicographic-`created_at` order invariant (H2/L3).

use provider_core::schema::{Message, MessagePart, MessagePartKind, MessageRole, ProviderEvent};
use sqlx::{SqlitePool, Transaction};
use uuid::Uuid;

use crate::{db::DbError, time::now_iso8601};

// --- enum ↔ string mapping (matches serde camelCase rename on the enums) -----

fn role_to_str(role: &MessageRole) -> &'static str {
    match role {
        MessageRole::System => "system",
        MessageRole::Developer => "developer",
        MessageRole::User => "user",
        MessageRole::Assistant => "assistant",
        MessageRole::Tool => "tool",
    }
}

fn role_from_str(s: &str) -> Result<MessageRole, DbError> {
    Ok(match s {
        "system" => MessageRole::System,
        "developer" => MessageRole::Developer,
        "user" => MessageRole::User,
        "assistant" => MessageRole::Assistant,
        "tool" => MessageRole::Tool,
        other => return Err(DbError::Query(format!("unknown message role: {other}"))),
    })
}

fn part_kind_to_str(kind: &MessagePartKind) -> &'static str {
    match kind {
        MessagePartKind::Text => "text",
        MessagePartKind::ToolResult => "toolResult",
        MessagePartKind::ArtifactReference => "artifactReference",
        MessagePartKind::AttachmentReference => "attachmentReference",
        MessagePartKind::Reasoning => "reasoning",
        MessagePartKind::Image => "image",
        MessagePartKind::File => "file",
    }
}

fn part_kind_from_str(s: &str) -> Result<MessagePartKind, DbError> {
    Ok(match s {
        "text" => MessagePartKind::Text,
        "toolResult" => MessagePartKind::ToolResult,
        "artifactReference" => MessagePartKind::ArtifactReference,
        "attachmentReference" => MessagePartKind::AttachmentReference,
        "reasoning" => MessagePartKind::Reasoning,
        "image" => MessagePartKind::Image,
        "file" => MessagePartKind::File,
        other => return Err(DbError::Query(format!("unknown part kind: {other}"))),
    })
}

// --- incremental view updater (the persistence invariant's view half) --------

/// Ensure the assistant-turn message row for `request_id` exists, creating it
/// (with a fresh UUID id) if not. Returns the message id. Idempotent — safe for
/// recovery where events exist but the row was never written.
async fn ensure_message_row_in_txn(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    conversation_id: &str,
    request_id: &str,
) -> Result<String, DbError> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT id FROM messages WHERE request_id = ?")
            .bind(request_id)
            .fetch_optional(&mut **tx)
            .await?;
    if let Some((id,)) = row {
        return Ok(id);
    }

    let id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    sqlx::query(
        "INSERT INTO messages (id, conversation_id, role, request_id, created_at, finalized) \
         VALUES (?, ?, 'assistant', ?, ?, 0)",
    )
    .bind(&id)
    .bind(conversation_id)
    .bind(request_id)
    .bind(&now)
    .execute(&mut **tx)
    .await?;
    Ok(id)
}

/// Apply one `ProviderEvent` to the materialized view, inside the caller's
/// transaction (the event-log append happens in the same txn — see
/// `event_log::append_and_apply`).
pub async fn apply_event_in_txn(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    conversation_id: &str,
    request_id: &str,
    event: &ProviderEvent,
) -> Result<(), DbError> {
    match event {
        ProviderEvent::MessageStart { .. } => {
            ensure_message_row_in_txn(tx, conversation_id, request_id).await?;
        }
        ProviderEvent::ContentBlockStart {
            block_id, index, block_kind, ..
        } => {
            let message_id = ensure_message_row_in_txn(tx, conversation_id, request_id).await?;
            let kind = if block_kind == "thinking" {
                MessagePartKind::Reasoning
            } else {
                MessagePartKind::Text
            };
            let now = now_iso8601();
            // The part id is `{message_id}/{block_id}`: adapters reuse block ids
            // across turns (ollama emits `block-0` every turn; anthropic/openai
            // use per-stream `block-{index}`), so the raw block_id is only
            // unique within a turn. Prefixing with the turn's message id (a
            // UUID v4) makes it globally unique while keeping the single-column
            // PK and the `WHERE id = ?` delta-match path.
            let part_id = format!("{message_id}/{block_id}");
            sqlx::query(
                "INSERT OR IGNORE INTO message_parts \
                 (id, message_id, idx, kind, content, created_at) \
                 VALUES (?, ?, ?, ?, '', ?)",
            )
            .bind(&part_id)
            .bind(&message_id)
            .bind(*index as i64)
            .bind(part_kind_to_str(&kind))
            .bind(&now)
            .execute(&mut **tx)
            .await?;
        }
        ProviderEvent::ContentDelta { block_id, content, .. }
        | ProviderEvent::ReasoningDelta { block_id, content, .. } => {
            let message_id = ensure_message_row_in_txn(tx, conversation_id, request_id).await?;
            let part_id = format!("{message_id}/{block_id}");
            sqlx::query(
                "UPDATE message_parts SET content = COALESCE(content, '') || ? WHERE id = ?",
            )
            .bind(content)
            .bind(&part_id)
            .execute(&mut **tx)
            .await?;
        }
        ProviderEvent::ToolCallStart {
            tool_call_id, index, name, ..
        } => {
            let message_id = ensure_message_row_in_txn(tx, conversation_id, request_id).await?;
            let now = now_iso8601();
            let content = format!("Tool call: {name}");
            let part_id = format!("{message_id}/{tool_call_id}");
            sqlx::query(
                "INSERT OR IGNORE INTO message_parts \
                 (id, message_id, idx, kind, content, mime_type, tool_call_id, created_at) \
                 VALUES (?, ?, ?, 'text', ?, 'application/x-tool-call', ?, ?)",
            )
            .bind(&part_id)
            .bind(&message_id)
            .bind(*index as i64)
            .bind(&content)
            .bind(tool_call_id)
            .bind(&now)
            .execute(&mut **tx)
            .await?;
        }
        ProviderEvent::MessageComplete { finish_reason, .. } => {
            sqlx::query(
                "UPDATE messages SET finalized = 1, finish_reason = ? WHERE request_id = ?",
            )
            .bind(finish_reason)
            .bind(request_id)
            .execute(&mut **tx)
            .await?;
        }
        ProviderEvent::Error { .. } => {
            sqlx::query(
                "UPDATE messages SET finalized = 1, finish_reason = 'error' WHERE request_id = ?",
            )
            .bind(request_id)
            .execute(&mut **tx)
            .await?;
        }
        // ContentBlockStop, ToolCallDelta, ToolCallComplete, Usage, Ping: no
        // view change (matches stream_persistence::apply_to_message `_ => {}`).
        _ => {}
    }
    Ok(())
}

/// Convenience wrapper: apply one event to the view in its own transaction.
/// The stream path (M3) uses `event_log::append_and_apply` instead, which folds
/// the append and the view update into one transaction.
pub async fn apply_event_to_view(
    pool: &SqlitePool,
    conversation_id: &str,
    request_id: &str,
    event: &ProviderEvent,
) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;
    apply_event_in_txn(&mut tx, conversation_id, request_id, event).await?;
    tx.commit().await?;
    Ok(())
}

/// Mark the assistant turn for `request_id` interrupted (cancel path / recovery).
/// Sets `interrupted_at`, `finalized = 1`, `finish_reason = 'cancelled'`. No-op
/// if no message row exists for the request (recovery handles that case by
/// folding first).
pub async fn mark_interrupted_by_request(
    pool: &SqlitePool,
    request_id: &str,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE messages SET interrupted_at = ?, finalized = 1, finish_reason = 'cancelled' \
         WHERE request_id = ?",
    )
    .bind(now_iso8601())
    .bind(request_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Look up the message id backing an assistant turn, if any.
pub async fn get_message_id_by_request(
    pool: &SqlitePool,
    request_id: &str,
) -> Result<Option<String>, DbError> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT id FROM messages WHERE request_id = ?")
            .bind(request_id)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(id,)| id))
}

// --- request-message persistence (user / system / developer messages) ---------

/// Persist the non-assistant messages carried in a `ProviderRequest`, so the
/// conversation reloads fully from SQLite after restart. Assistant turns are
/// **not** persisted here — they are owned by the event-log fold, which
/// generates a server-side message id that will not match the request's history
/// id. `INSERT OR IGNORE` makes this idempotent across turns (re-sent history is
/// skipped). Tool messages are left for the Phase 4 MCP runtime.
pub async fn persist_request_messages(
    pool: &SqlitePool,
    messages: &[Message],
) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;
    for msg in messages {
        upsert_request_message_in_txn(&mut tx, msg).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn upsert_request_message_in_txn(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    msg: &Message,
) -> Result<(), DbError> {
    if matches!(msg.role, MessageRole::Assistant | MessageRole::Tool) {
        return Ok(());
    }

    let res = sqlx::query(
        "INSERT OR IGNORE INTO messages \
         (id, conversation_id, role, author_label, provider_message_id, request_id, \
          interrupted_at, finalized, finish_reason, metadata, created_at) \
         VALUES (?, ?, ?, ?, ?, NULL, ?, 0, NULL, ?, ?)",
    )
    .bind(&msg.id)
    .bind(&msg.conversation_id)
    .bind(role_to_str(&msg.role))
    .bind(&msg.author_label)
    .bind(&msg.provider_message_id)
    .bind(&msg.interrupted_at)
    .bind(msg.metadata.as_ref().map(|v| v.to_string()))
    .bind(&msg.created_at)
    .execute(&mut **tx)
    .await?;

    // Only write parts for a newly-inserted row; an existing row (re-sent
    // history from a later turn) already has its parts.
    if res.rows_affected() > 0 {
        for part in &msg.parts {
            insert_part_in_txn(tx, part).await?;
        }
    }
    Ok(())
}

// --- view snapshot (for the M3 reconciliation check) -------------------------

/// A snapshot of the materialized view for one assistant turn, used by
/// `reconcile::reconcile_all` to compare the persisted view against
/// `fold(events)`.
pub struct ViewSnapshot {
    pub finalized: bool,
    pub finish_reason: Option<String>,
    pub parts: Vec<MessagePart>,
}

/// Snapshot the view backing `request_id`, or `None` if no message row exists.
pub async fn snapshot_view_for_request(
    pool: &SqlitePool,
    request_id: &str,
) -> Result<Option<ViewSnapshot>, DbError> {
    let row: Option<(String, i64, Option<String>)> =
        sqlx::query_as("SELECT id, finalized, finish_reason FROM messages WHERE request_id = ?")
            .bind(request_id)
            .fetch_optional(pool)
            .await?;
    let Some((message_id, finalized, finish_reason)) = row else {
        return Ok(None);
    };

    let part_rows: Vec<(
        String, String, i64, String, Option<String>, Option<String>, Option<String>,
        Option<String>, Option<String>, Option<String>, Option<String>, String,
    )> = sqlx::query_as(
        "SELECT id, message_id, idx, kind, content, mime_type, tool_call_id, \
                artifact_id, attachment_id, blob_ref, metadata, created_at \
         FROM message_parts WHERE message_id = ? ORDER BY idx",
    )
    .bind(&message_id)
    .fetch_all(pool)
    .await?;

    let mut parts = Vec::with_capacity(part_rows.len());
    for (id, message_id, idx, kind, content, mime_type, tool_call_id, artifact_id,
        attachment_id, blob_ref, metadata, created_at) in part_rows
    {
        parts.push(MessagePart {
            id,
            message_id,
            index: idx.max(0) as u32,
            kind: part_kind_from_str(&kind)?,
            content,
            mime_type,
            tool_call_id,
            artifact_id,
            attachment_id,
            blob_ref,
            metadata: metadata.and_then(|s| serde_json::from_str(&s).ok()),
            created_at,
        });
    }

    Ok(Some(ViewSnapshot {
        finalized: finalized != 0,
        finish_reason,
        parts,
    }))
}

// --- whole-message write (user/system messages, tests, rebuild) --------------

/// Insert a complete `Message` + its parts in one transaction. `request_id` is
/// left NULL (this is for user/system/manual messages; assistant turns get their
/// row via the event-log fold).
pub async fn insert_message(pool: &SqlitePool, msg: &Message) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;
    insert_message_in_txn(&mut tx, msg).await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn insert_message_in_txn(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    msg: &Message,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO messages \
         (id, conversation_id, role, author_label, provider_message_id, request_id, \
          interrupted_at, finalized, finish_reason, metadata, created_at) \
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)",
    )
    .bind(&msg.id)
    .bind(&msg.conversation_id)
    .bind(role_to_str(&msg.role))
    .bind(&msg.author_label)
    .bind(&msg.provider_message_id)
    .bind(&msg.interrupted_at)
    .bind(0_i64) // finalized: manual inserts are never in-progress
    .bind(msg.metadata.as_ref().map(|v| v.to_string()))
    .bind(&msg.created_at)
    .execute(&mut **tx)
    .await?;

    for part in &msg.parts {
        insert_part_in_txn(tx, part).await?;
    }
    Ok(())
}

async fn insert_part_in_txn(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    part: &MessagePart,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO message_parts \
         (id, message_id, idx, kind, content, mime_type, tool_call_id, artifact_id, \
          attachment_id, blob_ref, metadata, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&part.id)
    .bind(&part.message_id)
    .bind(part.index as i64)
    .bind(part_kind_to_str(&part.kind))
    .bind(&part.content)
    .bind(&part.mime_type)
    .bind(&part.tool_call_id)
    .bind(&part.artifact_id)
    .bind(&part.attachment_id)
    .bind(&part.blob_ref)
    .bind(part.metadata.as_ref().map(|v| v.to_string()))
    .bind(&part.created_at)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Replace all parts for `message_id` and set finalization, in one transaction.
/// Used by `fold::rebuild_view_from_log` (the repair path). Turn-level metadata
/// (created_at, interrupted_at) on the message row is preserved.
pub(crate) async fn replace_view_in_txn(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    message_id: &str,
    parts: &[MessagePart],
    finalized: bool,
    finish_reason: Option<&str>,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM message_parts WHERE message_id = ?")
        .bind(message_id)
        .execute(&mut **tx)
        .await?;
    for part in parts {
        insert_part_in_txn(tx, part).await?;
    }
    sqlx::query("UPDATE messages SET finalized = ?, finish_reason = ? WHERE id = ?")
        .bind(finalized as i64)
        .bind(finish_reason)
        .bind(message_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

// --- read path ---------------------------------------------------------------

/// Load all messages for a conversation with their parts, ordered by `created_at`
/// ascending (lexicographic ISO-8601 order — the H2/L3 invariant). Replaces
/// `stream_persistence::load_conversation_messages`.
pub async fn load_conversation_messages(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Vec<Message>, DbError> {
    let message_rows: Vec<(
        String, String, String, Option<String>, Option<String>, Option<String>,
        i64, Option<String>, Option<String>, String,
    )> = sqlx::query_as(
        "SELECT id, conversation_id, role, author_label, provider_message_id, \
                interrupted_at, finalized, finish_reason, metadata, created_at \
         FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;

    if message_rows.is_empty() {
        return Ok(Vec::new());
    }

    let part_rows: Vec<(
        String, String, i64, String, Option<String>, Option<String>, Option<String>,
        Option<String>, Option<String>, Option<String>, Option<String>, String,
    )> = sqlx::query_as(
        "SELECT id, message_id, idx, kind, content, mime_type, tool_call_id, \
                artifact_id, attachment_id, blob_ref, metadata, created_at \
         FROM message_parts WHERE message_id IN \
         (SELECT id FROM messages WHERE conversation_id = ?) \
         ORDER BY message_id, idx",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;

    use std::collections::HashMap;
    let mut parts_by_message: HashMap<String, Vec<MessagePart>> = HashMap::new();
    for (
        id, message_id, idx, kind, content, mime_type, tool_call_id, artifact_id,
        attachment_id, blob_ref, metadata, created_at,
    ) in part_rows
    {
        parts_by_message.entry(message_id).or_default().push(MessagePart {
            id,
            message_id: String::new(), // filled below from the grouping key
            index: idx.max(0) as u32,
            kind: part_kind_from_str(&kind)?,
            content,
            mime_type,
            tool_call_id,
            artifact_id,
            attachment_id,
            blob_ref,
            metadata: metadata.and_then(|s| serde_json::from_str(&s).ok()),
            created_at,
        });
    }

    let mut messages = Vec::with_capacity(message_rows.len());
    for (
        id, conversation_id, role, author_label, provider_message_id, interrupted_at,
        _finalized, _finish_reason, metadata, created_at,
    ) in message_rows
    {
        let mut parts = parts_by_message.remove(&id).unwrap_or_default();
        for part in &mut parts {
            part.message_id = id.clone();
        }
        messages.push(Message {
            id,
            conversation_id,
            role: role_from_str(&role)?,
            author_label,
            provider_message_id,
            interrupted_at,
            metadata: metadata.and_then(|s| serde_json::from_str(&s).ok()),
            parts,
            created_at,
        });
    }
    Ok(messages)
}