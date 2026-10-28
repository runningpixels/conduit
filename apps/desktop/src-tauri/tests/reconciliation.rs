//! M2: the persistence invariant holds through `append_and_apply`, and
//! `rebuild_view_from_log` repairs a corrupted materialized view from the log.
//!
//! The full reconciliation *check* (sweep all turns, compare, rebuild on
//! mismatch) lands in M3; this test exercises the M2 primitives it will build
//! on: `append_and_apply`, `fold`, `load_conversation_messages`, and
//! `rebuild_view_from_log`.
mod common;

use conduit_desktop::db::{
    fold::fold,
    repository::{conversations, event_log, messages},
};
use provider_core::schema::ProviderEvent;

async fn stream_events(pool: &sqlx::SqlitePool, conv: &str, req: &str) -> Vec<ProviderEvent> {
    let events = vec![
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
            content: "alpha ".into(),
        },
        ProviderEvent::ContentDelta {
            request_id: req.into(),
            block_id: "b0".into(),
            index: 3,
            content: "beta".into(),
        },
        ProviderEvent::MessageComplete {
            request_id: req.into(),
            index: 4,
            finish_reason: "stop".into(),
        },
    ];
    for event in &events {
        event_log::append_and_apply(pool, conv, req, event)
            .await
            .unwrap();
    }
    events
}

#[tokio::test]
async fn view_equals_fold_after_streaming() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();
    let events = stream_events(&pool, &conv.id, "req-1").await;

    let msgs = messages::load_conversation_messages(&pool, &conv.id)
        .await
        .unwrap();
    assert_eq!(msgs.len(), 1);
    let persisted = &msgs[0];
    assert!(persisted.interrupted_at.is_none());

    let message_id = persisted.id.clone();
    let folded = fold(&events, &conv.id, &message_id, "2026-06-22T00:00:00Z");

    assert_eq!(persisted.parts.len(), folded.parts.len());
    for (a, b) in persisted.parts.iter().zip(folded.parts.iter()) {
        assert_eq!(a.id, b.id, "part id mismatch");
        assert_eq!(a.kind, b.kind, "part kind mismatch");
        assert_eq!(a.content, b.content, "part content mismatch");
    }
    // finalization is on the messages row, derived from MessageComplete
    assert!(folded.finalized);
    assert_eq!(folded.finish_reason.as_deref(), Some("stop"));
}

#[tokio::test]
async fn rebuild_view_repairs_corrupted_part() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();
    stream_events(&pool, &conv.id, "req-1").await;

    // Corrupt the materialized part content directly. The part id is a
    // prefixed UUID (`{message_id}/{block_id}`), so look it up from the view.
    let before = messages::load_conversation_messages(&pool, &conv.id)
        .await
        .unwrap();
    let part_id = before[0].parts[0].id.clone();
    sqlx::query("UPDATE message_parts SET content = 'CORRUPTED' WHERE id = ?")
        .bind(&part_id)
        .execute(&pool)
        .await
        .unwrap();
    let before = messages::load_conversation_messages(&pool, &conv.id)
        .await
        .unwrap();
    assert_eq!(before[0].parts[0].content.as_deref(), Some("CORRUPTED"));

    // The log is intact; rebuild restores the view from it.
    conduit_desktop::db::fold::rebuild_view_from_log(&pool, &conv.id, "req-1")
        .await
        .unwrap();
    let after = messages::load_conversation_messages(&pool, &conv.id)
        .await
        .unwrap();
    assert_eq!(
        after[0].parts[0].content.as_deref(),
        Some("alpha beta"),
        "rebuild should restore the folded content from the log"
    );
}

/// A reply cut off at the limit, then continued: the continuation's text goes
/// on in the same block with no break (its own start of the block is never
/// logged), and the reply is open again until its next ending.
fn continued_reply_events(req: &str, finished: bool) -> Vec<ProviderEvent> {
    let mut events = vec![
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
            content: "The report".into(),
        },
        ProviderEvent::MessageComplete {
            request_id: req.into(),
            index: 3,
            finish_reason: "length".into(),
        },
        ProviderEvent::ReplyContinued {
            request_id: req.into(),
        },
        ProviderEvent::MessageStart {
            request_id: req.into(),
            index: 0,
        },
        ProviderEvent::ContentDelta {
            request_id: req.into(),
            block_id: "b0".into(),
            index: 1,
            content: " covers".into(),
        },
    ];
    if finished {
        events.push(ProviderEvent::MessageComplete {
            request_id: req.into(),
            index: 2,
            finish_reason: "stop".into(),
        });
    }
    events
}

async fn reply_row(pool: &sqlx::SqlitePool, req: &str) -> (i64, Option<String>, Option<String>) {
    sqlx::query_as(
        "SELECT finalized, finish_reason, interrupted_at FROM messages WHERE request_id = ?",
    )
    .bind(req)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn a_continued_reply_folds_to_what_the_view_shows() {
    for finished in [true, false] {
        let pool = common::setup_pool().await;
        let conv = conversations::create(&pool, None).await.unwrap();
        let events = continued_reply_events("req-1", finished);
        for event in &events {
            event_log::append_and_apply(&pool, &conv.id, "req-1", event)
                .await
                .unwrap();
        }

        let msgs = messages::load_conversation_messages(&pool, &conv.id)
            .await
            .unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].parts.len(), 1);
        assert_eq!(
            msgs[0].parts[0].content.as_deref(),
            Some("The report covers")
        );

        let folded = fold(&events, &conv.id, &msgs[0].id, "");
        assert_eq!(folded.parts.len(), 1);
        assert_eq!(
            folded.parts[0].content.as_deref(),
            Some("The report covers")
        );
        assert_eq!(folded.finalized, finished);
        let (finalized, finish_reason, _) = reply_row(&pool, "req-1").await;
        assert_eq!(finalized != 0, finished);
        assert_eq!(finish_reason, folded.finish_reason);
        assert_eq!(
            folded.finish_reason.as_deref(),
            finished.then_some("stop"),
            "the continuation's ending replaces the cut-off one"
        );

        let report = conduit_desktop::db::reconcile::reconcile_all(&pool)
            .await
            .unwrap();
        assert!(report.mismatches.is_empty(), "{:?}", report.mismatches);
    }
}

#[tokio::test]
async fn a_crash_mid_continue_leaves_the_reply_interrupted_with_its_text() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();
    for event in &continued_reply_events("req-1", false) {
        event_log::append_and_apply(&pool, &conv.id, "req-1", event)
            .await
            .unwrap();
    }

    let report = conduit_desktop::db::recover::recover_interrupted_streams(&pool)
        .await
        .unwrap();
    assert_eq!(report.unfinalized_marked, 1);
    let (finalized, finish_reason, interrupted_at) = reply_row(&pool, "req-1").await;
    assert_eq!(finalized, 1);
    assert_eq!(finish_reason.as_deref(), Some("cancelled"));
    assert!(interrupted_at.is_some());
    let msgs = messages::load_conversation_messages(&pool, &conv.id)
        .await
        .unwrap();
    assert_eq!(
        msgs[0].parts[0].content.as_deref(),
        Some("The report covers")
    );
}
