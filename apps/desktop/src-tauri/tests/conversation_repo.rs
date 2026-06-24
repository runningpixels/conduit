//! M2: conversation create/list/get/delete + cascade, and message_count.
mod common;

use conduit_desktop::db::repository::{conversations, messages};
use provider_core::schema::{Message, MessagePart, MessagePartKind, MessageRole};

fn user_message(conversation_id: &str, id: &str, content: &str) -> Message {
    Message {
        id: id.to_string(),
        conversation_id: conversation_id.to_string(),
        role: MessageRole::User,
        author_label: None,
        provider_message_id: None,
        interrupted_at: None,
        metadata: None,
        parts: vec![MessagePart {
            id: format!("{id}-p0"),
            message_id: id.to_string(),
            index: 0,
            kind: MessagePartKind::Text,
            content: Some(content.to_string()),
            mime_type: None,
            tool_call_id: None,
            artifact_id: None,
            attachment_id: None,
            blob_ref: None,
            metadata: None,
            created_at: "2026-06-22T00:00:00Z".to_string(),
        }],
        created_at: "2026-06-22T00:00:00Z".to_string(),
    }
}

#[tokio::test]
async fn create_list_get_delete_and_cascade() {
    let pool = common::setup_pool().await;

    let conv = conversations::create(&pool, Some("First conversation"))
        .await
        .unwrap();
    assert_eq!(conv.title.as_deref(), Some("First conversation"));

    // get
    let fetched = conversations::get(&pool, &conv.id).await.unwrap();
    assert!(fetched.is_some());
    assert_eq!(fetched.unwrap().id, conv.id);

    // list — empty conversation has message_count 0
    let listed = conversations::list(&pool).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, conv.id);
    assert_eq!(listed[0].message_count, 0);
    assert!(listed[0].last_message_preview.is_none());

    // add a user message; message_count and preview should reflect it
    messages::insert_message(&pool, &user_message(&conv.id, "m1", "Hello world"))
        .await
        .unwrap();
    let listed = conversations::list(&pool).await.unwrap();
    assert_eq!(listed[0].message_count, 1);
    assert_eq!(
        listed[0].last_message_preview.as_deref(),
        Some("Hello world")
    );

    // load the message back
    let msgs = messages::load_conversation_messages(&pool, &conv.id)
        .await
        .unwrap();
    assert_eq!(msgs.len(), 1);
    assert_eq!(msgs[0].role, MessageRole::User);
    assert_eq!(msgs[0].parts.len(), 1);
    assert_eq!(msgs[0].parts[0].content.as_deref(), Some("Hello world"));

    // delete cascades to messages + parts
    conversations::delete(&pool, &conv.id).await.unwrap();
    assert!(conversations::get(&pool, &conv.id).await.unwrap().is_none());
    let msgs = messages::load_conversation_messages(&pool, &conv.id)
        .await
        .unwrap();
    assert!(msgs.is_empty(), "messages should cascade-delete");
    assert!(conversations::list(&pool).await.unwrap().is_empty());
}

#[tokio::test]
async fn list_is_newest_first() {
    let pool = common::setup_pool().await;
    let older = conversations::create(&pool, Some("older")).await.unwrap();
    let newer = conversations::create(&pool, Some("newer")).await.unwrap();

    // `now_iso8601` is second-granular, so two rapid creates/touches collide and
    // `ORDER BY updated_at DESC` is non-deterministic. Set distinct timestamps
    // directly to make the ordering contract explicit and stable.
    sqlx::query("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .bind("2026-06-22T10:00:00Z")
        .bind(&older.id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE conversations SET updated_at = ? WHERE id = ?")
        .bind("2026-06-22T11:00:00Z")
        .bind(&newer.id)
        .execute(&pool)
        .await
        .unwrap();

    let listed = conversations::list(&pool).await.unwrap();
    assert_eq!(listed[0].id, newer.id);
    assert_eq!(listed[1].id, older.id);
}
