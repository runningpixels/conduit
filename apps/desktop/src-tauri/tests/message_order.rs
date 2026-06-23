//! M2: `load_conversation_messages` returns messages in lexicographic
//! `created_at` order regardless of insertion order (the H2/L3 invariant).
mod common;

use conduit_desktop::db::repository::{conversations, messages};
use provider_core::schema::{Message, MessageRole};

fn bare_message(conversation_id: &str, id: &str, created_at: &str) -> Message {
    Message {
        id: id.to_string(),
        conversation_id: conversation_id.to_string(),
        role: MessageRole::User,
        author_label: None,
        provider_message_id: None,
        interrupted_at: None,
        metadata: None,
        parts: vec![],
        created_at: created_at.to_string(),
    }
}

#[tokio::test]
async fn load_orders_by_created_at_lexicographically() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();

    // Insert out of chronological order.
    messages::insert_message(&pool, &bare_message(&conv.id, "m-late", "2026-06-22T10:00:00Z"))
        .await
        .unwrap();
    messages::insert_message(&pool, &bare_message(&conv.id, "m-early", "2026-06-22T08:00:00Z"))
        .await
        .unwrap();
    messages::insert_message(&pool, &bare_message(&conv.id, "m-mid", "2026-06-22T09:30:00Z"))
        .await
        .unwrap();

    let msgs = messages::load_conversation_messages(&pool, &conv.id)
        .await
        .unwrap();
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[0].id, "m-early");
    assert_eq!(msgs[1].id, "m-mid");
    assert_eq!(msgs[2].id, "m-late");
}