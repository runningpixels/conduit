//! Per-conversation enabled Agent Skills (t1-4).
//!
//! Skill packages live on disk; this table only records which ids are on for
//! a chat. Rows cascade-delete with the conversation.

use sqlx::SqlitePool;

use crate::db::DbError;

pub async fn list_enabled(
    pool: &SqlitePool,
    conversation_id: &str,
) -> Result<Vec<String>, DbError> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT skill_id FROM conversation_skills WHERE conversation_id = ? ORDER BY skill_id",
    )
    .bind(conversation_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// Replace the enabled set for `conversation_id`. Unknown ids are stored so a
/// skill that disappears from disk can still be toggled off later.
pub async fn set_enabled(
    pool: &SqlitePool,
    conversation_id: &str,
    skill_ids: &[String],
) -> Result<Vec<String>, DbError> {
    let mut unique = Vec::new();
    for id in skill_ids {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            continue;
        }
        if crate::skills::parse_skill_id(trimmed).is_none() {
            return Err(DbError::Query(format!("invalid skill id {trimmed:?}")));
        }
        if !unique.iter().any(|e: &String| e == trimmed) {
            unique.push(trimmed.to_string());
        }
    }

    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM conversation_skills WHERE conversation_id = ?")
        .bind(conversation_id)
        .execute(&mut *tx)
        .await?;
    for id in &unique {
        sqlx::query("INSERT INTO conversation_skills (conversation_id, skill_id) VALUES (?, ?)")
            .bind(conversation_id)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(unique)
}
