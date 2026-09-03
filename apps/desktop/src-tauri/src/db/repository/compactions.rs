//! Conversation compaction journal (t1-3).
//!
//! Raw messages stay forever. The latest row per conversation is applied when
//! loading the thread UI and when building the next provider request.

use sqlx::SqlitePool;
use thiserror::Error;
use uuid::Uuid;

use crate::time::now_iso8601;

#[derive(Debug, Error)]
pub enum CompactionError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationCompaction {
    pub id: String,
    pub conversation_id: String,
    pub created_at: String,
    pub summary_text: String,
    pub through_message_id: String,
    pub kept_from_message_id: String,
    pub model_id: String,
    pub token_estimate_before: i64,
    pub token_estimate_after: i64,
}

/// Columns for insert (id/created_at assigned here).
pub struct NewConversationCompaction<'a> {
    pub conversation_id: &'a str,
    pub summary_text: &'a str,
    pub through_message_id: &'a str,
    pub kept_from_message_id: &'a str,
    pub model_id: &'a str,
    pub token_estimate_before: i64,
    pub token_estimate_after: i64,
}

type CompactionRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
);

pub async fn insert(
    pool: &SqlitePool,
    new: NewConversationCompaction<'_>,
) -> Result<ConversationCompaction, CompactionError> {
    let row = ConversationCompaction {
        id: Uuid::new_v4().to_string(),
        conversation_id: new.conversation_id.to_string(),
        created_at: now_iso8601(),
        summary_text: new.summary_text.to_string(),
        through_message_id: new.through_message_id.to_string(),
        kept_from_message_id: new.kept_from_message_id.to_string(),
        model_id: new.model_id.to_string(),
        token_estimate_before: new.token_estimate_before,
        token_estimate_after: new.token_estimate_after,
    };
    sqlx::query(
        "INSERT INTO conversation_compactions \
         (id, conversation_id, created_at, summary_text, through_message_id, \
          kept_from_message_id, model_id, token_estimate_before, token_estimate_after) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&row.id)
    .bind(&row.conversation_id)
    .bind(&row.created_at)
    .bind(&row.summary_text)
    .bind(&row.through_message_id)
    .bind(&row.kept_from_message_id)
    .bind(&row.model_id)
    .bind(row.token_estimate_before)
    .bind(row.token_estimate_after)
    .execute(pool)
    .await?;
    Ok(row)
}

/// Latest compaction for a conversation, if any.
pub async fn latest_for_conversation(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Option<ConversationCompaction>, CompactionError> {
    let row: Option<CompactionRow> = sqlx::query_as(
        "SELECT id, conversation_id, created_at, summary_text, through_message_id, \
                kept_from_message_id, model_id, token_estimate_before, token_estimate_after \
         FROM conversation_compactions \
         WHERE conversation_id = ? \
         ORDER BY created_at DESC, rowid DESC \
         LIMIT 1",
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(
        |(
            id,
            conversation_id,
            created_at,
            summary_text,
            through_message_id,
            kept_from_message_id,
            model_id,
            token_estimate_before,
            token_estimate_after,
        )| ConversationCompaction {
            id,
            conversation_id,
            created_at,
            summary_text,
            through_message_id,
            kept_from_message_id,
            model_id,
            token_estimate_before,
            token_estimate_after,
        },
    ))
}
