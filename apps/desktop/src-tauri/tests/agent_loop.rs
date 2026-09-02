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
    stream_manager::{CompletedToolCall, CompletionDelivery, RoundOutcome, StreamManager},
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
        branding: root.join("branding"),
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
        produced_text: false,
        error_message: Some("provider unavailable".to_string()),
        error_forwarded: false,
        usage: None,
        completion_event: None,
        round_text: String::new(),
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
        produced_text: false,
        error_message: None,
        error_forwarded: false,
        usage: None,
        completion_event: None,
        round_text: String::new(),
    };
    assert_eq!(outcome.completed_tool_calls.len(), 1);
    assert_eq!(outcome.completed_tool_calls[0].tool_call_id, "call-1");
    assert!(outcome.finished_normally);
}

// ─── Turn completion delivery ─────────────────────────────────────────────
//
// The UI treats `MessageComplete` as end-of-turn: it settles the stream and
// discards everything after it. A multi-round agent turn emits one per round,
// so forwarding the first one made the UI drop the model's final answer — it
// was generated and persisted, but never displayed. `CompletionDelivery`
// withholds each round's completion so the loop can emit exactly one.

#[test]
fn completion_delivery_distinguishes_the_two_paths() {
    assert_ne!(CompletionDelivery::Immediate, CompletionDelivery::Deferred);
}

#[test]
fn round_outcome_carries_a_withheld_completion() {
    let completion = ProviderEvent::MessageComplete {
        request_id: "req-1".into(),
        index: 0,
        finish_reason: "stop".into(),
    };
    let outcome = RoundOutcome {
        completed_tool_calls: Vec::new(),
        finished_normally: true,
        produced_text: false,
        error_message: None,
        error_forwarded: false,
        usage: None,
        completion_event: Some(completion.clone()),
        round_text: String::new(),
    };
    assert_eq!(outcome.completion_event, Some(completion));
}

#[test]
fn round_outcome_default_withholds_nothing() {
    // The `Immediate` path forwards its own completion, so nothing is owed.
    assert!(RoundOutcome::default().completion_event.is_none());
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

// ---------------------------------------------------------------------------
// A turn always terminates, and only runs tools it asked for.
//
// These pin the two halves of a hang seen in the running app: a web-search turn
// that showed "Continuing…" and spun for 368s against a 300s budget with zero
// tokens, having emitted no terminal event at all.
// ---------------------------------------------------------------------------

fn call(name: &str, id: &str) -> CompletedToolCall {
    CompletedToolCall {
        tool_call_id: id.to_string(),
        tool_id: Some(name.to_string()),
        name: name.to_string(),
        arguments: json!({}),
    }
}

fn tool_def(name: &str) -> provider_core::schema::ToolDefinition {
    provider_core::schema::ToolDefinition {
        tool_id: name.to_string(),
        name: name.to_string(),
        description: String::new(),
        input_schema: json!({"type": "object", "properties": {}}),
        permission_level: None,
        display_group: None,
        tenant_scope: None,
        kind: None,
        host_config: None,
    }
}

#[test]
fn runs_only_tool_calls_the_request_declared() {
    let (runnable, undeclared) = conduit_desktop::stream_manager::partition_declared_tool_calls(
        vec![call("write_document", "c1"), call("calculator", "c2")],
        &[tool_def("write_document")],
    );
    assert_eq!(runnable.len(), 1);
    assert_eq!(runnable[0].name, "write_document");
    assert_eq!(
        undeclared.len(),
        1,
        "calculator was never offered this turn"
    );
    assert_eq!(undeclared[0].name, "calculator");
}

/// The live bug. OpenAI's provider-hosted search reports a completed
/// `web_search` call; the renderer never offers `web_search` as a client tool
/// on hosted turns. Executing it re-ran a search the provider had already done
/// and produced a continuation the Responses API had to reject.
#[test]
fn a_provider_hosted_search_is_not_executed_locally() {
    let (runnable, undeclared) = conduit_desktop::stream_manager::partition_declared_tool_calls(
        vec![call("web_search", "ws_68f0c1")],
        // What a document turn actually declares — no web_search.
        &[tool_def("write_document"), tool_def("current_time")],
    );
    assert!(
        runnable.is_empty(),
        "a hosted search must not dispatch to the local builtin of the same name"
    );
    assert_eq!(undeclared.len(), 1);
}

/// Local DuckDuckGo turns *do* declare `web_search`, so partition must run it.
#[test]
fn a_declared_local_web_search_is_runnable() {
    let (runnable, undeclared) = conduit_desktop::stream_manager::partition_declared_tool_calls(
        vec![call("web_search", "ws_local_1"), call("calculator", "c1")],
        &[
            tool_def("web_search"),
            tool_def("web_fetch"),
            tool_def("current_time"),
        ],
    );
    assert_eq!(runnable.len(), 1);
    assert_eq!(runnable[0].name, "web_search");
    assert_eq!(undeclared.len(), 1);
    assert_eq!(undeclared[0].name, "calculator");
}

#[test]
fn declaring_nothing_runs_nothing() {
    let (runnable, undeclared) = conduit_desktop::stream_manager::partition_declared_tool_calls(
        vec![call("clipboard_read", "c1")],
        &[],
    );
    assert!(
        runnable.is_empty(),
        "a registered builtin is not an offered one"
    );
    assert_eq!(undeclared.len(), 1);
}

/// Only the mid-stream error path puts an `Error` on the channel. The other
/// four return before touching it, so the loop owes the terminal event; without
/// it the backend goes silent and the renderer waits forever.
#[test]
fn a_round_error_that_was_never_forwarded_still_terminates_the_turn() {
    let event = conduit_desktop::stream_manager::terminal_event_for_round_error(
        "req-1",
        "HTTP 400: no tool call for that id".to_string(),
        false,
    );
    match event {
        Some(ProviderEvent::Error { request_id, error }) => {
            assert_eq!(request_id, "req-1");
            assert!(
                error.message.contains("400"),
                "the provider's reason must survive"
            );
        }
        other => panic!("expected a terminal Error, got {other:?}"),
    }
}

#[test]
fn a_round_error_already_forwarded_is_not_sent_twice() {
    assert!(
        conduit_desktop::stream_manager::terminal_event_for_round_error(
            "req-1",
            "stream died".to_string(),
            true,
        )
        .is_none(),
        "the mid-stream path already delivered one; a second would be a duplicate"
    );
}

/// The four early returns build their outcome with `..Default::default()`, so
/// the default is what decides whether they are treated as having forwarded.
#[test]
fn an_unforwarded_error_is_the_default() {
    assert!(
        !RoundOutcome::default().error_forwarded,
        "defaulting to true would silently reinstate the hang"
    );
}

// ---------------------------------------------------------------------------
// A turn that ends having produced nothing must say so.
//
// Dropping a provider-hosted `web_search` is correct — it is a record that the
// provider already searched, not a request for us to search. But the loop's
// next check reads an empty runnable list as "the assistant produced a final
// answer", and when the round also produced no text that reading is false.
// Observed live: the response ends `stop` after two `ws_…` search items with no
// message item, and the user gets a search block, no answer, and no error.
// ---------------------------------------------------------------------------

#[test]
fn a_turn_whose_only_output_was_discarded_is_reported() {
    assert!(
        conduit_desktop::stream_manager::round_produced_nothing(
            false,
            &[],
            &[call("web_search", "ws_68f0c1")],
        ),
        "no text and nothing runnable is not a final answer"
    );
}

#[test]
fn a_turn_that_answered_is_not_reported() {
    assert!(
        !conduit_desktop::stream_manager::round_produced_nothing(
            true,
            &[],
            &[call("web_search", "ws_68f0c1")],
        ),
        "the model searched and then answered; that is the normal hosted-search turn"
    );
}

/// The ordinary end of an agent turn: text, no tool calls, nothing dropped.
#[test]
fn a_plain_final_answer_is_not_reported() {
    assert!(!conduit_desktop::stream_manager::round_produced_nothing(
        true,
        &[],
        &[]
    ));
}

/// A round with work still to do is not an empty turn, whatever else it did.
#[test]
fn a_round_with_runnable_tools_is_not_reported() {
    assert!(
        !conduit_desktop::stream_manager::round_produced_nothing(
            false,
            &[call("write_document", "c1")],
            &[call("web_search", "ws_1")],
        ),
        "the turn continues; the document tool has not run yet"
    );
}

/// A silent round that asked for nothing at all is a different event, and one
/// this message could not honestly explain.
#[test]
fn a_silent_round_that_dropped_nothing_is_left_alone() {
    assert!(!conduit_desktop::stream_manager::round_produced_nothing(
        false,
        &[],
        &[]
    ));
}

/// "Something went wrong" is not actionable. The tool whose output was
/// discarded is the one fact that explains the blank answer.
#[test]
fn the_empty_turn_message_names_the_discarded_tool() {
    let msg = conduit_desktop::stream_manager::empty_turn_message(&[
        call("web_search", "ws_1"),
        call("web_search", "ws_2"),
    ]);
    assert!(msg.contains("web_search"), "got: {msg}");
    assert_eq!(
        msg.matches("web_search").count(),
        1,
        "two calls to one tool is one name, not a repeated list: {msg}"
    );
    assert!(
        msg.contains("Settings"),
        "the user needs a way out, not just a diagnosis: {msg}"
    );
}

// ---------------------------------------------------------------------------
// Document-create thrash clamps (create + search turns)
// ---------------------------------------------------------------------------

fn write_html_create(id: &str) -> CompletedToolCall {
    CompletedToolCall {
        tool_call_id: id.to_string(),
        tool_id: Some("write_html_document".to_string()),
        name: "write_html_document".to_string(),
        arguments: json!({ "html": "<p>hi</p>", "title": "News" }),
    }
}

fn write_html_upsert(id: &str, artifact_id: &str) -> CompletedToolCall {
    CompletedToolCall {
        tool_call_id: id.to_string(),
        tool_id: Some("write_html_document".to_string()),
        name: "write_html_document".to_string(),
        arguments: json!({
            "html": "<p>hi</p>",
            "artifact_id": artifact_id,
        }),
    }
}

#[test]
fn parallel_new_document_creates_keep_only_the_first() {
    use conduit_desktop::stream_manager::{classify_document_create_clamps, CreateClampAction};
    let actions = classify_document_create_clamps(
        &[
            write_html_create("c1"),
            write_html_create("c2"),
            write_html_create("c3"),
            call("current_time", "t1"),
        ],
        0,
    );
    assert_eq!(
        actions,
        vec![
            CreateClampAction::Run,
            CreateClampAction::RejectParallel,
            CreateClampAction::RejectParallel,
            CreateClampAction::Run,
        ]
    );
}

#[test]
fn write_with_artifact_id_is_not_a_parallel_create() {
    use conduit_desktop::stream_manager::{
        classify_document_create_clamps, is_new_document_create, CreateClampAction,
    };
    assert!(!is_new_document_create(&write_html_upsert("u1", "art-1")));
    let actions = classify_document_create_clamps(
        &[write_html_create("c1"), write_html_upsert("u1", "art-1")],
        0,
    );
    assert_eq!(
        actions,
        vec![CreateClampAction::Run, CreateClampAction::Run]
    );
}

#[test]
fn turn_create_cap_rejects_further_creates() {
    use conduit_desktop::stream_manager::{
        classify_document_create_clamps, CreateClampAction, MAX_DOCUMENT_CREATES_PER_TURN,
    };
    assert_eq!(MAX_DOCUMENT_CREATES_PER_TURN, 2);
    let actions = classify_document_create_clamps(&[write_html_create("c1")], 2);
    assert_eq!(actions, vec![CreateClampAction::RejectTurnCap]);

    // One create already done: allow one more this round, then parallel siblings reject.
    let actions =
        classify_document_create_clamps(&[write_html_create("c1"), write_html_create("c2")], 1);
    assert_eq!(
        actions,
        vec![CreateClampAction::Run, CreateClampAction::RejectParallel,]
    );
}

#[test]
fn after_create_write_tools_are_stripped_from_continuations() {
    use conduit_desktop::stream_manager::narrow_tools_after_document_create;
    let narrowed = narrow_tools_after_document_create(&[
        tool_def("write_html_document"),
        tool_def("edit_html_document"),
        tool_def("current_time"),
        tool_def("export_document"),
        tool_def("write_markdown_document"),
    ]);
    let names: Vec<&str> = narrowed.iter().map(|t| t.name.as_str()).collect();
    assert!(!names.contains(&"write_html_document"));
    assert!(!names.contains(&"write_markdown_document"));
    assert!(names.contains(&"edit_html_document"));
    assert!(names.contains(&"current_time"));
    assert!(names.contains(&"export_document"));
}

#[test]
fn web_search_turn_cap_rejects_fourth_call() {
    use conduit_desktop::stream_manager::{classify_web_tool_clamps, MAX_WEB_SEARCH_PER_TURN};
    assert_eq!(MAX_WEB_SEARCH_PER_TURN, 3);
    let calls = vec![
        call("web_search", "ws1"),
        call("web_search", "ws2"),
        call("web_search", "ws3"),
        call("web_search", "ws4"),
        call("calculator", "c1"),
    ];
    let rejects = classify_web_tool_clamps(&calls, 0, 0);
    assert!(rejects[0].is_none());
    assert!(rejects[1].is_none());
    assert!(rejects[2].is_none());
    assert!(
        rejects[3].is_some_and(|m| m.contains("maximum number of web_search")),
        "fourth search must refuse: {:?}",
        rejects[3]
    );
    assert!(rejects[4].is_none(), "non-web tools still run");
}

#[test]
fn web_search_cap_counts_prior_rounds() {
    use conduit_desktop::stream_manager::classify_web_tool_clamps;
    let rejects = classify_web_tool_clamps(&[call("web_search", "ws1")], 3, 0);
    assert!(rejects[0].is_some());
}

#[test]
fn after_web_cap_tools_are_stripped_from_continuations() {
    use conduit_desktop::stream_manager::narrow_tools_after_web_cap;
    let narrowed = narrow_tools_after_web_cap(
        &[
            tool_def("web_search"),
            tool_def("web_fetch"),
            tool_def("current_time"),
            tool_def("calculator"),
        ],
        true,
        true,
    );
    let names: Vec<&str> = narrowed.iter().map(|t| t.name.as_str()).collect();
    assert!(!names.contains(&"web_search"));
    assert!(!names.contains(&"web_fetch"));
    assert!(names.contains(&"current_time"));
    assert!(names.contains(&"calculator"));
}

#[test]
fn tool_output_created_flag_detects_new_artifacts() {
    use conduit_desktop::stream_manager::tool_output_created_document;
    assert!(tool_output_created_document(
        &json!({ "ok": true, "created": true })
    ));
    assert!(!tool_output_created_document(
        &json!({ "ok": true, "created": false })
    ));
    assert!(!tool_output_created_document(&json!({ "ok": true })));
}
