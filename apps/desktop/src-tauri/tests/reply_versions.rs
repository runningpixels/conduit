//! Reply versions: Retry keeps the earlier reply, hidden from every read of
//! the thread, and the last reply can switch between its versions.
mod common;

use conduit_desktop::db::repository::{conversations, messages, reply_versions, search};
use provider_core::schema::{Message, MessagePart, MessagePartKind, MessageRole};
use sqlx::SqlitePool;

fn message(conversation_id: &str, id: &str, role: MessageRole, text: &str, minute: u32) -> Message {
    let created_at = format!("2026-06-22T00:{minute:02}:00Z");
    let assistant = role == MessageRole::Assistant;
    Message {
        id: id.to_string(),
        conversation_id: conversation_id.to_string(),
        role,
        author_label: None,
        provider_message_id: None,
        request_id: assistant.then(|| format!("req-{id}")),
        interrupted_at: None,
        metadata: None,
        parts: vec![MessagePart {
            id: format!("{id}-p0"),
            message_id: id.to_string(),
            index: 0,
            kind: MessagePartKind::Text,
            content: Some(text.to_string()),
            mime_type: None,
            tool_call_id: None,
            artifact_id: None,
            attachment_id: None,
            blob_ref: None,
            metadata: None,
            created_at: created_at.clone(),
        }],
        created_at,
    }
}

async fn add(pool: &SqlitePool, conv: &str, id: &str, role: MessageRole, text: &str, minute: u32) {
    messages::insert_message(pool, &message(conv, id, role, text, minute))
        .await
        .unwrap();
}

async fn thread(pool: &SqlitePool, conv: &str) -> Vec<String> {
    messages::load_conversation_messages(pool, conv)
        .await
        .unwrap()
        .into_iter()
        .map(|m| m.id)
        .collect()
}

async fn stored_rows(pool: &SqlitePool, conv: &str) -> i64 {
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM messages WHERE conversation_id = ?")
        .bind(conv)
        .fetch_one(pool)
        .await
        .unwrap();
    n
}

/// A chat with one question, answered, then retried once: versions a1, a2.
async fn retried_once(pool: &SqlitePool) -> String {
    let conv = conversations::create(pool, None).await.unwrap().id;
    add(pool, &conv, "u1", MessageRole::User, "what is a quokka", 0).await;
    add(
        pool,
        &conv,
        "a1",
        MessageRole::Assistant,
        "first answer marsupial",
        1,
    )
    .await;
    let retried = reply_versions::prepare_retry(pool, &conv).await.unwrap();
    assert_eq!(retried.as_deref(), Some("u1"));
    add(
        pool,
        &conv,
        "a2",
        MessageRole::Assistant,
        "second answer wallaby",
        2,
    )
    .await;
    conv
}

async fn versions(pool: &SqlitePool, conv: &str) -> Vec<(String, u32, u32)> {
    reply_versions::list(pool, conv)
        .await
        .unwrap()
        .into_iter()
        .map(|v| (v.user_message_id, v.count, v.current))
        .collect()
}

#[tokio::test]
async fn retry_keeps_the_earlier_reply_out_of_the_thread() {
    let pool = common::setup_pool().await;
    let conv = retried_once(&pool).await;

    assert_eq!(thread(&pool, &conv).await, ["u1", "a2"]);
    assert_eq!(stored_rows(&pool, &conv).await, 3, "a1 is kept");
    assert_eq!(versions(&pool, &conv).await, [("u1".to_string(), 2, 2)]);

    let listed = conversations::list(&pool).await.unwrap();
    assert_eq!(listed[0].message_count, 2);
    assert_eq!(
        listed[0].last_message_preview.as_deref(),
        Some("second answer wallaby")
    );

    let hidden = search::search_messages(&pool, "marsupial", 10)
        .await
        .unwrap();
    assert!(hidden.is_empty(), "a hidden version is not a search hit");
    let live = search::search_messages(&pool, "wallaby", 10).await.unwrap();
    assert_eq!(live.len(), 1);
}

#[tokio::test]
async fn a_chat_without_retries_has_no_versions() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap().id;
    add(&pool, &conv, "u1", MessageRole::User, "hello", 0).await;
    add(&pool, &conv, "a1", MessageRole::Assistant, "hi", 1).await;
    assert!(versions(&pool, &conv).await.is_empty());
    assert_eq!(thread(&pool, &conv).await, ["u1", "a1"]);
}

#[tokio::test]
async fn the_last_reply_switches_and_keeps_the_order() {
    let pool = common::setup_pool().await;
    let conv = retried_once(&pool).await;

    reply_versions::select(&pool, &conv, "u1", 1).await.unwrap();
    assert_eq!(thread(&pool, &conv).await, ["u1", "a1"]);
    assert_eq!(versions(&pool, &conv).await, [("u1".to_string(), 2, 1)]);

    // Retrying from version 1 adds a third; the first two keep their places.
    reply_versions::prepare_retry(&pool, &conv).await.unwrap();
    add(
        &pool,
        &conv,
        "a3",
        MessageRole::Assistant,
        "third answer",
        3,
    )
    .await;
    assert_eq!(versions(&pool, &conv).await, [("u1".to_string(), 3, 3)]);

    for (position, expected) in [(1, "a1"), (2, "a2"), (3, "a3"), (2, "a2")] {
        reply_versions::select(&pool, &conv, "u1", position)
            .await
            .unwrap();
        assert_eq!(
            thread(&pool, &conv).await,
            ["u1", expected],
            "position {position}"
        );
        assert_eq!(
            versions(&pool, &conv).await,
            [("u1".to_string(), 3, position)]
        );
    }
    assert!(reply_versions::select(&pool, &conv, "u1", 4).await.is_err());
    assert!(reply_versions::select(&pool, &conv, "u1", 0).await.is_err());
}

#[tokio::test]
async fn an_earlier_reply_cannot_switch() {
    let pool = common::setup_pool().await;
    let conv = retried_once(&pool).await;
    add(&pool, &conv, "u2", MessageRole::User, "and a wombat", 3).await;
    add(&pool, &conv, "a3", MessageRole::Assistant, "a wombat is", 4).await;

    assert!(reply_versions::select(&pool, &conv, "u1", 1).await.is_err());
    assert_eq!(thread(&pool, &conv).await, ["u1", "a2", "u2", "a3"]);
    // The earlier reply still reports its versions.
    assert_eq!(versions(&pool, &conv).await, [("u1".to_string(), 2, 2)]);
}

#[tokio::test]
async fn a_retry_that_wrote_nothing_can_put_the_reply_back() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap().id;
    add(&pool, &conv, "u1", MessageRole::User, "what is a quokka", 0).await;
    add(
        &pool,
        &conv,
        "a1",
        MessageRole::Assistant,
        "first answer",
        1,
    )
    .await;
    reply_versions::prepare_retry(&pool, &conv).await.unwrap();

    assert_eq!(thread(&pool, &conv).await, ["u1"]);
    assert_eq!(versions(&pool, &conv).await, [("u1".to_string(), 1, 0)]);
    reply_versions::select(&pool, &conv, "u1", 1).await.unwrap();
    assert_eq!(thread(&pool, &conv).await, ["u1", "a1"]);
    assert!(versions(&pool, &conv).await.is_empty());
}

#[tokio::test]
async fn edit_and_resend_removes_every_version() {
    let pool = common::setup_pool().await;
    let conv = retried_once(&pool).await;
    conversations::truncate_from(&pool, &conv, "u1")
        .await
        .unwrap();
    assert_eq!(stored_rows(&pool, &conv).await, 0);
}

#[tokio::test]
async fn removing_the_last_reply_removes_its_versions() {
    let pool = common::setup_pool().await;
    let conv = retried_once(&pool).await;
    conversations::remove_last_assistant_turn(&pool, &conv)
        .await
        .unwrap();
    assert_eq!(thread(&pool, &conv).await, ["u1"]);
    assert_eq!(stored_rows(&pool, &conv).await, 1);
}

#[tokio::test]
async fn a_fork_copies_only_the_reply_in_use() {
    let pool = common::setup_pool().await;
    let conv = retried_once(&pool).await;
    add(&pool, &conv, "u2", MessageRole::User, "and a wombat", 3).await;
    let fork = conversations::fork_before(&pool, &conv, "u2", None)
        .await
        .unwrap();
    let texts: Vec<String> = messages::load_conversation_messages(&pool, &fork.id)
        .await
        .unwrap()
        .into_iter()
        .filter_map(|m| m.parts[0].content.clone())
        .collect();
    assert_eq!(texts, ["what is a quokka", "second answer wallaby"]);
    assert_eq!(stored_rows(&pool, &fork.id).await, 2);
}

fn texts(messages: &[provider_core::schema::Message]) -> Vec<String> {
    messages
        .iter()
        .filter_map(|m| m.parts[0].content.clone())
        .collect()
}

#[tokio::test]
async fn compare_lists_every_version_with_its_messages() {
    let pool = common::setup_pool().await;
    let conv = retried_once(&pool).await;

    let versions = reply_versions::versions(&pool, &conv, "u1").await.unwrap();
    let summary: Vec<(u32, bool, Vec<String>)> = versions
        .iter()
        .map(|v| (v.position, v.current, texts(&v.messages)))
        .collect();
    assert_eq!(
        summary,
        [
            (1, false, vec!["first answer marsupial".to_string()]),
            (2, true, vec!["second answer wallaby".to_string()]),
        ]
    );

    // A reply nobody retried has nothing to compare.
    add(&pool, &conv, "u2", MessageRole::User, "and a wombat", 3).await;
    add(&pool, &conv, "a3", MessageRole::Assistant, "a wombat is", 4).await;
    assert!(reply_versions::versions(&pool, &conv, "u2")
        .await
        .unwrap()
        .is_empty());
    // The earlier reply still lists both.
    assert_eq!(
        reply_versions::versions(&pool, &conv, "u1")
            .await
            .unwrap()
            .len(),
        2
    );
}

#[tokio::test]
async fn an_earlier_version_forks_into_a_new_chat_that_continues_from_it() {
    let pool = common::setup_pool().await;
    let conv = retried_once(&pool).await;
    add(&pool, &conv, "u2", MessageRole::User, "and a wombat", 3).await;
    add(&pool, &conv, "a3", MessageRole::Assistant, "a wombat is", 4).await;

    let fork = reply_versions::fork_version(&pool, &conv, "u1", 1, Some("Fork"))
        .await
        .unwrap();
    let forked = messages::load_conversation_messages(&pool, &fork.id)
        .await
        .unwrap();
    assert_eq!(
        texts(&forked),
        ["what is a quokka", "first answer marsupial"]
    );
    // The source chat is untouched.
    assert_eq!(thread(&pool, &conv).await, ["u1", "a2", "u2", "a3"]);
    assert!(reply_versions::fork_version(&pool, &conv, "u1", 3, None)
        .await
        .is_err());
}
