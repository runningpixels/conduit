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

#[tokio::test]
async fn continuation_rounds_fold_into_one_assistant_row() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();
    let req = "req-turn";

    let round1 = [
        ProviderEvent::MessageStart {
            request_id: req.into(),
            index: 0,
        },
        ProviderEvent::ContentBlockStart {
            request_id: req.into(),
            block_id: "block-0".into(),
            index: 1,
            block_kind: "text".into(),
        },
        ProviderEvent::ContentDelta {
            request_id: req.into(),
            block_id: "block-0".into(),
            index: 2,
            content: "Yes — let me run a quick test.".into(),
        },
    ];
    let round2 = [
        ProviderEvent::MessageStart {
            request_id: "req-round-2".into(),
            index: 0,
        },
        ProviderEvent::ContentBlockStart {
            request_id: "req-round-2".into(),
            block_id: "block-0".into(),
            index: 1,
            block_kind: "text".into(),
        },
        ProviderEvent::ContentDelta {
            request_id: "req-round-2".into(),
            block_id: "block-0".into(),
            index: 2,
            content: "Yes, I have web access.".into(),
        },
        ProviderEvent::MessageComplete {
            request_id: "req-round-2".into(),
            index: 3,
            finish_reason: "stop".into(),
        },
    ];

    for event in round1.iter().chain(round2.iter()) {
        event_log::append_and_apply(&pool, &conv.id, req, event)
            .await
            .unwrap();
    }

    let loaded = messages::load_conversation_messages(&pool, &conv.id)
        .await
        .unwrap();
    let assistants: Vec<_> = loaded
        .iter()
        .filter(|m| m.role == provider_core::schema::MessageRole::Assistant)
        .collect();
    assert_eq!(
        assistants.len(),
        1,
        "continuation events folded under one request_id must not mint a second assistant row"
    );
    let text: String = assistants[0]
        .parts
        .iter()
        .filter_map(|p| p.content.clone())
        .collect();
    // A new round is a new paragraph. Run together ("…test.Yes, I have…"), a
    // fence the second round opened started mid-line and the rest of the
    // reply parsed as a document.
    assert_eq!(
        text,
        "Yes — let me run a quick test.\n\nYes, I have web access."
    );

    // And the fold agrees: reconciliation has nothing to repair.
    let report = reconcile_all(&pool).await.unwrap();
    assert_eq!(
        report.rebuilds, 0,
        "multi-round view matches the fold of the log"
    );
}

/// The stream path saves deltas in batches (`append_and_apply_batch`), joining
/// a run of deltas to one part into a single UPDATE. The result must be exactly
/// what saving each event on its own produces: one log row per event, in
/// order, and a view the reconciliation sweep finds nothing to repair in.
#[tokio::test]
async fn batched_events_fold_exactly_like_single_ones() {
    let req = "req-batch";
    let delta = |block: &str, index: usize, text: &str, reasoning: bool| {
        if reasoning {
            ProviderEvent::ReasoningDelta {
                request_id: req.into(),
                block_id: block.into(),
                index,
                content: text.into(),
            }
        } else {
            ProviderEvent::ContentDelta {
                request_id: req.into(),
                block_id: block.into(),
                index,
                content: text.into(),
            }
        }
    };
    let events = vec![
        ProviderEvent::MessageStart {
            request_id: req.into(),
            index: 0,
        },
        ProviderEvent::ContentBlockStart {
            request_id: req.into(),
            block_id: "r0".into(),
            index: 1,
            block_kind: "thinking".into(),
        },
        delta("r0", 2, "think ", true),
        delta("r0", 3, "hard", true),
        ProviderEvent::ContentBlockStart {
            request_id: req.into(),
            block_id: "b0".into(),
            index: 4,
            block_kind: "text".into(),
        },
        delta("b0", 5, "one ", false),
        delta("b0", 6, "two ", false),
        // A run broken by another part, then resumed: must not be merged
        // across the interruption out of order.
        delta("r0", 7, "!", true),
        delta("b0", 8, "three", false),
        ProviderEvent::MessageComplete {
            request_id: req.into(),
            index: 9,
            finish_reason: "stop".into(),
        },
    ];

    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, None).await.unwrap();
    // Uneven batches, the last one carrying the completion like the stream path.
    for chunk in [&events[0..3], &events[3..7], &events[7..8], &events[8..]] {
        event_log::append_and_apply_batch(&pool, &conv.id, req, chunk)
            .await
            .unwrap();
    }

    let logged = event_log::load_events(&pool, &conv.id, req).await.unwrap();
    assert_eq!(logged, events, "one log row per event, in order");

    let msgs = messages::load_conversation_messages(&pool, &conv.id)
        .await
        .unwrap();
    let texts: Vec<&str> = msgs[0]
        .parts
        .iter()
        .map(|p| p.content.as_deref().unwrap_or(""))
        .collect();
    assert!(texts.contains(&"think hard!"), "reasoning part: {texts:?}");
    assert!(texts.contains(&"one two three"), "text part: {texts:?}");

    let report = reconcile_all(&pool).await.unwrap();
    assert_eq!(
        report.rebuilds, 0,
        "the batched view matches the fold of the log"
    );
}
