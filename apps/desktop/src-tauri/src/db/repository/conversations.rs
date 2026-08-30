//! `conversations` repository (M2).
//!
//! A conversation is a row with a stable local UUID id; messages, parts, and the
//! event log cascade-delete with it. `list` derives a `ConversationSummary`
//! (message count + last text preview) in one query so the history rail renders
//! without a second round-trip.

use std::path::Path;

use provider_core::schema::{Conversation, ConversationSummary};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{
    db::{
        repository::{artifacts, attachments},
        DbError,
    },
    message_preview::summarize_message_content_for_preview,
    time::now_iso8601,
};

/// Row shape for [`list`] (id, title, updated_at, message_count, last preview, first user prompt, fork columns).
type ConversationSummaryRow = (
    String,
    Option<String>,
    String,
    i64,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// Row shape for [`get`] (id, title, created_at, updated_at, cloud_id, metadata, workspace_root).
type ConversationRow = (
    String,
    Option<String>,
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
);

const DISPLAY_TITLE_MAX_CHARS: usize = 60;

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
        workspace_root: None,
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
                   ORDER BY m2.created_at DESC, mp.idx ASC LIMIT 1) AS last_message_preview, \
                (SELECT mp.content FROM messages um \
                   JOIN message_parts mp ON mp.message_id = um.id \
                   WHERE um.conversation_id = c.id AND um.role = 'user' \
                     AND mp.kind = 'text' AND mp.content IS NOT NULL AND TRIM(mp.content) != '' \
                   ORDER BY um.created_at ASC, mp.idx ASC LIMIT 1) AS first_user_prompt, \
                c.forked_from_conversation_id \
         FROM conversations c \
         ORDER BY c.updated_at DESC",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                title,
                updated_at,
                message_count,
                last_message_preview,
                first_user_prompt,
                forked_from,
            )| {
                ConversationSummary {
                    id,
                    display_title: resolve_display_title(
                        title.as_deref(),
                        first_user_prompt.as_deref(),
                    ),
                    title,
                    updated_at,
                    message_count: message_count.max(0) as u32,
                    last_message_preview: last_message_preview
                        .as_deref()
                        .and_then(summarize_message_content_for_preview),
                    forked_from_conversation_id: forked_from,
                }
            },
        )
        .collect())
}

/// Fetch one conversation, or `None` if it does not exist.
pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<Conversation>, DbError> {
    let row: Option<ConversationRow> = sqlx::query_as(
        "SELECT id, title, created_at, updated_at, cloud_id, metadata, workspace_root \
             FROM conversations WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(
        |(id, title, created_at, updated_at, cloud_id, metadata, workspace_root)| Conversation {
            id,
            title,
            created_at,
            updated_at,
            cloud_id,
            metadata: metadata.and_then(|s| serde_json::from_str(&s).ok()),
            workspace_root,
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

/// Delete a conversation and remove associated artifact/attachment files from disk.
pub async fn delete_with_files(
    pool: &SqlitePool,
    artifacts_dir: &Path,
    attachments_dir: &Path,
    id: &str,
) -> Result<(), DbError> {
    let artifact_refs = artifacts::list_file_refs_for_conversation(pool, id).await?;
    let attachment_refs = attachments::list_blob_refs_for_conversation(pool, id).await?;

    delete(pool, id).await?;

    artifacts::remove_artifact_files(artifacts_dir, &artifact_refs);
    attachments::remove_blobs_if_unreferenced(pool, attachments_dir, &attachment_refs).await?;

    Ok(())
}

/// Delete every conversation and remove associated artifact/attachment files.
pub async fn delete_all_with_files(
    pool: &SqlitePool,
    artifacts_dir: &Path,
    attachments_dir: &Path,
) -> Result<(), DbError> {
    let artifact_refs = artifacts::list_all_file_refs(pool).await?;
    let attachment_refs = attachments::list_all_blob_refs(pool).await?;

    sqlx::query("DELETE FROM conversations")
        .execute(pool)
        .await?;

    artifacts::remove_artifact_files(artifacts_dir, &artifact_refs);
    attachments::remove_blobs_if_unreferenced(pool, attachments_dir, &attachment_refs).await?;

    Ok(())
}

/// Set or clear the workspace folder bound to this conversation.
pub async fn set_workspace_root(
    pool: &SqlitePool,
    id: &str,
    workspace_root: Option<&str>,
) -> Result<(), DbError> {
    let root = workspace_root
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    sqlx::query("UPDATE conversations SET workspace_root = ?, updated_at = ? WHERE id = ?")
        .bind(root)
        .bind(now_iso8601())
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

/// Set (or clear) the explicit conversation title used by the history rail.
pub async fn set_title(pool: &SqlitePool, id: &str, title: &str) -> Result<(), DbError> {
    let trimmed = title.trim();
    let value = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    };
    sqlx::query("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
        .bind(value)
        .bind(now_iso8601())
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

/// Resolve the history-rail label: explicit title, else first user prompt, else fallback.
pub fn resolve_display_title(title: Option<&str>, first_user_prompt: Option<&str>) -> String {
    if let Some(t) = title.map(str::trim).filter(|t| !t.is_empty()) {
        return truncate_chars(t, DISPLAY_TITLE_MAX_CHARS);
    }
    if let Some(prompt) = first_user_prompt {
        let normalized = normalize_whitespace(prompt);
        if !normalized.is_empty() {
            return truncate_chars(&normalized, DISPLAY_TITLE_MAX_CHARS);
        }
    }
    "Untitled chat".to_string()
}

fn normalize_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let truncated: String = s.chars().take(max).collect();
    format!("{truncated}…")
}

// ---------------------------------------------------------------------------
// Retry & Fork support (Competitive Feature)
// ---------------------------------------------------------------------------

/// Get the request_id of the most recent assistant turn, if any.
/// In the real stream pipeline, the request_id is set by the event-log fold.
/// For messages inserted via `insert_message_in_txn`, request_id may be NULL.
pub async fn last_assistant_request_id(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Option<String>, DbError> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT COALESCE(request_id, id) FROM messages \
         WHERE conversation_id = ? AND role = 'assistant' \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(conversation_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(r,)| r))
}

/// Remove the last assistant turn (messages, parts, event log, tool calls)
/// in a transaction. Returns the turn identifier (request_id or message id)
/// of the removed turn, or None if the conversation has no assistant turns.
pub async fn remove_last_assistant_turn(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Option<String>, DbError> {
    let turn_id = last_assistant_request_id(pool, conversation_id).await?;
    if let Some(ref tid) = turn_id {
        let mut tx = pool.begin().await?;
        // Delete tool calls for this request_id (match by request_id or id)
        sqlx::query("DELETE FROM tool_calls WHERE request_id = ?")
            .bind(tid)
            .execute(&mut *tx)
            .await?;
        // Delete event log rows for this turn
        sqlx::query("DELETE FROM provider_event_log WHERE conversation_id = ? AND request_id = ?")
            .bind(conversation_id)
            .bind(tid)
            .execute(&mut *tx)
            .await?;
        // Delete message (message_parts cascade via FK). Match by request_id
        // or message id (for manually-inserted messages without request_id).
        sqlx::query(
            "DELETE FROM messages WHERE conversation_id = ? AND (request_id = ? OR id = ?)",
        )
        .bind(conversation_id)
        .bind(tid)
        .bind(tid)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    }
    Ok(turn_id)
}

/// Create a fork of a conversation up to a specific message.
/// Copies the source conversation's messages up to and including
/// `fork_point_message_id` into a new conversation with branch metadata.
pub async fn fork_at(
    pool: &SqlitePool,
    source_conversation_id: &str,
    fork_point_message_id: &str,
    fork_label: Option<&str>,
) -> Result<Conversation, DbError> {
    use crate::db::repository::messages;

    // Load the source messages + parts into memory FIRST (before opening the
    // transaction) to avoid holding the pool's only connection while reading.
    let source_msgs = messages::load_conversation_messages(pool, source_conversation_id).await?;
    // Keep messages up to and including the fork point
    let cutoff = source_msgs
        .iter()
        .find(|m| m.id == fork_point_message_id)
        .map(|m| m.created_at.clone())
        .ok_or_else(|| DbError::Query("fork point message not found".into()))?;
    let to_copy: Vec<&provider_core::schema::Message> = source_msgs
        .iter()
        .filter(|m| m.created_at <= cutoff)
        .collect();

    let source = get(pool, source_conversation_id)
        .await?
        .ok_or_else(|| DbError::Query("source conversation not found".into()))?;

    let mut tx = pool.begin().await?;

    let fork_id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    let label = fork_label.unwrap_or("Fork");

    sqlx::query(
        "INSERT INTO conversations \
         (id, title, forked_from_conversation_id, fork_point_message_id, \
          workspace_root, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&fork_id)
    .bind(label)
    .bind(source_conversation_id)
    .bind(fork_point_message_id)
    .bind(&source.workspace_root)
    .bind(&now)
    .bind(&now)
    .execute(&mut *tx)
    .await?;

    messages::insert_copied_messages_in_txn(&mut tx, &fork_id, &to_copy).await?;

    tx.commit().await?;

    Ok(Conversation {
        id: fork_id,
        title: Some(label.to_string()),
        created_at: now.clone(),
        updated_at: now,
        cloud_id: None,
        metadata: None,
        workspace_root: source.workspace_root,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_display_title_prefers_explicit_title() {
        assert_eq!(
            resolve_display_title(Some("My chat"), Some("first prompt")),
            "My chat"
        );
    }

    #[test]
    fn resolve_display_title_uses_first_user_prompt_when_untitled() {
        assert_eq!(
            resolve_display_title(None, Some("How do I refactor this module?")),
            "How do I refactor this module?"
        );
    }

    #[test]
    fn resolve_display_title_normalizes_and_truncates_prompt() {
        let long = "word ".repeat(30);
        let resolved = resolve_display_title(None, Some(&long));
        assert!(resolved.ends_with('…'));
        assert!(resolved.chars().count() <= DISPLAY_TITLE_MAX_CHARS + 1);
    }

    #[test]
    fn resolve_display_title_falls_back_when_empty() {
        assert_eq!(resolve_display_title(None, None), "Untitled chat");
        assert_eq!(
            resolve_display_title(Some("   "), Some("   ")),
            "Untitled chat"
        );
    }
}
