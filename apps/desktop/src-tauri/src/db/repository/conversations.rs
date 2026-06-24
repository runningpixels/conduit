//! `conversations` repository (M2).
//!
//! A conversation is a row with a stable local UUID id; messages, parts, and the
//! event log cascade-delete with it. `list` derives a `ConversationSummary`
//! (message count + last text preview) in one query so the history rail renders
//! without a second round-trip.

use provider_core::schema::{Conversation, ConversationSummary};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{db::DbError, time::now_iso8601};

/// Row shape for [`list`] (id, title, updated_at, message_count, last preview).
type ConversationSummaryRow = (String, Option<String>, String, i64, Option<String>);

/// Row shape for [`get`] (id, title, created_at, updated_at, cloud_id, metadata).
type ConversationRow = (
    String,
    Option<String>,
    String,
    String,
    Option<String>,
    Option<String>,
);

/// Create a conversation row with a fresh UUID id. Returns the full row.
pub async fn create(pool: &SqlitePool, title: Option<&str>) -> Result<Conversation, DbError> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    let title = title.map(|t| t.trim()).filter(|t| !t.is_empty());

    sqlx::query(
        "INSERT INTO conversations (id, title, created_at, updated_at) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(title)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;

    Ok(Conversation {
        id,
        title: title.map(|s| s.to_string()),
        created_at: now.clone(),
        updated_at: now,
        cloud_id: None,
        metadata: None,
    })
}

/// List all conversations newest-first, with message count and a preview of the
/// last text part for the history rail.
pub async fn list(pool: &SqlitePool) -> Result<Vec<ConversationSummary>, DbError> {
    let rows: Vec<ConversationSummaryRow> = sqlx::query_as(
        "SELECT c.id, c.title, c.updated_at, \
                (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count, \
                (SELECT mp.content FROM messages m2 \
                   JOIN message_parts mp ON mp.message_id = m2.id \
                   WHERE m2.conversation_id = c.id AND mp.kind = 'text' AND mp.content IS NOT NULL \
                   ORDER BY m2.created_at DESC, mp.idx ASC LIMIT 1) AS last_message_preview \
         FROM conversations c \
         ORDER BY c.updated_at DESC",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(id, title, updated_at, message_count, last_message_preview)| ConversationSummary {
                id,
                title,
                updated_at,
                message_count: message_count.max(0) as u32,
                last_message_preview,
            },
        )
        .collect())
}

/// Fetch one conversation, or `None` if it does not exist.
pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<Conversation>, DbError> {
    let row: Option<ConversationRow> = sqlx::query_as(
        "SELECT id, title, created_at, updated_at, cloud_id, metadata \
             FROM conversations WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(
        |(id, title, created_at, updated_at, cloud_id, metadata)| Conversation {
            id,
            title,
            created_at,
            updated_at,
            cloud_id,
            metadata: metadata.and_then(|s| serde_json::from_str(&s).ok()),
        },
    ))
}

/// Delete a conversation; `messages`, `message_parts`, and `provider_event_log`
/// rows cascade-delete via FK `ON DELETE CASCADE`.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), DbError> {
    sqlx::query("DELETE FROM conversations WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Bump `updated_at` to now — called when a message is added to the conversation.
pub async fn touch(pool: &SqlitePool, id: &str) -> Result<(), DbError> {
    sqlx::query("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .bind(now_iso8601())
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Bump `updated_at` to an explicit timestamp. Used by the M3 backfill job,
/// which imports legacy turns with their original `created_at` so the history
/// rail orders them as they originally occurred (not all "now").
pub async fn touch_at(pool: &SqlitePool, id: &str, updated_at: &str) -> Result<(), DbError> {
    sqlx::query("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .bind(updated_at)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Ensure a conversation row exists for `id`, creating a title-less row if it
/// does not. Idempotent. The stream path calls this before writing events so a
/// request referencing a not-yet-persisted conversation id (e.g. a legacy or
/// frontend-generated id) does not violate the `messages.conversation_id` FK.
pub async fn ensure_exists(pool: &SqlitePool, id: &str) -> Result<(), DbError> {
    let now = now_iso8601();
    sqlx::query(
        "INSERT OR IGNORE INTO conversations (id, title, created_at, updated_at) \
         VALUES (?, NULL, ?, ?)",
    )
    .bind(id)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}
