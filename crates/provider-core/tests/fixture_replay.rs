use provider_core::adapters::anthropic;
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
fn openai_compat_plain_text_fixture() {
    let fixture = include_str!("fixtures/openai_compat/plain_text.sse");
    let events = openai::parse_fixture("req-1", fixture);
    assert!(events
        .iter()
        .any(|e| matches!(e, ProviderEvent::ContentDelta { content, .. } if content == "Compat")));
}
