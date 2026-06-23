//! M3: the persistence invariant survives a full stream, and the reconciliation
//! sweep detects + repairs drift when the materialized view is corrupted.

mod common;

use conduit_desktop::db::{
    reconcile::reconcile_all,
    repository::{conversations, event_log, messages},
};
use provider_core::schema::ProviderEvent;

fn complete_turn_events(req: &str) -> Vec<ProviderEvent> {
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
    ]
}

#[tokio::test]
async fn clean_stream_needs_no_rebuild() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();
    for event in &complete_turn_events("req-clean") {
        event_log::append_and_apply(&pool, &conv.id, "req-clean", event)
            .await
            .unwrap();
    }

    let report = reconcile_all(&pool).await.unwrap();
    assert_eq!(report.turns_checked, 1);
    assert_eq!(report.rebuilds, 0, "no drift after a clean stream");
}

#[tokio::test]
async fn corrupted_part_is_detected_and_rebuilt() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();
    for event in &complete_turn_events("req-corrupt") {
        event_log::append_and_apply(&pool, &conv.id, "req-corrupt", event)
            .await
            .unwrap();
    }

    // Corrupt the materialized part directly — the log is the source of truth.
    // The part id is a prefixed UUID (`{message_id}/{block_id}`), so look it up.
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

    let report = reconcile_all(&pool).await.unwrap();
    assert_eq!(report.turns_checked, 1);
    assert_eq!(report.rebuilds, 1, "drift triggers a rebuild");
    assert_eq!(report.mismatches.len(), 1);
    assert_eq!(report.mismatches[0].request_id, "req-corrupt");

    let after = messages::load_conversation_messages(&pool, &conv.id)
        .await
        .unwrap();
    assert_eq!(
        after[0].parts[0].content.as_deref(),
        Some("alpha beta"),
        "rebuild restores the folded content from the log"
    );
}

#[tokio::test]
async fn reconciliation_is_idempotent() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();
    for event in &complete_turn_events("req-idem") {
        event_log::append_and_apply(&pool, &conv.id, "req-idem", event)
            .await
            .unwrap();
    }

    // First pass is clean; a second pass must also be clean (the rebuild wrote
    // a view that now agrees with the fold).
    let first = reconcile_all(&pool).await.unwrap();
    assert_eq!(first.rebuilds, 0);
    let second = reconcile_all(&pool).await.unwrap();
    assert_eq!(second.rebuilds, 0);
}