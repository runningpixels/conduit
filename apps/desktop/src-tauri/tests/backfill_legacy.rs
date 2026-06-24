//! M3: a legacy `streams/<conv>/<req>.json` journal backfills into the SQLite
//! event log + materialized view with `view == fold(events)`.

mod common;

use std::fs;

use conduit_desktop::{
    db::{
        backfill::backfill_legacy_streams,
        repository::{conversations, messages},
    },
    stream_persistence::StreamRecord,
};
use provider_core::schema::{Message, MessagePart, MessagePartKind, MessageRole, ProviderEvent};

fn legacy_record(conv: &str, req: &str, interrupted: bool) -> StreamRecord {
    let now = "2026-06-22T09:00:00Z".to_string();
    let message_id = format!("msg-{req}");
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
            content: "legacy ".into(),
        },
        ProviderEvent::ContentDelta {
            request_id: req.into(),
            block_id: "b0".into(),
            index: 3,
            content: "turn".into(),
        },
    ];
    let message = Message {
        id: message_id.clone(),
        conversation_id: conv.into(),
        role: MessageRole::Assistant,
        author_label: None,
        provider_message_id: None,
        interrupted_at: interrupted.then(|| now.clone()),
        metadata: None,
        // Mirror what the legacy `apply_to_message` would have stored: one text
        // part with the raw block id and concatenated content. The backfill
        // verification compares this against the log-derived fold (stripping the
        // `{message_id}/` prefix the fold adds to part ids).
        parts: vec![MessagePart {
            id: "b0".into(),
            message_id: message_id.clone(),
            index: 1,
            kind: MessagePartKind::Text,
            content: Some("legacy turn".into()),
            mime_type: None,
            tool_call_id: None,
            artifact_id: None,
            attachment_id: None,
            blob_ref: None,
            metadata: None,
            created_at: now.clone(),
        }],
        created_at: now.clone(),
    };
    StreamRecord {
        request_id: req.into(),
        conversation_id: conv.into(),
        message_id,
        events,
        message,
        finalized: !interrupted,
        interrupted,
        finish_reason: Some(if interrupted {
            "cancelled".into()
        } else {
            "stop".into()
        }),
    }
}

#[tokio::test]
async fn legacy_journal_imports_into_sqlite() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let streams_root = dir.path().to_path_buf();

    // Write two legacy journals under one conversation dir.
    let conv = "conv-legacy";
    std::fs::create_dir_all(streams_root.join(conv)).unwrap();
    let record_a = legacy_record(conv, "req-a", false);
    std::fs::write(
        streams_root.join(conv).join("req-a.json"),
        serde_json::to_string_pretty(&record_a).unwrap(),
    )
    .unwrap();
    let record_b = legacy_record(conv, "req-b", true);
    std::fs::write(
        streams_root.join(conv).join("req-b.json"),
        serde_json::to_string_pretty(&record_b).unwrap(),
    )
    .unwrap();

    let report = backfill_legacy_streams(&pool, &streams_root).await.unwrap();
    assert_eq!(report.files_scanned, 2);
    assert_eq!(report.turns_imported, 2);
    assert_eq!(report.skipped_already_present, 0);
    assert_eq!(report.verification_mismatches, 0);
    assert_eq!(report.failed, 0);

    // The conversation row was created by the backfill (it never existed).
    assert!(conversations::get(&pool, conv).await.unwrap().is_some());

    let msgs = messages::load_conversation_messages(&pool, conv)
        .await
        .unwrap();
    assert_eq!(msgs.len(), 2, "both turns imported");

    // req-a: complete turn, content folded from the log.
    let a = msgs.iter().find(|m| m.id == "msg-req-a").unwrap();
    assert_eq!(a.parts[0].content.as_deref(), Some("legacy turn"));
    assert!(a.interrupted_at.is_none());

    // req-b: interrupted turn — folded content + interrupted marker.
    let b = msgs.iter().find(|m| m.id == "msg-req-b").unwrap();
    assert_eq!(b.parts[0].content.as_deref(), Some("legacy turn"));
    assert!(b.interrupted_at.is_some(), "interrupted legacy turn marked");

    // Marker written; a second pass short-circuits.
    assert!(streams_root.join(".backfilled").exists());
    let again = backfill_legacy_streams(&pool, &streams_root).await.unwrap();
    assert_eq!(again.turns_imported, 0);
    assert_eq!(again.files_scanned, 0);
}

#[tokio::test]
async fn backfill_is_idempotent_without_marker() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let streams_root = dir.path().to_path_buf();
    let conv = "conv-idem";
    std::fs::create_dir_all(streams_root.join(conv)).unwrap();
    let record = legacy_record(conv, "req-x", false);
    std::fs::write(
        streams_root.join(conv).join("req-x.json"),
        serde_json::to_string_pretty(&record).unwrap(),
    )
    .unwrap();

    let first = backfill_legacy_streams(&pool, &streams_root).await.unwrap();
    assert_eq!(first.turns_imported, 1);
    // Remove the marker to force a re-walk; the turn is already present and
    // must be skipped (not re-imported, not duplicated).
    fs::remove_file(streams_root.join(".backfilled")).unwrap();
    let second = backfill_legacy_streams(&pool, &streams_root).await.unwrap();
    assert_eq!(second.turns_imported, 0);
    assert_eq!(second.skipped_already_present, 1);

    let msgs = messages::load_conversation_messages(&pool, conv)
        .await
        .unwrap();
    assert_eq!(msgs.len(), 1, "no duplicate on re-run");
}

#[tokio::test]
async fn unreadable_file_does_not_abort_sweep() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let streams_root = dir.path().to_path_buf();
    let conv = "conv-mixed";
    std::fs::create_dir_all(streams_root.join(conv)).unwrap();

    // One good record + one corrupt (non-JSON) file.
    let record = legacy_record(conv, "req-good", false);
    std::fs::write(
        streams_root.join(conv).join("req-good.json"),
        serde_json::to_string_pretty(&record).unwrap(),
    )
    .unwrap();
    std::fs::write(
        streams_root.join(conv).join("req-bad.json"),
        "{ not valid json",
    )
    .unwrap();

    let report = backfill_legacy_streams(&pool, &streams_root).await.unwrap();
    assert_eq!(report.turns_imported, 1);
    assert_eq!(report.failed, 1);
    // Marker is NOT written when a file failed (next start retries).
    assert!(!streams_root.join(".backfilled").exists());
}
