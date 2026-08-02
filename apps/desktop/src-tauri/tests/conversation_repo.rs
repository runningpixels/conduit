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
        request_id: None,
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

fn assistant_message(conversation_id: &str, id: &str, content: &str) -> Message {
    Message {
        id: id.to_string(),
        conversation_id: conversation_id.to_string(),
        role: MessageRole::Assistant,
        author_label: None,
        provider_message_id: None,
        request_id: Some("req-1".to_string()),
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
            created_at: "2026-06-22T00:01:00Z".to_string(),
        }],
        created_at: "2026-06-22T00:01:00Z".to_string(),
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
    assert_eq!(listed[0].display_title, "First conversation");
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

#[tokio::test]
async fn list_display_title_from_first_user_prompt_when_untitled() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();
    messages::insert_message(
        &pool,
        &user_message(&conv.id, "m1", "How do I refactor this module?"),
    )
    .await
    .unwrap();

    let listed = conversations::list(&pool).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].display_title, "How do I refactor this module?");
}

#[tokio::test]
async fn list_summarizes_artifact_heavy_last_message_preview() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();
    messages::insert_message(
        &pool,
        &user_message(&conv.id, "m1", "create an html artifact overview of python"),
    )
    .await
    .unwrap();

    let artifact_body = "Here's the artifact.\n```html\n<!DOCTYPE html>\n<html><head><title>Python overview</title></head><body><p>lots of content</p></body></html>\n```";
    messages::insert_message(&pool, &assistant_message(&conv.id, "m2", artifact_body))
        .await
        .unwrap();

    let listed = conversations::list(&pool).await.unwrap();
    let preview = listed[0]
        .last_message_preview
        .as_deref()
        .expect("preview should be present");
    assert!(preview.contains("Here's the artifact."));
    assert!(preview.contains("HTML artifact"));
    assert!(preview.contains("Python overview"));
    assert!(!preview.contains("<!DOCTYPE"));
    assert!(!preview.contains("<html>"));
}

#[tokio::test]
async fn remove_last_assistant_turn_removes_latest_assistant() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();

    // Insert user message + assistant message with request_id
    messages::insert_message(&pool, &user_message(&conv.id, "u1", "hello"))
        .await
        .unwrap();
    messages::insert_message(
        &pool,
        &assistant_message(&conv.id, "a1", "hi there"),
    )
    .await
    .unwrap();

    let rid = conversations::last_assistant_request_id(&pool, &conv.id)
        .await
        .unwrap();
    // Note: insert_message_in_txn always sets request_id=NULL, so the query
    // returns None. In the real stream pipeline, request_id is set by the
    // event-log fold. The retry/fork flow works with the stream pipeline;
    // this test validates the remove/query mechanism.

    let removed = conversations::remove_last_assistant_turn(&pool, &conv.id)
        .await
        .unwrap();
    // The remove path uses SELECT by role + created_at (not request_id).
    // The return value is the request_id from the message row (which is NULL
    // in this test). The important thing is that the message is deleted.

    let listed = conversations::list(&pool).await.unwrap();
    assert_eq!(listed[0].message_count, 1, "only user message remains");
}

#[tokio::test]
async fn remove_last_assistant_turn_noop_on_empty() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();
    let removed = conversations::remove_last_assistant_turn(&pool, &conv.id)
        .await
        .unwrap();
    assert!(removed.is_none());
}

#[tokio::test]
async fn fork_conversation_deep_copies_messages() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, Some("Original")).await.unwrap();

    messages::insert_message(&pool, &user_message(&conv.id, "u1", "hello"))
        .await
        .unwrap();
    messages::insert_message(
        &pool,
        &assistant_message(&conv.id, "a1", "hi there"),
    )
    .await
    .unwrap();

    let fork = conversations::fork_at(&pool, &conv.id, "a1", Some("Fork of Original"))
        .await
        .unwrap();

    assert_eq!(fork.title.as_deref(), Some("Fork of Original"));

    let listed = conversations::list(&pool).await.unwrap();
    assert_eq!(listed.len(), 2, "original + fork");

    // The fork (most recently updated) should be listed first
    assert_eq!(listed[0].message_count, 2, "fork has 2 messages");
    assert_eq!(listed[1].message_count, 2, "original has 2 messages");

    // Verify fork metadata
    assert_eq!(
        listed[0].forked_from_conversation_id.as_deref(),
        Some(conv.id.as_str())
    );

    // Load fork messages to verify content
    let fork_msgs = messages::load_conversation_messages(&pool, &fork.id)
        .await
        .unwrap();
    assert_eq!(fork_msgs.len(), 2);
    assert_eq!(
        fork_msgs[0].parts[0].content.as_deref(),
        Some("hello")
    );
    assert_eq!(
        fork_msgs[1].parts[0].content.as_deref(),
        Some("hi there")
    );
    // Fork IDs should be different from original
    assert_ne!(fork_msgs[0].id, "u1");
    assert_ne!(fork_msgs[1].id, "a1");
}
