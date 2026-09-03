//! t1-3: conversation compaction journal insert + latest-by-conversation.
mod common;

use conduit_desktop::db::repository::{compactions, conversations};

#[tokio::test]
async fn insert_and_load_latest_compaction() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, Some("compact-test"))
        .await
        .expect("create conversation");

    let first = compactions::insert(
        &pool,
        &conv.id,
        "First summary",
        "msg-kept-1",
        "msg-kept-1",
        "claude-sonnet-4",
        10_000,
        2_000,
    )
    .await
    .expect("insert first");

    let second = compactions::insert(
        &pool,
        &conv.id,
        "Second summary",
        "msg-kept-2",
        "msg-kept-2",
        "claude-sonnet-4",
        12_000,
        2_500,
    )
    .await
    .expect("insert second");

    let latest = compactions::latest_for_conversation(&pool, &conv.id)
        .await
        .expect("load latest")
        .expect("row present");

    assert_eq!(latest.id, second.id);
    assert_eq!(latest.summary_text, "Second summary");
    assert_eq!(latest.kept_from_message_id, "msg-kept-2");
    assert_ne!(latest.id, first.id);

    let missing = compactions::latest_for_conversation(&pool, "no-such-conv")
        .await
        .expect("load missing");
    assert!(missing.is_none());
}
