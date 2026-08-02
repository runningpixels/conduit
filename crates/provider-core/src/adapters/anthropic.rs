use crate::adapter::{AdapterContext, ModelInfo, ProviderAdapter, StreamParser};
use crate::adapters::{
    message_text, missing_key, normalized_or_err, parse_fixture_stream, wrap_sse_stream,
};
use crate::normalize::NormalizedRequest;
use crate::schema::{
    MessagePart, MessagePartKind, MessageRole, ProviderError, ProviderEvent, ProviderRequest,
    ToolChoice,
};
use crate::transport::{api_key_header, get_json, post_sse, SseRequest};
use async_trait::async_trait;
use futures::stream::Stream;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

const DEFAULT_BASE: &str = "https://api.anthropic.com";

pub struct AnthropicAdapter;

struct AnthropicParser {
    blocks: HashMap<usize, String>,
    tool_calls: HashMap<usize, (String, String, String)>,
}

impl AnthropicParser {
    fn new() -> Self {
        Self {
            blocks: HashMap::new(),
            tool_calls: HashMap::new(),
        }
    }
}

impl StreamParser for AnthropicParser {
    fn parse_chunk(
        &mut self,
        request_id: &str,
        data: &str,
        index: &mut usize,
    ) -> Vec<ProviderEvent> {
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            return vec![];
        };

        let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let mut events = Vec::new();

        match event_type {
            "content_block_start" => {
                let block_index = value
                    .pointer("/index")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                let block = value.pointer("/content_block");
                let block_kind = block
                    .and_then(|b| b.get("type"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("text");
                let block_id = format!("block-{block_index}");
                self.blocks.insert(block_index, block_id.clone());

                if block_kind == "tool_use" {
                    let tool_id = block
                        .and_then(|b| b.get("id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    let name = block
                        .and_then(|b| b.get("name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    self.tool_calls
                        .insert(block_index, (tool_id.clone(), name.clone(), String::new()));
                    events.push(ProviderEvent::ToolCallStart {
                        request_id: request_id.to_string(),
                        tool_call_id: tool_id,
                        index: *index,
                        tool_id: name.clone(),
                        name,
                    });
                } else {
                    events.push(ProviderEvent::ContentBlockStart {
                        request_id: request_id.to_string(),
                        block_id,
                        index: *index,
                        block_kind: block_kind.to_string(),
                    });
                }
                *index += 1;
            }
            "content_block_delta" => {
                let block_index = value
                    .pointer("/index")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                let delta = value.pointer("/delta");
                let delta_type = delta
                    .and_then(|d| d.get("type"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("");

                if delta_type == "thinking_delta" {
                    let content = delta
                        .and_then(|d| d.get("thinking"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let block_id = self
                        .blocks
                        .get(&block_index)
                        .cloned()
                        .unwrap_or_else(|| format!("block-{block_index}"));
                    events.push(ProviderEvent::ReasoningDelta {
                        request_id: request_id.to_string(),
                        block_id,
                        index: *index,
                        content,
                    });
                } else if delta_type == "input_json_delta" {
                    let content = delta
                        .and_then(|d| d.get("partial_json"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    if let Some((tool_call_id, _, args)) = self.tool_calls.get_mut(&block_index) {
                        args.push_str(&content);
                        events.push(ProviderEvent::ToolCallDelta {
                            request_id: request_id.to_string(),
                            tool_call_id: tool_call_id.clone(),
                            index: *index,
                            content,
                        });
                    }
                } else {
                    let content = delta
                        .and_then(|d| d.get("text"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let block_id = self
                        .blocks
                        .get(&block_index)
                        .cloned()
                        .unwrap_or_else(|| format!("block-{block_index}"));
                    events.push(ProviderEvent::ContentDelta {
                        request_id: request_id.to_string(),
                        block_id,
                        index: *index,
                        content,
                    });
                }
                *index += 1;
            }
            "content_block_stop" => {
                let block_index = value
                    .pointer("/index")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                if let Some((tool_call_id, _, args)) = self.tool_calls.remove(&block_index) {
                    let arguments =
                        serde_json::from_str(&args).unwrap_or_else(|_| json!({ "raw": args }));
                    events.push(ProviderEvent::ToolCallComplete {
                        request_id: request_id.to_string(),
                        tool_call_id,
                        index: *index,
                        arguments,
                    });
                } else {
                    let block_id = self
                        .blocks
                        .remove(&block_index)
                        .unwrap_or_else(|| format!("block-{block_index}"));
                    events.push(ProviderEvent::ContentBlockStop {
                        request_id: request_id.to_string(),
                        block_id,
                        index: *index,
                    });
                }
                *index += 1;
            }
            "message_delta" => {
                if let Some(usage) = value.pointer("/usage") {
                    events.push(ProviderEvent::Usage {
                        request_id: request_id.to_string(),
                        usage: crate::schema::ProviderUsage {
                            input_tokens: usage.get("input_tokens").and_then(|v| v.as_u64()),
                            output_tokens: usage.get("output_tokens").and_then(|v| v.as_u64()),
                            cache_tokens: None,
                            cost_hint: None,
                        },
                    });
                    *index += 1;
                }
            }
            "ping" => {
                events.push(ProviderEvent::Ping {
                    request_id: request_id.to_string(),
                });
                *index += 1;
            }
            "error" => {
                let message = value
                    .pointer("/error/message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Anthropic stream error")
                    .to_string();
                events.push(ProviderEvent::Error {
                    request_id: request_id.to_string(),
                    error: ProviderError {
                        provider_code: value
                            .pointer("/error/type")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                        retryable: false,
                        message,
                    },
                });
            }
            _ => {}
        }

        events
    }
}

fn build_payload(normalized: &NormalizedRequest) -> Value {
    let request = &normalized.request;
    let mut messages = Vec::new();

    for message in &request.messages {
        match message.role {
            MessageRole::Assistant => {
                // Collect ToolCall-kind parts (R4: typed variant instead of metadata digging)
                let tool_call_parts: Vec<&MessagePart> = message
                    .parts
                    .iter()
                    .filter(|p| p.kind == MessagePartKind::ToolCall)
                    .collect();

                if !tool_call_parts.is_empty() {
                    // Build content array with text + tool_use blocks
                    let text_content = message_text(message);
                    let mut content: Vec<Value> = Vec::new();

                    if !text_content.is_empty() {
                        content.push(json!({
                            "type": "text",
                            "text": text_content,
                        }));
                    }

                    for p in &tool_call_parts {
                        let name = p
                            .metadata
                            .as_ref()
                            .and_then(|m| m.get("name").and_then(|v| v.as_str()))
                            .unwrap_or("");
                        let raw_args = p.content.as_deref().unwrap_or("{}");
                        // Anthropic expects tool_use.input as a JSON object, not a string.
                        let input: serde_json::Value =
                            serde_json::from_str(raw_args).unwrap_or(serde_json::json!({}));
                        content.push(json!({
                            "type": "tool_use",
                            "id": p.tool_call_id.as_deref().unwrap_or(""),
                            "name": name,
                            "input": input,
                        }));
                    }

                    messages.push(json!({
                        "role": "assistant",
                        "content": content,
                    }));
                } else {
                    // Fallback: check metadata-based tool_calls for backward compat
                    let legacy_tc = message
                        .parts
                        .iter()
                        .find_map(|p| p.metadata.as_ref()?.get("tool_calls"))
                        .and_then(|v| v.as_array());
                    if let Some(tc_array) = legacy_tc {
                        let text_content = message_text(message);
                        let mut content: Vec<Value> = Vec::new();
                        if !text_content.is_empty() {
                            content.push(json!({
                                "type": "text",
                                "text": text_content,
                            }));
                        }
                        for tc in tc_array {
                            let input = tc
                                .get("arguments")
                                .cloned()
                                .unwrap_or(serde_json::json!({}));
                            let input = match input {
                                serde_json::Value::String(s) => {
                                    serde_json::from_str(&s).unwrap_or(serde_json::json!({}))
                                }
                                other => other,
                            };
                            content.push(json!({
                                "type": "tool_use",
                                "id": tc.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or(""),
                                "name": tc.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                                "input": input,
                            }));
                        }
                        messages.push(json!({
                            "role": "assistant",
                            "content": content,
                        }));
                    } else {
                        // Regular assistant text message
                        messages.push(json!({
                            "role": "assistant",
                            "content": message_text(message),
                        }));
                    }
                }
            }
            MessageRole::Tool => {
                // Tool result message — Anthropic sends tool_result blocks in a user message.
                // Combine all ToolResult parts into a single user message.
                let tool_results: Vec<Value> = message
                    .parts
                    .iter()
                    .filter(|p| p.kind == MessagePartKind::ToolResult)
                    .map(|p| {
                        let mut block = json!({
                            "type": "tool_result",
                            "tool_use_id": p.tool_call_id.as_deref().unwrap_or(""),
                            "content": p.content.as_deref().unwrap_or(""),
                        });
                        // If metadata contains is_error, propagate it
                        if let Some(is_err) = p
                            .metadata
                            .as_ref()
                            .and_then(|m| m.get("is_error"))
                            .and_then(|v| v.as_bool())
                        {
                            if is_err {
                                block["is_error"] = json!(true);
                            }
                        }
                        block
                    })
                    .collect();

                if !tool_results.is_empty() {
                    messages.push(json!({
                        "role": "user",
                        "content": tool_results,
                    }));
                }
            }
            MessageRole::User => {
                messages.push(json!({
                    "role": "user",
                    "content": message_text(message),
                }));
            }
            MessageRole::System | MessageRole::Developer => {
                // Anthropic handles system/developer separately, skip here
                continue;
            }
        }
    }

    let mut body = json!({
      "model": request.model_id,
      "max_tokens": request.generation_controls.as_ref().and_then(|c| c.max_tokens).unwrap_or(4096),
      "messages": messages,
      "stream": true,
    });

    if let Some(system) = &request.system_prompt {
        body["system"] = json!(system);
    }

    if !request.tool_definitions.is_empty() {
        let tools: Vec<Value> = request
            .tool_definitions
            .iter()
            .map(|tool| {
                json!({
                  "name": tool.name,
                  "description": tool.description,
                  "input_schema": tool.input_schema,
                })
            })
            .collect();
        body["tools"] = json!(tools);
    }

    if let Some(controls) = &request.generation_controls {
        if let Some(temp) = controls.temperature {
            body["temperature"] = json!(temp);
        }
        if let Some(top_p) = controls.top_p {
            body["top_p"] = json!(top_p);
        }
        if let Some(stops) = &controls.stop_sequences {
            body["stop_sequences"] = json!(stops);
        }
        if let Some(choice) = &controls.tool_choice {
            body["tool_choice"] = match choice {
                ToolChoice::Auto => json!({"type": "auto"}),
                ToolChoice::None => json!({"type": "none"}),
                ToolChoice::Required => json!({"type": "any"}),
                ToolChoice::Specific { tool_id } => json!({"type": "tool", "name": tool_id}),
            };
        }
    }

    body
}

fn base_url(ctx: &AdapterContext) -> String {
    ctx.base_url
        .clone()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE.to_string())
}

/// Parses the Anthropic `/v1/models` response into `ModelInfo`s. Returns an
/// error (rather than a fabricated list) when the response lacks a `data`
/// array, so a malformed or unauthorized response surfaces honestly.
fn parse_model_list(response: &serde_json::Value) -> Result<Vec<ModelInfo>, ProviderError> {
    let items = response
        .pointer("/data")
        .and_then(|d| d.as_array())
        .ok_or_else(|| {
            crate::error::fatal("anthropic /v1/models response did not contain a data array")
        })?;

    let models = items
        .iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.to_string();
            Some(ModelInfo {
                id,
                display_name: item
                    .get("display_name")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            })
        })
        .collect();

    Ok(models)
}

#[async_trait]
impl ProviderAdapter for AnthropicAdapter {
    fn id(&self) -> &'static str {
        "anthropic"
    }

    fn display_name(&self) -> &'static str {
        "Anthropic"
    }

    async fn validate_credentials(&self, ctx: &AdapterContext) -> Result<(), ProviderError> {
        let key = ctx.api_key.as_deref().ok_or_else(missing_key)?;
        let cancel = CancellationToken::new();
        let _ = get_json(
            &ctx.http,
            &format!("{}/v1/models", base_url(ctx)),
            api_key_header(key)?,
            cancel,
        )
        .await?;
        Ok(())
    }

    async fn list_models(&self, ctx: &AdapterContext) -> Result<Vec<ModelInfo>, ProviderError> {
        let key = ctx.api_key.as_deref().ok_or_else(missing_key)?;
        let cancel = CancellationToken::new();
        let response = get_json(
            &ctx.http,
            &format!("{}/v1/models", base_url(ctx)),
            api_key_header(key)?,
            cancel,
        )
        .await?;

        let models = parse_model_list(&response)?;
        Ok(models)
    }

    async fn stream_chat(
        &self,
        request: ProviderRequest,
        ctx: AdapterContext,
        cancel: CancellationToken,
    ) -> Result<Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>, ProviderError> {
        let key = ctx.api_key.as_deref().ok_or_else(missing_key)?;
        let normalized = normalized_or_err(request)?;
        let request_id = normalized.request.request_id.clone();
        let body = build_payload(&normalized);

        let sse = post_sse(
            &ctx.http,
            SseRequest {
                url: format!("{}/v1/messages", base_url(&ctx)),
                headers: api_key_header(key)?,
                body,
            },
            cancel,
        )
        .await?;

        Ok(wrap_sse_stream(request_id, AnthropicParser::new(), sse))
    }
}

pub fn parse_fixture(request_id: &str, fixture: &str) -> Vec<ProviderEvent> {
    parse_fixture_stream(&mut AnthropicParser::new(), request_id, fixture, |line| {
        line.strip_prefix("data:").map(str::trim)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_text_fixture() {
        let fixture = include_str!("../../tests/fixtures/anthropic/plain_text.sse");
        let events = parse_fixture("req-1", fixture);
        assert!(events
            .iter()
            .any(|e| matches!(e, ProviderEvent::ContentDelta { .. })));
    }

    #[test]
    fn list_models_parses_data_array() {
        let response = serde_json::json!({
          "data": [
            { "id": "claude-sonnet-4-20250514", "display_name": "Claude Sonnet 4" },
            { "id": "claude-3-5-haiku-20241022" }
          ]
        });
        let models = parse_model_list(&response).expect("valid response parses");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "claude-sonnet-4-20250514");
        assert_eq!(models[0].display_name.as_deref(), Some("Claude Sonnet 4"));
        assert!(models[1].display_name.is_none());
    }

    #[test]
    fn list_models_errors_when_data_absent() {
        // L2: a malformed/unauthorized response must surface as an error, not a
        // fabricated list of models the user's key may not be entitled to.
        let response = serde_json::json!({ "error": "unauthorized" });
        let result = parse_model_list(&response);
        assert!(
            result.is_err(),
            "expected Err for response without data array"
        );
        if let Err(e) = result {
            assert!(
                !e.retryable,
                "malformed-shape error should not be retryable"
            );
        }
    }
}
