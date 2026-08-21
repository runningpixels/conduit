//! M3: a stream that crashed mid-turn (events logged, no `MessageComplete`)
//! reopens as an interrupted assistant message whose parts match the events.
//!
//! This is the spec §7.2 "recover with an interrupted assistant message instead
//! of losing the turn" acceptance criterion, exercised against the recovery
//! sweep that runs on startup.

mod common;

use conduit_desktop::db::{
    recover::recover_interrupted_streams,
    repository::{conversations, event_log, messages},
};
use provider_core::schema::ProviderEvent;

fn partial_turn_events(req: &str) -> Vec<ProviderEvent> {
    vec![
        ProviderEvent::MessageStart {
            request_id: req.into(),
            index: 0,
        },
        ProviderEvent::ContentBlockStart {
            request_id: req.into(),
            block_id: "b0".into(),
            index: 1,
            block_kind: "text".into(),
        },
        ProviderEvent::ContentDelta {
            request_id: req.into(),
            block_id: "b0".into(),
            index: 2,
            content: "partial ".into(),
        },
        ProviderEvent::ContentDelta {
            request_id: req.into(),
            block_id: "b0".into(),
            index: 3,
            content: "response".into(),
        },
        // No MessageComplete — the app died mid-stream.
    ]
}

#[tokio::test]
async fn unfinished_turn_recovers_as_interrupted() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();

    // Simulate a live stream that crashed: events were appended + view updated
    // (exactly what `append_and_apply` does per event), but no MessageComplete.
    for event in &partial_turn_events("req-crash") {
        event_log::append_and_apply(&pool, &conv.id, "req-crash", event)
            .await
            .unwrap();
    }

    // The turn is in-progress: finalized == 0, not interrupted.
    let before = messages::load_conversation_messages(&pool, &conv.id)
        .await
        .unwrap();
    assert_eq!(before.len(), 1);
    assert!(before[0].interrupted_at.is_none());

    // Startup recovery sweep.
    let report = recover_interrupted_streams(&pool).await.unwrap();
    assert_eq!(report.unfinalized_marked, 1);
    assert_eq!(report.orphaned_turns_rebuilt, 0);

    let after = messages::load_conversation_messages(&pool, &conv.id)
        .await
        .unwrap();
    assert_eq!(after.len(), 1);
    assert!(after[0].interrupted_at.is_some(), "marked interrupted");
    assert_eq!(
        after[0].parts[0].content.as_deref(),
        Some("partial response"),
        "parts preserved from the event log"
    );
}

#[tokio::test]
async fn orphaned_event_log_turn_is_rebuilt_then_marked_interrupted() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();

    // Shape 2: events appended directly to the log with NO view row (the
    // append-and-apply invariant makes this impossible in normal operation, but
    // the sweep defends against hand-repaired DBs and crash-before-view windows).
    for (i, event) in partial_turn_events("req-orphan").into_iter().enumerate() {
        event_log::append_event(&pool, &conv.id, "req-orphan", &event)
            .await
            .unwrap();
        let _ = i;
    }
    assert!(messages::get_message_id_by_request(&pool, "req-orphan")
        .await
        .unwrap()
        .is_none());

    let report = recover_interrupted_streams(&pool).await.unwrap();
    assert_eq!(report.unfinalized_marked, 0);
    assert_eq!(report.orphaned_turns_rebuilt, 1);

    let after = messages::load_conversation_messages(&pool, &conv.id)
        .await
        .unwrap();
    assert_eq!(after.len(), 1);
    assert!(after[0].interrupted_at.is_some());
    assert_eq!(
        after[0].parts[0].content.as_deref(),
        Some("partial response")
    );
}

#[tokio::test]
async fn recovery_is_idempotent() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();
    for event in &partial_turn_events("req-idem") {
        event_log::append_and_apply(&pool, &conv.id, "req-idem", event)
            .await
            .unwrap();
    }

    let first = recover_interrupted_streams(&pool).await.unwrap();
    assert_eq!(first.unfinalized_marked, 1);
    let second = recover_interrupted_streams(&pool).await.unwrap();
    assert_eq!(second.unfinalized_marked, 0, "already finalized");
    assert_eq!(second.orphaned_turns_rebuilt, 0);
}
