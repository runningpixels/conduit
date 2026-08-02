//! Tests for the agent loop core types and data structures.
//!
//! Covers:
//! - `RoundOutcome` default and construction
//! - `build_continuation_request` edge cases (empty calls, no tool results)
//! - Tool result truncation for large outputs
//! - Validation functions for agent guardrails and web search domains
//! - `CompletedToolCall` construction
//!
//! These tests do NOT require a running Tauri app or a live provider. They test
//! pure data structures, validation logic, and DB-backed request building using
//! the in-memory SQLite test pool from `common`.

mod common;

use std::path::Path;

use conduit_desktop::{
    db::repository::{conversations, event_log, messages, tool_calls},
    paths::AppPaths,
    stream_manager::{CompletedToolCall, RoundOutcome, StreamManager},
    validation,
};
use provider_core::schema::{
    AgentGuardrails, Message, MessagePart, MessagePartKind, MessageRole, ProviderEvent,
    ProviderRequest, ToolCallRecord, ToolCallStatus, WebSearchDefaults,
};
use serde_json::json;

/// Test paths under a tempdir (mirrors `state.rs` test helper).
fn test_paths(root: &Path) -> AppPaths {
    AppPaths {
        root: root.to_path_buf(),
        settings_file: root.join("settings.json"),
        database: root.join("conduit.sqlite"),
        attachments: root.join("attachments"),
        artifacts: root.join("artifacts"),
        logs: root.join("logs"),
        diagnostics: root.join("diagnostics"),
        updates: root.join("updates"),
        streams: root.join("streams"),
        connectors: root.join("connectors"),
        exports: root.join("exports"),
    }
}

// ─── RoundOutcome ─────────────────────────────────────────────────────────

#[test]
fn round_outcome_default_is_well_formed() {
    let outcome = RoundOutcome::default();
    assert!(
        outcome.completed_tool_calls.is_empty(),
        "default must have no completed tool calls"
    );
    assert!(!outcome.finished_normally, "default must not be finished");
    assert!(
        outcome.error_message.is_none(),
        "default must have no error"
    );
    assert!(outcome.usage.is_none(), "default must have no usage");
}

#[test]
fn round_outcome_with_error() {
    let outcome = RoundOutcome {
        completed_tool_calls: Vec::new(),
        finished_normally: false,
        error_message: Some("provider unavailable".to_string()),
        usage: None,
    };
    assert_eq!(
        outcome.error_message.as_deref(),
        Some("provider unavailable")
    );
    assert!(!outcome.finished_normally);
}

#[test]
fn round_outcome_with_tool_calls() {
    let calls = vec![CompletedToolCall {
        tool_call_id: "call-1".into(),
        tool_id: Some("search".into()),
        name: "search".into(),
        arguments: json!({"q": "test"}),
    }];
    let outcome = RoundOutcome {
        completed_tool_calls: calls.clone(),
        finished_normally: true,
        error_message: None,
        usage: None,
    };
    assert_eq!(outcome.completed_tool_calls.len(), 1);
    assert_eq!(outcome.completed_tool_calls[0].tool_call_id, "call-1");
    assert!(outcome.finished_normally);
}

// ─── CompletedToolCall ────────────────────────────────────────────────────

#[test]
fn completed_tool_call_round_trip() {
    let call = CompletedToolCall {
        tool_call_id: "call-abc".into(),
        tool_id: Some("my_tool".into()),
        name: "my_tool".into(),
        arguments: json!({"key": "value", "count": 42}),
    };
    assert_eq!(call.tool_call_id, "call-abc");
    assert_eq!(call.name, "my_tool");
    assert_eq!(call.arguments["key"], "value");
    assert_eq!(call.arguments["count"], 42);
}

#[test]
fn completed_tool_call_without_tool_id() {
    let call = CompletedToolCall {
        tool_call_id: "call-xyz".into(),
        tool_id: None,
        name: "".into(),
        arguments: json!(null),
    };
    assert!(call.tool_id.is_none());
    assert!(call.name.is_empty());
}

// ─── build_continuation_request — empty / edge cases ─────────────────────

#[tokio::test]
async fn build_continuation_request_with_no_tool_calls_produces_no_tool_message() {
    // When there are no tool calls to continue from (empty completed_calls),
    // the continuation request should still be valid but won't have a tool
    // message part. This tests the case where the agent loop calls
    // build_continuation_request with an empty slice.
    let pool = common::setup_pool().await;
    let conversation_id = "conv-empty-calls";
    let request_id = "req-empty-calls";
    conversations::ensure_exists(&pool, conversation_id)
        .await
        .unwrap();

    // Seed a user message
    let user_msg = Message {
        id: "user-msg".into(),
        conversation_id: conversation_id.into(),
        role: MessageRole::User,
        author_label: None,
        provider_message_id: None,
        request_id: None,
        interrupted_at: None,
        metadata: None,
        parts: vec![MessagePart {
            id: "user-msg/p0".into(),
            message_id: "user-msg".into(),
            index: 0,
            kind: MessagePartKind::Text,
            content: Some("Hello".into()),
            mime_type: None,
            tool_call_id: None,
            artifact_id: None,
            attachment_id: None,
            blob_ref: None,
            metadata: None,
            created_at: "2026-06-27T00:00:00Z".into(),
        }],
        created_at: "2026-06-27T00:00:00Z".into(),
    };
    messages::persist_request_messages(&pool, &[user_msg])
        .await
        .unwrap();

    // Seed an assistant round (no tool calls — just a text response)
    event_log::append_and_apply(
        &pool,
        conversation_id,
        request_id,
        &ProviderEvent::MessageStart {
            request_id: request_id.into(),
            index: 0,
        },
    )
    .await
    .unwrap();
    event_log::append_and_apply(
        &pool,
        conversation_id,
        request_id,
        &ProviderEvent::ContentBlockStart {
            request_id: request_id.into(),
            block_id: "block-0".into(),
            index: 0,
            block_kind: "text".into(),
        },
    )
    .await
    .unwrap();
    event_log::append_and_apply(
        &pool,
        conversation_id,
        request_id,
        &ProviderEvent::ContentDelta {
            request_id: request_id.into(),
            block_id: "block-0".into(),
            index: 1,
            content: "Sure, here's the answer.".into(),
        },
    )
    .await
    .unwrap();
    event_log::append_and_apply(
        &pool,
        conversation_id,
        request_id,
        &ProviderEvent::MessageComplete {
            request_id: request_id.into(),
            index: 2,
            finish_reason: "end_turn".into(),
        },
    )
    .await
    .unwrap();

    let state = {
        let dir = tempfile::tempdir().unwrap();
        let paths = test_paths(dir.path());
        conduit_desktop::state::AppState::test_instance(pool.clone(), paths)
    };

    let prev_request = ProviderRequest {
        request_id: request_id.into(),
        conversation_id: conversation_id.into(),
        model_id: "test-model".into(),
        messages: vec![],
        system_prompt: None,
        developer_prompt: None,
        attachments: None,
        tool_definitions: Vec::new(),
        generation_controls: None,
        response_format: None,
        web_search: None,
    };

    let continuation = StreamManager::new()
        .build_continuation_request(&state, &prev_request, &[])
        .await;

    // With no tool calls, the continuation builder should still succeed.
    // It will produce a request with the assistant text but no tool message.
    let continuation =
        continuation.expect("build_continuation_request should succeed with empty calls");
    assert_ne!(
        continuation.request_id, request_id,
        "continuation request_id must be fresh"
    );
    assert_eq!(continuation.conversation_id, conversation_id);
    // There should be no tool-role message since no tool calls were made
    let tool_messages: Vec<&Message> = continuation
        .messages
        .iter()
        .filter(|m| m.role == MessageRole::Tool)
        .collect();
    assert!(
        tool_messages.is_empty(),
        "no tool messages expected when there are no completed tool calls"
    );
}

#[tokio::test]
async fn build_continuation_request_with_no_tool_results_uses_fallback_message() {
    // When a tool call has Completed status but no tool_result row exists,
    // the continuation should use the fallback message.
    let pool = common::setup_pool().await;
    let conversation_id = "conv-no-result";
    let request_id = "req-no-result";
    conversations::ensure_exists(&pool, conversation_id)
        .await
        .unwrap();

    let user_msg = Message {
        id: "user-msg2".into(),
        conversation_id: conversation_id.into(),
        role: MessageRole::User,
        author_label: None,
        provider_message_id: None,
        request_id: None,
        interrupted_at: None,
        metadata: None,
        parts: vec![MessagePart {
            id: "user-msg2/p0".into(),
            message_id: "user-msg2".into(),
            index: 0,
            kind: MessagePartKind::Text,
            content: Some("search".into()),
            mime_type: None,
            tool_call_id: None,
            artifact_id: None,
            attachment_id: None,
            blob_ref: None,
            metadata: None,
            created_at: "2026-06-27T00:00:00Z".into(),
        }],
        created_at: "2026-06-27T00:00:00Z".into(),
    };
    messages::persist_request_messages(&pool, &[user_msg])
        .await
        .unwrap();

    // Seed an assistant round with tool_calls finish_reason
    event_log::append_and_apply(
        &pool,
        conversation_id,
        request_id,
        &ProviderEvent::MessageStart {
            request_id: request_id.into(),
            index: 0,
        },
    )
    .await
    .unwrap();
    event_log::append_and_apply(
        &pool,
        conversation_id,
        request_id,
        &ProviderEvent::ContentBlockStart {
            request_id: request_id.into(),
            block_id: "block-0".into(),
            index: 0,
            block_kind: "text".into(),
        },
    )
    .await
    .unwrap();
    event_log::append_and_apply(
        &pool,
        conversation_id,
        request_id,
        &ProviderEvent::ContentDelta {
            request_id: request_id.into(),
            block_id: "block-0".into(),
            index: 1,
            content: "Let me search.".into(),
        },
    )
    .await
    .unwrap();
    event_log::append_and_apply(
        &pool,
        conversation_id,
        request_id,
        &ProviderEvent::MessageComplete {
            request_id: request_id.into(),
            index: 2,
            finish_reason: "tool_calls".into(),
        },
    )
    .await
    .unwrap();

    // Insert a tool call with Completed status but NO tool_result row
    tool_calls::insert_tool_call(
        &pool,
        &ToolCallRecord {
            id: "call-no-result".into(),
            tool_id: "search".into(),
            request_id: request_id.into(),
            status: ToolCallStatus::Completed,
            arguments: Some(json!({"q": "test"})),
            result: None,
            error: None,
            approved_at: None,
            completed_at: Some("2026-06-27T00:00:01Z".into()),
        },
    )
    .await
    .unwrap();

    let state = {
        let dir = tempfile::tempdir().unwrap();
        let paths = test_paths(dir.path());
        conduit_desktop::state::AppState::test_instance(pool.clone(), paths)
    };

    let prev_request = ProviderRequest {
        request_id: request_id.into(),
        conversation_id: conversation_id.into(),
        model_id: "test-model".into(),
        messages: vec![],
        system_prompt: None,
        developer_prompt: None,
        attachments: None,
        tool_definitions: Vec::new(),
        generation_controls: None,
        response_format: None,
        web_search: None,
    };

    let continuation = StreamManager::new()
        .build_continuation_request(&state, &prev_request, &[])
        .await
        .expect("build_continuation_request should succeed");

    let tool = continuation
        .messages
        .iter()
        .find(|m| m.role == MessageRole::Tool)
        .expect("should have a tool message");
    assert_eq!(
        tool.parts[0].content.as_deref(),
        Some("Tool executed but no output was recorded."),
        "fallback message expected when tool_result row is missing"
    );
}

// ─── Tool result truncation ───────────────────────────────────────────────

#[tokio::test]
async fn tool_result_truncation_works_for_large_outputs() {
    // The `build_continuation_request` method truncates tool results at
    // 50,000 characters. We test this by inserting a very large tool result
    // and verifying the continuation content is truncated with the suffix.
    let pool = common::setup_pool().await;
    let conversation_id = "conv-trunc";
    let request_id = "req-trunc";
    conversations::ensure_exists(&pool, conversation_id)
        .await
        .unwrap();

    let user_msg = Message {
        id: "user-trunc".into(),
        conversation_id: conversation_id.into(),
        role: MessageRole::User,
        author_label: None,
        provider_message_id: None,
        request_id: None,
        interrupted_at: None,
        metadata: None,
        parts: vec![MessagePart {
            id: "user-trunc/p0".into(),
            message_id: "user-trunc".into(),
            index: 0,
            kind: MessagePartKind::Text,
            content: Some("fetch large data".into()),
            mime_type: None,
            tool_call_id: None,
            artifact_id: None,
            attachment_id: None,
            blob_ref: None,
            metadata: None,
            created_at: "2026-06-27T00:00:00Z".into(),
        }],
        created_at: "2026-06-27T00:00:00Z".into(),
    };
    messages::persist_request_messages(&pool, &[user_msg])
        .await
        .unwrap();

    // Seed an assistant round
    event_log::append_and_apply(
        &pool,
        conversation_id,
        request_id,
        &ProviderEvent::MessageStart {
            request_id: request_id.into(),
            index: 0,
        },
    )
    .await
    .unwrap();
    event_log::append_and_apply(
        &pool,
        conversation_id,
        request_id,
        &ProviderEvent::ContentBlockStart {
            request_id: request_id.into(),
            block_id: "block-0".into(),
            index: 0,
            block_kind: "text".into(),
        },
    )
    .await
    .unwrap();
    event_log::append_and_apply(
        &pool,
        conversation_id,
        request_id,
        &ProviderEvent::ContentDelta {
            request_id: request_id.into(),
            block_id: "block-0".into(),
            index: 1,
            content: "Fetching data.".into(),
        },
    )
    .await
    .unwrap();
    event_log::append_and_apply(
        &pool,
        conversation_id,
        request_id,
        &ProviderEvent::MessageComplete {
            request_id: request_id.into(),
            index: 2,
            finish_reason: "tool_calls".into(),
        },
    )
    .await
    .unwrap();

    // Insert a tool call with a very large result (60K chars)
    tool_calls::insert_tool_call(
        &pool,
        &ToolCallRecord {
            id: "call-large".into(),
            tool_id: "fetch_data".into(),
            request_id: request_id.into(),
            status: ToolCallStatus::Completed,
            arguments: Some(json!({"size": "large"})),
            result: None,
            error: None,
            approved_at: None,
            completed_at: Some("2026-06-27T00:00:01Z".into()),
        },
    )
    .await
    .unwrap();

    // Create a large string: 60,000 characters
    let large_content = "A".repeat(60_000);
    tool_calls::insert_tool_result(
        &pool,
        &conduit_desktop::encryption::Encryption::off(),
        "call-large",
        &json!(large_content),
        false,
    )
    .await
    .unwrap();

    let state = {
        let dir = tempfile::tempdir().unwrap();
        let paths = test_paths(dir.path());
        conduit_desktop::state::AppState::test_instance(pool.clone(), paths)
    };

    let prev_request = ProviderRequest {
        request_id: request_id.into(),
        conversation_id: conversation_id.into(),
        model_id: "test-model".into(),
        messages: vec![],
        system_prompt: None,
        developer_prompt: None,
        attachments: None,
        tool_definitions: Vec::new(),
        generation_controls: None,
        response_format: None,
        web_search: None,
    };

    let continuation = StreamManager::new()
        .build_continuation_request(&state, &prev_request, &[])
        .await
        .expect("build_continuation_request should succeed");

    let tool = continuation
        .messages
        .iter()
        .find(|m| m.role == MessageRole::Tool)
        .expect("should have a tool message");

    let content = tool.parts[0]
        .content
        .as_deref()
        .expect("tool result should have content");

    // The content should be truncated: 50K chars + truncation suffix.
    // The tool result is stored as a JSON Value (`Value::String("AAAA...")`).
    // When `latest_tool_result` returns it, `value.to_string()` produces a
    // JSON-encoded string with surrounding double quotes, so the raw content
    // starts with `"` followed by A's.
    assert!(
        content.len() < 60_000,
        "large tool result should be truncated (len={})",
        content.len()
    );
    assert!(
        content.contains("truncated at 50,000"),
        "truncated content should mention the truncation: got {}",
        content
    );
    // The content should contain the original data (JSON-encoded)
    assert!(
        content.contains("AAAAA"),
        "truncated content should contain original data"
    );
}

// ─── Validation function integration tests ────────────────────────────────

#[test]
fn validate_agent_guardrails_rejects_negative_steps() {
    let guardrails = AgentGuardrails {
        max_steps: 0,
        ..AgentGuardrails::default()
    };
    let err = validation::validate_agent_guardrails(&guardrails).unwrap_err();
    assert!(err.contains("max_steps"), "must mention max_steps: {err}");
}

#[test]
fn validate_agent_guardrails_rejects_excessive_steps() {
    let guardrails = AgentGuardrails {
        max_steps: 99,
        ..AgentGuardrails::default()
    };
    let err = validation::validate_agent_guardrails(&guardrails).unwrap_err();
    assert!(err.contains("50"), "must mention max bound: {err}");
}

#[test]
fn validate_agent_guardrails_rejects_low_wall_clock() {
    let guardrails = AgentGuardrails {
        wall_clock_budget_secs: 10,
        ..AgentGuardrails::default()
    };
    let err = validation::validate_agent_guardrails(&guardrails).unwrap_err();
    assert!(
        err.contains("wall_clock_budget_secs"),
        "must mention wall_clock: {err}"
    );
}

#[test]
fn validate_agent_guardrails_rejects_high_wall_clock() {
    let guardrails = AgentGuardrails {
        wall_clock_budget_secs: 9999,
        ..AgentGuardrails::default()
    };
    let err = validation::validate_agent_guardrails(&guardrails).unwrap_err();
    assert!(
        err.contains("wall_clock_budget_secs"),
        "must mention wall_clock: {err}"
    );
}

#[test]
fn validate_agent_guardrails_accepts_minimum_values() {
    let guardrails = AgentGuardrails {
        max_steps: 1,
        wall_clock_budget_secs: 30,
    };
    validation::validate_agent_guardrails(&guardrails).expect("minimum values should pass");
}

#[test]
fn validate_agent_guardrails_accepts_maximum_values() {
    let guardrails = AgentGuardrails {
        max_steps: 50,
        wall_clock_budget_secs: 1800,
    };
    validation::validate_agent_guardrails(&guardrails).expect("maximum values should pass");
}

// Note: `validate_web_search_domain` is a private function in `validation.rs`.
// It is tested indirectly through `validate_web_search_defaults` which is public.
// The following tests exercise the public validation path.

#[test]
fn validate_web_search_defaults_rejects_empty_domain_via_public_api() {
    let defaults = WebSearchDefaults {
        allowed_domains: vec!["".into()],
        ..WebSearchDefaults::default()
    };
    let err = validation::validate_web_search_defaults(&defaults).unwrap_err();
    assert!(
        err.contains("empty"),
        "empty domain must be rejected: {err}"
    );
}

#[test]
fn validate_web_search_defaults_rejects_domain_without_dot_via_public_api() {
    let defaults = WebSearchDefaults {
        blocked_domains: vec!["localhost".into()],
        ..WebSearchDefaults::default()
    };
    let err = validation::validate_web_search_defaults(&defaults).unwrap_err();
    assert!(
        err.contains("at least one '.'"),
        "domain without dot must be rejected: {err}"
    );
}

#[test]
fn validate_web_search_defaults_rejects_http_prefix_domain() {
    let defaults = WebSearchDefaults {
        allowed_domains: vec!["https://example.com".into()],
        ..WebSearchDefaults::default()
    };
    let err = validation::validate_web_search_defaults(&defaults).unwrap_err();
    assert!(
        err.contains("http(s)://"),
        "http-prefixed domain must be rejected: {err}"
    );
}

#[test]
fn validate_web_search_defaults_accepts_valid_domains() {
    let defaults = WebSearchDefaults {
        allowed_domains: vec![
            "pubmed.ncbi.nlm.nih.gov".into(),
            "example.com".into(),
            "my-site.co.uk".into(),
        ],
        blocked_domains: vec!["bad-site.com".into()],
        ..WebSearchDefaults::default()
    };
    validation::validate_web_search_defaults(&defaults).expect("valid domains should pass");
}

#[test]
fn validate_web_search_defaults_rejects_over_100_entries() {
    let domains: Vec<String> = (0..101).map(|i| format!("host{i}.example.com")).collect();
    let defaults = WebSearchDefaults {
        allowed_domains: domains,
        ..WebSearchDefaults::default()
    };
    let err = validation::validate_web_search_defaults(&defaults).unwrap_err();
    assert!(
        err.contains("100-entry"),
        "too many entries must be rejected: {err}"
    );
}

// ─── StreamManager construction ───────────────────────────────────────────

#[test]
fn stream_manager_default_impl_works() {
    // `Default` for StreamManager delegates to `new()` — constructing it must
    // not panic and must be usable for `build_continuation_request` (the
    // `StreamManager::new()` calls throughout the async tests above already
    // exercise this path; this test pins the Default impl explicitly).
    let manager = StreamManager::default();
    let _ = &manager;
}
