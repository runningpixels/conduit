//! Unit tests for tool approval memory (t1-2 M3).

use conduit_desktop::db::repository::tool_approval_memory::{
    is_remembered, list_all, remember, revoke, ApprovalScope,
};
use sqlx::sqlite::SqlitePoolOptions;

async fn pool_with_schema() -> sqlx::SqlitePool {
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect("sqlite::memory:")
        .await
        .unwrap();
    sqlx::query(
        "CREATE TABLE tool_approval_memory (
          id TEXT PRIMARY KEY,
          tool_key TEXT NOT NULL,
          scope TEXT NOT NULL CHECK (scope IN ('conversation', 'always')),
          conversation_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_tool_approval_memory_always
          ON tool_approval_memory(tool_key) WHERE scope = 'always';
        CREATE UNIQUE INDEX idx_tool_approval_memory_conversation
          ON tool_approval_memory(tool_key, conversation_id)
          WHERE scope = 'conversation' AND conversation_id IS NOT NULL;",
    )
    .execute(&pool)
    .await
    .unwrap();
    pool
}

#[tokio::test]
async fn conversation_scope_does_not_leak_across_chats() {
    let pool = pool_with_schema().await;
    remember(
        &pool,
        "ver-1",
        "post_message",
        ApprovalScope::Conversation,
        Some("conv-a"),
    )
    .await
    .unwrap();
    assert!(
        is_remembered(&pool, "ver-1", "post_message", Some("conv-a"))
            .await
            .unwrap()
    );
    assert!(
        !is_remembered(&pool, "ver-1", "post_message", Some("conv-b"))
            .await
            .unwrap()
    );
}

#[tokio::test]
async fn always_scope_applies_everywhere() {
    let pool = pool_with_schema().await;
    remember(&pool, "ver-1", "post_message", ApprovalScope::Always, None)
        .await
        .unwrap();
    assert!(
        is_remembered(&pool, "ver-1", "post_message", Some("conv-a"))
            .await
            .unwrap()
    );
    assert!(is_remembered(&pool, "ver-1", "post_message", None)
        .await
        .unwrap());
}

#[tokio::test]
async fn revoke_removes_row() {
    let pool = pool_with_schema().await;
    remember(&pool, "ver-1", "post_message", ApprovalScope::Always, None)
        .await
        .unwrap();
    let rows = list_all(&pool).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert!(revoke(&pool, &rows[0].id).await.unwrap());
    assert!(list_all(&pool).await.unwrap().is_empty());
}
