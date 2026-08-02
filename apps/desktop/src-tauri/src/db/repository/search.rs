//! FTS5 full-text search for messages.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::db::DbError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub message_id: String,
    pub conversation_id: String,
    pub conversation_title: Option<String>,
    pub role: String,
    pub snippet: String,
    pub match_start: usize,
    pub match_end: usize,
    pub created_at: String,
}

/// Search all messages using FTS5. Returns up to `limit` results ordered by
/// relevance rank (bm25). Supports FTS5 query syntax: prefix (`search*`),
/// phrase (`"exact phrase"`), `AND`/`OR`, `NOT`.
pub async fn search_messages(
    pool: &SqlitePool,
    query: &str,
    limit: i64,
) -> Result<Vec<SearchResult>, DbError> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    // Use the snippet() function to extract match context with <mark> tags.
    // We then parse the offsets ourselves for the TS-side highlight.
    let rows: Vec<(String, String, Option<String>, String, String, String)> = sqlx::query_as(
        r#"
        SELECT
            f.message_id,
            f.conversation_id,
            c.title AS conversation_title,
            f.role,
            snippet(message_fts, 0, '<mark>', '</mark>', '…', 40) AS snippet,
            m.created_at
        FROM message_fts f
        JOIN messages m ON m.id = f.message_id
        LEFT JOIN conversations c ON c.id = f.conversation_id
        WHERE message_fts MATCH ?
        ORDER BY rank
        LIMIT ?
        "#,
    )
    .bind(trimmed)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let results = rows
        .into_iter()
        .map(
            |(message_id, conversation_id, conversation_title, role, snippet, created_at)| {
                let mark_start = "<mark>";
                let mark_end = "</mark>";
                let start = snippet
                    .find(mark_start)
                    .map(|i| i + mark_start.len())
                    .unwrap_or(0);
                let end = snippet.find(mark_end).unwrap_or(snippet.len());
                let clean_snippet = snippet.replace(mark_start, "").replace(mark_end, "");
                SearchResult {
                    message_id,
                    conversation_id,
                    conversation_title,
                    role,
                    snippet: clean_snippet,
                    match_start: start,
                    match_end: end,
                    created_at,
                }
            },
        )
        .collect();

    Ok(results)
}

/// Rebuild the FTS5 index from scratch for all existing `message_parts` rows.
/// Idempotent — safe to call on every startup (checks for existing data first).
pub async fn reindex_all(pool: &SqlitePool) -> Result<(), DbError> {
    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_fts")
        .fetch_one(pool)
        .await?;
    if count > 0 {
        return Ok(()); // Already indexed
    }

    sqlx::query(
        r#"
        INSERT INTO message_fts(rowid, content, role, conversation_id, message_id)
        SELECT mp.rowid, mp.content, m.role, m.conversation_id, mp.message_id
        FROM message_parts mp
        JOIN messages m ON m.id = mp.message_id
        WHERE mp.kind = 'text'
          AND mp.content IS NOT NULL
          AND mp.content != ''
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::tests::pool;
    use uuid::Uuid;

    fn now() -> String {
        crate::time::now_iso8601()
    }

    async fn insert_test_data(pool: &SqlitePool) -> (String, String) {
        let conv_id = Uuid::new_v4().to_string();
        let msg_id = Uuid::new_v4().to_string();

        // Insert conversation
        sqlx::query(
            "INSERT INTO conversations (id, created_at, updated_at, title) VALUES (?, ?, ?, ?)",
        )
        .bind(&conv_id)
        .bind(now())
        .bind(now())
        .bind("Test Conversation")
        .execute(pool)
        .await
        .unwrap();

        // Insert message
        sqlx::query(
            "INSERT INTO messages (id, conversation_id, role, created_at, finalized) VALUES (?, ?, ?, ?, 1)",
        )
        .bind(&msg_id)
        .bind(&conv_id)
        .bind("user")
        .bind(now())
        .execute(pool)
        .await
        .unwrap();

        // Insert a text part with searchable content
        sqlx::query(
            "INSERT INTO message_parts (id, message_id, idx, kind, content, created_at) VALUES (?, ?, ?, 'text', ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&msg_id)
        .bind(0i32)
        .bind("This is a test message about payment processing")
        .bind(now())
        .execute(pool)
        .await
        .unwrap();

        (conv_id, msg_id)
    }

    #[sqlx::test]
    async fn test_search_messages_finds_text() {
        let pool = pool().await;
        let (conv_id, _msg_id) = insert_test_data(&pool).await;

        // Reindex first
        reindex_all(&pool).await.unwrap();

        let results = search_messages(&pool, "payment", 10).await.unwrap();
        assert!(!results.is_empty(), "should find results for 'payment'");
        assert_eq!(results[0].conversation_id, conv_id);
        assert!(results[0].snippet.contains("payment"));
    }

    #[sqlx::test]
    async fn test_search_empty_query_returns_empty() {
        let pool = pool().await;
        let (_conv_id, _msg_id) = insert_test_data(&pool).await;
        reindex_all(&pool).await.unwrap();

        let results = search_messages(&pool, "", 10).await.unwrap();
        assert!(results.is_empty());
    }

    #[sqlx::test]
    async fn test_search_whitespace_query_returns_empty() {
        let pool = pool().await;
        let (_conv_id, _msg_id) = insert_test_data(&pool).await;
        reindex_all(&pool).await.unwrap();

        let results = search_messages(&pool, "   ", 10).await.unwrap();
        assert!(results.is_empty());
    }

    #[sqlx::test]
    async fn test_reindex_is_idempotent() {
        let pool = pool().await;
        insert_test_data(&pool).await;

        reindex_all(&pool).await.unwrap();
        let (c1,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_fts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert!(c1 > 0, "should have indexed data after first reindex");

        // Second call should be a no-op
        reindex_all(&pool).await.unwrap();
        let (c2,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM message_fts")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(c1, c2, "reindex should be idempotent");
    }

    #[sqlx::test]
    async fn test_search_no_match_returns_empty() {
        let pool = pool().await;
        let (_conv_id, _msg_id) = insert_test_data(&pool).await;
        reindex_all(&pool).await.unwrap();

        let results = search_messages(&pool, "zzzzzznonexistent", 10).await.unwrap();
        assert!(results.is_empty());
    }

    #[sqlx::test]
    async fn test_search_limits_results() {
        let pool = pool().await;
        let (conv_id, _msg_id) = insert_test_data(&pool).await;

        // Insert a second message
        let msg_id2 = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO messages (id, conversation_id, role, created_at, finalized) VALUES (?, ?, ?, ?, 1)",
        )
        .bind(&msg_id2)
        .bind(&conv_id)
        .bind("assistant")
        .bind(now())
        .execute(&pool)
        .await
        .unwrap();

        sqlx::query(
            "INSERT INTO message_parts (id, message_id, idx, kind, content, created_at) VALUES (?, ?, ?, 'text', ?, ?)",
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&msg_id2)
        .bind(0i32)
        .bind("Another message about payment methods")
        .bind(now())
        .execute(&pool)
        .await
        .unwrap();

        reindex_all(&pool).await.unwrap();

        let results = search_messages(&pool, "payment", 1).await.unwrap();
        assert_eq!(results.len(), 1, "limit=1 should return 1 result");
    }
}