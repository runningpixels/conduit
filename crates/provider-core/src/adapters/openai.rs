use crate::adapter::{AdapterContext, ModelInfo, ProviderAdapter, StreamParser};
use crate::adapters::{
    message_text, missing_key, normalized_or_err, parse_fixture_stream, role_to_string,
    wrap_sse_stream,
};
use crate::normalize::NormalizedRequest;
use crate::schema::{
    GenerationControls, ProviderError, ProviderEvent, ProviderRequest, ToolChoice,
};
use crate::transport::{bearer_header, get_json, post_sse, SseRequest};
use async_trait::async_trait;
use futures::stream::Stream;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

const DEFAULT_BASE: &str = "https://api.openai.com/v1";

pub struct OpenAiAdapter {
    pub provider_id: &'static str,
    pub display: &'static str,
    pub default_base: &'static str,
}

impl OpenAiAdapter {
    pub fn official() -> Self {
        Self {
            provider_id: "openai",
            display: "OpenAI",
            default_base: DEFAULT_BASE,
        }
    }

    pub fn compat(default_base: &'static str) -> Self {
        Self {
            provider_id: "openai_compat",
            display: "OpenAI Compatible",
            default_base,
        }
    }
}

struct OpenAiParser {
    blocks: HashMap<u32, String>,
    tool_calls: HashMap<u32, (String, String, String, String)>,
}

impl OpenAiParser {
    fn new() -> Self {
        Self {
            blocks: HashMap::new(),
            tool_calls: HashMap::new(),
        }
    }
}

impl StreamParser for OpenAiParser {
    fn parse_chunk(
        &mut self,
        request_id: &str,
        data: &str,
        index: &mut usize,
    ) -> Vec<ProviderEvent> {
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            return vec![];
        };

        let mut events = Vec::new();

        // OpenAI (and compat proxies) can stream errors in-band as
        // `{"error": {...}}` chunks — an invalid model, a content-policy
        // rejection, or a mid-stream proxy failure. Without this branch the
        // parser returned `vec![]`, the error was silently dropped, and
        // `wrap_sse_stream` then emitted a bare `MessageComplete` — producing
        // a blank assistant bubble with no diagnostics. Surface it as a
        // `ProviderEvent::Error` instead, mirroring the Anthropic parser.
        if let Some(err) = value.get("error") {
            let message = err
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("OpenAI stream error")
                .to_string();
            events.push(ProviderEvent::Error {
                request_id: request_id.to_string(),
                error: ProviderError {
                    provider_code: err
                        .get("type")
                        .or_else(|| err.get("code"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    retryable: false,
                    message,
                },
            });
            return events;
        }

        let choices = value.get("choices").and_then(|c| c.as_array());

        if let Some(choices) = choices {
            for choice in choices {
                let choice_index = choice.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                let delta = choice.get("delta");

                if let Some(delta) = delta {
                    if let Some(content) = delta.get("content").and_then(|v| v.as_str()) {
                        let block_id = match self.blocks.entry(choice_index) {
                            std::collections::hash_map::Entry::Occupied(e) => e.get().clone(),
                            std::collections::hash_map::Entry::Vacant(e) => {
                                let block_id = format!("block-{choice_index}");
                                e.insert(block_id.clone());
                                events.push(ProviderEvent::ContentBlockStart {
                                    request_id: request_id.to_string(),
                                    block_id: block_id.clone(),
                                    index: *index,
                                    block_kind: "text".to_string(),
                                });
                                *index += 1;
                                block_id
                            }
                        };
                        events.push(ProviderEvent::ContentDelta {
                            request_id: request_id.to_string(),
                            block_id,
                            index: *index,
                            content: content.to_string(),
                        });
                        *index += 1;
                    }

                    if let Some(reasoning) = delta
                        .get("reasoning_content")
                        .or_else(|| delta.get("reasoning"))
                        .and_then(|v| v.as_str())
                    {
                        let block_id = format!("reasoning-{choice_index}");
                        events.push(ProviderEvent::ReasoningDelta {
                            request_id: request_id.to_string(),
                            block_id,
                            index: *index,
                            content: reasoning.to_string(),
                        });
                        *index += 1;
                    }

                    if let Some(tool_calls) = delta.get("tool_calls").and_then(|v| v.as_array()) {
                        for tool_call in tool_calls {
                            let tc_index =
                                tool_call.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                            let tool_call_id = tool_call
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or("tool-call")
                                .to_string();
                            let function = tool_call.get("function");
                            let name = function
                                .and_then(|f| f.get("name"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("tool")
                                .to_string();
                            let args_delta = function
                                .and_then(|f| f.get("arguments"))
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();

                            if let std::collections::hash_map::Entry::Vacant(e) =
                                self.tool_calls.entry(tc_index)
                            {
                                e.insert((
                                    tool_call_id.clone(),
                                    name.clone(),
                                    name.clone(),
                                    String::new(),
                                ));
                                events.push(ProviderEvent::ToolCallStart {
                                    request_id: request_id.to_string(),
                                    tool_call_id: tool_call_id.clone(),
                                    index: *index,
                                    tool_id: name.clone(),
                                    name,
                                });
                                *index += 1;
                            }

                            if !args_delta.is_empty() {
                                if let Some((id, _, _, args)) = self.tool_calls.get_mut(&tc_index) {
                                    args.push_str(&args_delta);
                                    events.push(ProviderEvent::ToolCallDelta {
                                        request_id: request_id.to_string(),
                                        tool_call_id: id.clone(),
                                        index: *index,
                                        content: args_delta,
                                    });
                                    *index += 1;
                                }
                            }
                        }
                    }
                }

                if choice.get("finish_reason").and_then(|v| v.as_str()) == Some("tool_calls") {
                    let completed: Vec<_> = self.tool_calls.drain().collect();
                    for (_, (tool_call_id, _, _, args)) in completed {
                        let arguments =
                            serde_json::from_str(&args).unwrap_or_else(|_| json!({ "raw": args }));
                        events.push(ProviderEvent::ToolCallComplete {
                            request_id: request_id.to_string(),
                            tool_call_id,
                            index: *index,
                            arguments,
                        });
                        *index += 1;
                    }
                }
            }
        }

        if let Some(usage) = value.get("usage") {
            events.push(ProviderEvent::Usage {
                request_id: request_id.to_string(),
                usage: crate::schema::ProviderUsage {
                    input_tokens: usage.get("prompt_tokens").and_then(|v| v.as_u64()),
                    output_tokens: usage.get("completion_tokens").and_then(|v| v.as_u64()),
                    cache_tokens: usage
                        .get("prompt_tokens_details")
                        .and_then(|d| d.get("cached_tokens"))
                        .and_then(|v| v.as_u64()),
                    cost_hint: None,
                },
            });
            *index += 1;
        }

        events
    }
}

fn build_payload(normalized: &NormalizedRequest) -> Value {
    let request = &normalized.request;
    let mut messages = Vec::new();

    if let Some(system) = &request.system_prompt {
        messages.push(json!({"role": "system", "content": system}));
    }
    if let Some(developer) = &request.developer_prompt {
        messages.push(json!({"role": "developer", "content": developer}));
    }

    for message in &request.messages {
        // Phase A extension point: full tool call / tool result serialization
        // will replace `message_text` with a dispatcher that emits the correct
        // OpenAI `function_call` / `tool` message shapes when the message
        // contains `ToolCall*` or `ToolResult` parts.
        messages.push(json!({
          "role": role_to_string(&message.role),
          "content": message_text(message),
        }));
    }

    let mut body = json!({
      "model": request.model_id,
      "messages": messages,
      "stream": true,
      "stream_options": { "include_usage": true },
    });

    if !request.tool_definitions.is_empty() {
        let tools: Vec<Value> = request
            .tool_definitions
            .iter()
            .map(|tool| {
                json!({
                  "type": "function",
                  "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.input_schema,
                  }
                })
            })
            .collect();
        body["tools"] = json!(tools);
    }

    if let Some(controls) = &request.generation_controls {
        apply_controls(&mut body, controls);
    }

    body
}

fn apply_controls(body: &mut Value, controls: &GenerationControls) {
    if let Some(temp) = controls.temperature {
        body["temperature"] = json!(temp);
    }
    if let Some(top_p) = controls.top_p {
        body["top_p"] = json!(top_p);
    }
    if let Some(max_tokens) = controls.max_tokens {
        body["max_tokens"] = json!(max_tokens);
    }
    if let Some(stops) = &controls.stop_sequences {
        body["stop"] = json!(stops);
    }
    if let Some(choice) = &controls.tool_choice {
        body["tool_choice"] = match choice {
            ToolChoice::Auto => json!("auto"),
            ToolChoice::None => json!("none"),
            ToolChoice::Required => json!("required"),
            ToolChoice::Specific { tool_id } => {
                json!({"type": "function", "function": {"name": tool_id}})
            }
        };
    }
}

fn base_url(adapter: &OpenAiAdapter, ctx: &AdapterContext) -> String {
    let base = ctx
        .base_url
        .clone()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| adapter.default_base.to_string());
    base.trim_end_matches('/').to_string()
}

#[async_trait]
impl ProviderAdapter for OpenAiAdapter {
    fn id(&self) -> &'static str {
        self.provider_id
    }

    fn display_name(&self) -> &'static str {
        self.display
    }

    fn is_local(&self) -> bool {
        self.provider_id == "openai_compat"
    }

    async fn validate_credentials(&self, ctx: &AdapterContext) -> Result<(), ProviderError> {
        if self.provider_id == "openai_compat" && ctx.api_key.is_none() {
            let cancel = CancellationToken::new();
            let _ = get_json(
                &ctx.http,
                &format!("{}/models", base_url(self, ctx)),
                bearer_header("noop")?,
                cancel,
            )
            .await;
            return Ok(());
        }
        let key = ctx.api_key.as_deref().ok_or_else(missing_key)?;
        let cancel = CancellationToken::new();
        let _ = get_json(
            &ctx.http,
            &format!("{}/models", base_url(self, ctx)),
            bearer_header(key)?,
            cancel,
        )
        .await?;
        Ok(())
    }

    async fn list_models(&self, ctx: &AdapterContext) -> Result<Vec<ModelInfo>, ProviderError> {
        let cancel = CancellationToken::new();
        let headers = if let Some(key) = ctx.api_key.as_deref() {
            bearer_header(key)?
        } else if self.provider_id == "openai_compat" {
            bearer_header("noop")?
        } else {
            return Err(missing_key());
        };

        let response = get_json(
            &ctx.http,
            &format!("{}/models", base_url(self, ctx)),
            headers,
            cancel,
        )
        .await?;

        let models = response
            .pointer("/data")
            .and_then(|d| d.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let id = item.get("id")?.as_str()?.to_string();
                        Some(ModelInfo {
                            id,
                            display_name: item
                                .get("name")
                                .and_then(|v| v.as_str())
                                .map(str::to_string),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(models)
    }

    async fn stream_chat(
        &self,
        request: ProviderRequest,
        ctx: AdapterContext,
        cancel: CancellationToken,
    ) -> Result<Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>, ProviderError> {
        let normalized = normalized_or_err(request)?;
        let request_id = normalized.request.request_id.clone();
        let body = build_payload(&normalized);

        let headers = if let Some(key) = ctx.api_key.as_deref() {
            bearer_header(key)?
        } else if self.provider_id == "openai_compat" {
            bearer_header("noop")?
        } else {
            return Err(missing_key());
        };

        let sse = post_sse(
            &ctx.http,
            SseRequest {
                url: format!("{}/chat/completions", base_url(self, &ctx)),
                headers,
                body,
            },
            cancel,
        )
        .await?;

        Ok(wrap_sse_stream(request_id, OpenAiParser::new(), sse))
    }
}

pub fn parse_fixture(request_id: &str, fixture: &str) -> Vec<ProviderEvent> {
    parse_fixture_stream(&mut OpenAiParser::new(), request_id, fixture, |line| {
        line.strip_prefix("data:")
            .map(str::trim)
            .filter(|data| *data != "[DONE]")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_text_fixture() {
        let fixture = include_str!("../../tests/fixtures/openai/plain_text.sse");
        let events = parse_fixture("req-1", fixture);
        assert!(events
            .iter()
            .any(|e| matches!(e, ProviderEvent::ContentDelta { .. })));
    }

    #[test]
    fn surfaces_in_stream_error_chunk() {
        // An in-band `{"error": {...}}` chunk (invalid model, content-policy
        // rejection, proxy failure) must surface as a `ProviderEvent::Error`,
        // not be silently dropped — the bug that produced a blank bubble with
        // no diagnostics for OpenAI-family providers.
        let fixture =
            "data: {\"error\":{\"message\":\"bad model id\",\"type\":\"invalid_request_error\"}}\n";
        let events = parse_fixture("req-1", fixture);
        assert!(events.iter().any(|e| matches!(
            e,
            ProviderEvent::Error { error, .. } if error.message == "bad model id"
        )));
        assert!(events.iter().any(|e| matches!(
            e,
            ProviderEvent::Error { error, .. } if error.provider_code.as_deref() == Some("invalid_request_error")
        )));
    }
}
