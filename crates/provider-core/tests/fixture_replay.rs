use provider_core::adapters::anthropic;
use provider_core::adapters::gemini;
use provider_core::adapters::ollama;
use provider_core::adapters::openai;
use provider_core::schema::ProviderEvent;

#[test]
fn anthropic_plain_text_fixture() {
    let fixture = include_str!("fixtures/anthropic/plain_text.sse");
    let events = anthropic::parse_fixture("req-1", fixture);
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ContentDelta { content, .. } if content == "Hello")));
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::Usage { .. })));
}

#[test]
fn anthropic_reasoning_fixture() {
    let fixture = include_str!("fixtures/anthropic/reasoning.sse");
    let events = anthropic::parse_fixture("req-1", fixture);
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ReasoningDelta { .. })));
}

#[test]
fn anthropic_tool_call_fixture() {
    let fixture = include_str!("fixtures/anthropic/tool_call_single.sse");
    let events = anthropic::parse_fixture("req-1", fixture);
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ToolCallStart { .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ToolCallComplete { .. })));
}

#[test]
fn openai_plain_text_fixture() {
    let fixture = include_str!("fixtures/openai/plain_text.sse");
    let events = openai::parse_fixture("req-1", fixture);
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ContentDelta { .. })));
}

#[test]
fn openai_tool_call_fixture() {
    let fixture = include_str!("fixtures/openai/tool_call_single.sse");
    let events = openai::parse_fixture("req-1", fixture);
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ToolCallStart { .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ToolCallComplete { .. })));
}

#[test]
fn ollama_plain_text_fixture() {
    let fixture = include_str!("fixtures/ollama/plain_text.sse");
    let events = ollama::parse_fixture("req-1", fixture);
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ContentDelta { .. })));
}

#[test]
fn gemini_plain_text_fixture() {
    let fixture = include_str!("fixtures/gemini/plain_text.sse");
    let events = gemini::parse_fixture("req-1", fixture);
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ContentDelta { content, .. } if content == "Hello")));
}

#[test]
fn gemini_tool_call_fixture() {
    let fixture = include_str!("fixtures/gemini/tool_call_single.sse");
    let events = gemini::parse_fixture("req-1", fixture);
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ToolCallStart { .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ToolCallComplete { .. })));
}

#[test]
fn gemini_parallel_tool_call_fixture() {
    let fixture = include_str!("fixtures/gemini/tool_call_parallel.sse");
    let events = gemini::parse_fixture("req-1", fixture);
    let ids: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            ProviderEvent::ToolCallStart { tool_call_id, .. } => Some(tool_call_id.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(ids.len(), 2);
    assert_ne!(ids[0], ids[1]);
}

#[test]
fn gemini_grounding_fixture() {
    let fixture = include_str!("fixtures/gemini/grounding.sse");
    let events = gemini::parse_fixture("req-1", fixture);
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::SearchSources { .. })));
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::Citation { .. })));
}

#[test]
fn zen_claude_fixture() {
    let fixture = include_str!("fixtures/zen/claude_plain_text.sse");
    let events = anthropic::parse_fixture("req-1", fixture);
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ContentDelta { content, .. } if content == "Hello")));
}

#[test]
fn zen_gpt_responses_fixture() {
    let fixture = include_str!("fixtures/zen/gpt_responses_plain_text.sse");
    let events = openai::parse_fixture("req-1", fixture);
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ContentDelta { content, .. } if content == "Hello")));
}

#[test]
fn zen_chat_fixture() {
    let fixture = include_str!("fixtures/zen/chat_plain_text.sse");
    let events = openai::parse_fixture("req-1", fixture);
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ContentDelta { content, .. } if content == "Hello")));
}

#[test]
fn zen_gemini_fixture() {
    let fixture = include_str!("fixtures/zen/gemini_plain_text.sse");
    let events = gemini::parse_fixture("req-1", fixture);
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ContentDelta { content, .. } if content == "Hello")));
}

#[test]
fn openai_compat_plain_text_fixture() {
    let fixture = include_str!("fixtures/openai_compat/plain_text.sse");
    let events = openai::parse_fixture("req-1", fixture);
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ContentDelta { content, .. } if content == "Compat")));
}
