//! Reply versions: Retry keeps the earlier reply instead of deleting it.
//!
//! A reply is every message row after a user message, up to the next user
//! message. Retrying the last reply marks its rows `superseded_at` and tags
//! them with `retry_of_message_id` (the user message) and `retry_sequence`
//! (which version); the new reply is written as usual. Every read of the thread
//! skips superseded rows (`messages::load_conversation_messages`), so export,
//! fork, compaction and the chat itself see only the version in use.
//!
//! Versions are numbered by `retry_sequence`. The reply in use has sequence 0
//! until it is first superseded, and 0 always sorts last: it is the newest.

use serde::Serialize;
use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::{db::DbError, time::now_iso8601};

/// How many versions the reply to `user_message_id` has, and which one the
/// chat uses (1-based, in the order they were written; 0 when none is).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplyVersionInfo {
    pub user_message_id: String,
    pub count: u32,
    pub current: u32,
}

/// The versions of `user_message_id`'s reply in order, as sequences, and the
/// index of the one in use. 0 stands for a reply in use never superseded.
async fn version_order(
    tx: &mut Transaction<'_, Sqlite>,
    conversation_id: &str,
    user_message_id: &str,
) -> Result<(Vec<i64>, Option<usize>), DbError> {
    let hidden: Vec<(i64,)> = sqlx::query_as(
        "SELECT DISTINCT retry_sequence FROM messages \
         WHERE conversation_id = ? AND retry_of_message_id = ? AND superseded_at IS NOT NULL \
         ORDER BY retry_sequence",
    )
    .bind(conversation_id)
    .bind(user_message_id)
    .fetch_all(&mut **tx)
    .await?;
    let live = live_reply_ids(tx, conversation_id, user_message_id).await?;
    let mut order: Vec<i64> = hidden.into_iter().map(|(s,)| s).collect();
    if live.is_empty() {
        return Ok((order, None));
    }
    let live_seq = live_sequence(tx, &live).await?;
    order.push(live_seq);
    order.sort_by_key(|s| if *s == 0 { i64::MAX } else { *s });
    let current = order.iter().position(|s| *s == live_seq);
    Ok((order, current))
}

/// The ids of the reply in use after `user_message_id`: every live row after
/// it up to the next live user message.
async fn live_reply_ids(
    tx: &mut Transaction<'_, Sqlite>,
    conversation_id: &str,
    user_message_id: &str,
) -> Result<Vec<String>, DbError> {
    let rows: Vec<(String, String)> = sqlx::query_as(
        "SELECT id, role FROM messages \
         WHERE conversation_id = ? AND superseded_at IS NULL \
           AND created_at > (SELECT created_at FROM messages WHERE id = ?) \
         ORDER BY created_at ASC",
    )
    .bind(conversation_id)
    .bind(user_message_id)
    .fetch_all(&mut **tx)
    .await?;
    Ok(rows
        .into_iter()
        .take_while(|(_, role)| role != "user")
        .map(|(id, _)| id)
        .collect())
}

async fn live_sequence(tx: &mut Transaction<'_, Sqlite>, ids: &[String]) -> Result<i64, DbError> {
    let mut seq = 0;
    for id in ids {
        let (s,): (i64,) = sqlx::query_as("SELECT retry_sequence FROM messages WHERE id = ?")
            .bind(id)
            .fetch_one(&mut **tx)
            .await?;
        seq = seq.max(s);
    }
    Ok(seq)
}

/// Hide the reply in use after `user_message_id`, giving it a sequence if it
/// has none yet.
async fn supersede_live(
    tx: &mut Transaction<'_, Sqlite>,
    conversation_id: &str,
    user_message_id: &str,
) -> Result<(), DbError> {
    let live = live_reply_ids(tx, conversation_id, user_message_id).await?;
    if live.is_empty() {
        return Ok(());
    }
    let mut seq = live_sequence(tx, &live).await?;
    if seq == 0 {
        let (max,): (i64,) = sqlx::query_as(
            "SELECT COALESCE(MAX(retry_sequence), 0) FROM messages \
             WHERE conversation_id = ? AND retry_of_message_id = ?",
        )
        .bind(conversation_id)
        .bind(user_message_id)
        .fetch_one(&mut **tx)
        .await?;
        seq = max + 1;
    }
    let now = now_iso8601();
    for id in &live {
        sqlx::query(
            "UPDATE messages SET superseded_at = ?, retry_of_message_id = ?, retry_sequence = ? \
             WHERE id = ?",
        )
        .bind(&now)
        .bind(user_message_id)
        .bind(seq)
        .bind(id)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// The last live user message of the conversation.
async fn last_user_message(
    tx: &mut Transaction<'_, Sqlite>,
    conversation_id: &str,
) -> Result<Option<String>, DbError> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM messages \
         WHERE conversation_id = ? AND role = 'user' AND superseded_at IS NULL \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(conversation_id)
    .fetch_optional(&mut **tx)
    .await?;
    Ok(row.map(|(id,)| id))
}

/// Before a retry: keep the last reply as an earlier version. Returns the user
/// message the retry answers again, or `None` when the chat has none.
pub async fn prepare_retry(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Option<String>, DbError> {
    let mut tx = pool.begin().await?;
    let Some(user_message_id) = last_user_message(&mut tx, conversation_id).await? else {
        return Ok(None);
    };
    supersede_live(&mut tx, conversation_id, &user_message_id).await?;
    tx.commit().await?;
    Ok(Some(user_message_id))
}

/// Every reply in the conversation that has more than one version, or kept
/// versions but none in use.
pub async fn list(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Vec<ReplyVersionInfo>, DbError> {
    let mut tx = pool.begin().await?;
    let users: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT retry_of_message_id FROM messages \
         WHERE conversation_id = ? AND superseded_at IS NOT NULL \
           AND retry_of_message_id IS NOT NULL",
    )
    .bind(conversation_id)
    .fetch_all(&mut *tx)
    .await?;
    let mut out = Vec::new();
    for (user_message_id,) in users {
        let (order, current) = version_order(&mut tx, conversation_id, &user_message_id).await?;
        // `current` 0: no reply in use, as when a retry failed before writing
        // anything. The frontend then puts the latest version back.
        let current = current.map_or(0, |i| i as u32 + 1);
        if order.len() > 1 || current == 0 {
            out.push(ReplyVersionInfo {
                user_message_id,
                count: order.len() as u32,
                current,
            });
        }
    }
    tx.commit().await?;
    Ok(out)
}

/// Make version `position` (1-based) the reply the chat uses. Only the last
/// reply can switch: an earlier one has later messages written from it.
pub async fn select(
    pool: &SqlitePool,
    conversation_id: &str,
    user_message_id: &str,
    position: u32,
) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;
    if last_user_message(&mut tx, conversation_id)
        .await?
        .as_deref()
        != Some(user_message_id)
    {
        return Err(DbError::Query(
            "only the last reply can switch versions".into(),
        ));
    }
    let (order, current) = version_order(&mut tx, conversation_id, user_message_id).await?;
    let index = (position as usize)
        .checked_sub(1)
        .filter(|i| *i < order.len())
        .ok_or_else(|| DbError::Query("no such reply version".into()))?;
    if current == Some(index) {
        return Ok(());
    }
    supersede_live(&mut tx, conversation_id, user_message_id).await?;
    sqlx::query(
        "UPDATE messages SET superseded_at = NULL \
         WHERE conversation_id = ? AND retry_of_message_id = ? AND retry_sequence = ?",
    )
    .bind(conversation_id)
    .bind(user_message_id)
    .bind(order[index])
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// The hidden versions answering any of `user_message_ids`, as
/// `(message id, turn key)` where the turn key is the request id (or the
/// message id), for deleting them with their tool calls and event log.
pub(crate) async fn superseded_for(
    tx: &mut Transaction<'_, Sqlite>,
    conversation_id: &str,
    user_message_ids: &[String],
) -> Result<Vec<(String, String)>, DbError> {
    let mut out = Vec::new();
    for user_message_id in user_message_ids {
        let rows: Vec<(String, String)> = sqlx::query_as(
            "SELECT id, COALESCE(request_id, id) FROM messages \
             WHERE conversation_id = ? AND retry_of_message_id = ? AND superseded_at IS NOT NULL",
        )
        .bind(conversation_id)
        .bind(user_message_id)
        .fetch_all(&mut **tx)
        .await?;
        out.extend(rows);
    }
    Ok(out)
}
