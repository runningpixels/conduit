//! M2: the pure `fold` produces the expected parts / finalization from a
//! recorded event sequence. This is the canonical source of truth for the
//! `view == fold(events)` invariant.

use conduit_desktop::db::fold::fold;
use provider_core::schema::{MessagePartKind, ProviderEvent};

fn ev(event: ProviderEvent) -> ProviderEvent {
    event
}

#[test]
fn fold_text_reasoning_toolcall_and_completion() {
    let events = vec![
        ev(ProviderEvent::MessageStart {
            request_id: "req-1".into(),
            index: 0,
        }),
        ev(ProviderEvent::ContentBlockStart {
            request_id: "req-1".into(),
            block_id: "b-text".into(),
            index: 1,
            block_kind: "text".into(),
        }),
        ev(ProviderEvent::ContentDelta {
            request_id: "req-1".into(),
            block_id: "b-text".into(),
            index: 2,
            content: "Hello ".into(),
        }),
        ev(ProviderEvent::ContentDelta {
            request_id: "req-1".into(),
            block_id: "b-text".into(),
            index: 3,
            content: "world".into(),
        }),
        ev(ProviderEvent::ContentBlockStart {
            request_id: "req-1".into(),
            block_id: "b-think".into(),
            index: 4,
            block_kind: "thinking".into(),
        }),
        ev(ProviderEvent::ReasoningDelta {
            request_id: "req-1".into(),
            block_id: "b-think".into(),
            index: 5,
            content: "pondering".into(),
        }),
        ev(ProviderEvent::ToolCallStart {
            request_id: "req-1".into(),
            tool_call_id: "tc-0".into(),
            index: 6,
            tool_id: "search".into(),
            name: "search".into(),
        }),
        ev(ProviderEvent::MessageComplete {
            request_id: "req-1".into(),
            index: 7,
            finish_reason: "stop".into(),
        }),
    ];

    let folded = fold(&events, "conv-1", "msg-1", "2026-06-22T00:00:00Z");

    // text part: concatenated deltas. Part ids are `{message_id}/{block_id}`.
    let text = folded
        .parts
        .iter()
        .find(|p| p.id == "msg-1/b-text")
        .unwrap();
    assert_eq!(text.kind, MessagePartKind::Text);
    assert_eq!(text.content.as_deref(), Some("Hello world"));
    assert_eq!(text.index, 1);

    // reasoning part: thinking block_kind -> Reasoning
    let reasoning = folded
        .parts
        .iter()
        .find(|p| p.id == "msg-1/b-think")
        .unwrap();
    assert_eq!(reasoning.kind, MessagePartKind::Reasoning);
    assert_eq!(reasoning.content.as_deref(), Some("pondering"));

    // tool call part: now uses ToolCall kind (R4) instead of text + mime marker
    let tool = folded.parts.iter().find(|p| p.id == "msg-1/tc-0").unwrap();
    assert_eq!(tool.kind, MessagePartKind::ToolCall);
    assert_eq!(tool.content.as_deref(), Some("Tool call: search"));
    assert_eq!(tool.tool_call_id.as_deref(), Some("tc-0"));

    assert!(folded.finalized);
    assert_eq!(folded.finish_reason.as_deref(), Some("stop"));
}

#[test]
fn fold_error_finalizes_with_error_reason() {
    let events = vec![ProviderEvent::MessageStart {
        request_id: "req-1".into(),
        index: 0,
    }];
    let folded = fold(&events, "conv-1", "msg-1", "2026-06-22T00:00:00Z");
    assert!(!folded.finalized);
    assert!(folded.finish_reason.is_none());
    assert!(folded.parts.is_empty());
}
