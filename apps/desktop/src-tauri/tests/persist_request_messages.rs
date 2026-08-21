//! Regression: user messages persisted via `persist_request_messages` must
//! survive across conversations. Previously the frontend synthesized
//! `msg-${index}` ids that reset to `msg-0` for every conversation; the
//! backend `INSERT OR IGNORE INTO messages(id PRIMARY KEY, ...)` then silently
//! dropped the second conversation's user row, so saved sessions showed only
//! assistant responses on reload. This test pins the contract: two
//! conversations, each persisting a first user message, both keep it.
mod common;

use conduit_desktop::db::repository::{conversations, messages};
use provider_core::schema::{Message, MessagePart, MessagePartKind, MessageRole};

fn user_message(conversation_id: &str, id: &str, content: &str, created_at: &str) -> Message {
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
            id: format!("{id}-part-0"),
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
            created_at: created_at.to_string(),
        }],
        created_at: created_at.to_string(),
    }
}

#[tokio::test]
async fn persist_request_messages_keeps_user_turns_across_conversations() {
    let pool = common::setup_pool().await;
    let convo_a = conversations::create(&pool, None).await.unwrap();
    let convo_b = conversations::create(&pool, None).await.unwrap();

    // Two conversations each persist a first user turn. With unique ids
    // (UUIDs / DB PKs), both must survive.
    messages::persist_request_messages(
        &pool,
        &[user_message(
            &convo_a.id,
            "uuid-A1",
            "hello from A",
            "2026-07-02T10:00:00Z",
        )],
    )
    .await
    .unwrap();
    messages::persist_request_messages(
        &pool,
        &[user_message(
            &convo_b.id,
            "uuid-B1",
            "hello from B",
            "2026-07-02T10:00:05Z",
        )],
    )
    .await
    .unwrap();

    let a = messages::load_conversation_messages(&pool, &convo_a.id)
        .await
        .unwrap();
    let b = messages::load_conversation_messages(&pool, &convo_b.id)
        .await
        .unwrap();

    assert_eq!(a.len(), 1, "convo A should retain its user turn");
    assert_eq!(a[0].role, MessageRole::User);
    assert_eq!(a[0].parts[0].content.as_deref(), Some("hello from A"));

    assert_eq!(b.len(), 1, "convo B should retain its user turn");
    assert_eq!(b[0].role, MessageRole::User);
    assert_eq!(b[0].parts[0].content.as_deref(), Some("hello from B"));
}

#[tokio::test]
async fn persist_request_messages_is_idempotent_within_a_conversation() {
    // Re-sent history (same id) must dedup via INSERT OR IGNORE, not error and
    // not duplicate. This is the within-conversation contract the dedup serves.
    let pool = common::setup_pool().await;
    let convo = conversations::create(&pool, None).await.unwrap();

    let msg = user_message(&convo.id, "uuid-1", "first", "2026-07-02T10:00:00Z");
    messages::persist_request_messages(&pool, std::slice::from_ref(&msg))
        .await
        .unwrap();
    // Persist the same message again alongside a new one (simulating a second
    // turn re-sending history).
    let msg2 = user_message(&convo.id, "uuid-2", "second", "2026-07-02T10:00:10Z");
    messages::persist_request_messages(&pool, &[msg, msg2])
        .await
        .unwrap();

    let loaded = messages::load_conversation_messages(&pool, &convo.id)
        .await
        .unwrap();
    assert_eq!(loaded.len(), 2, "no duplicate row for re-sent history");
}
