use crate::adapter::{AdapterContext, ModelInfo, ProviderAdapter, StreamParser};
use crate::adapters::{
    message_text, missing_key, normalized_or_err, parse_fixture_stream, wrap_sse_stream,
};
use crate::normalize::NormalizedRequest;
use crate::output_limits::{anthropic_default_max_tokens, FINISH_REASON_LENGTH};
use crate::schema::{
    ContentAnnotation, MessagePart, MessagePartKind, MessageRole, ProviderError, ProviderEvent,
    ProviderRequest, ToolChoice, WebSearchRequest,
};
use crate::transport::{api_key_header, get_json, post_sse, SseRequest};
use async_trait::async_trait;
use futures::stream::{Stream, StreamExt};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

const DEFAULT_BASE: &str = "https://api.anthropic.com";

pub struct AnthropicAdapter;

struct AnthropicParser {
    blocks: HashMap<usize, String>,
    tool_calls: HashMap<usize, (String, String, String)>,
    search_result_blocks: HashSet<usize>,
    /// Set from `message_delta.delta.stop_reason` when the response ran out of
    /// output tokens.
    finish_reason: Option<&'static str>,
}

impl AnthropicParser {
    fn new() -> Self {
        Self {
            blocks: HashMap::new(),
            tool_calls: HashMap::new(),
            search_result_blocks: HashSet::new(),
            finish_reason: None,
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

                if block_kind == "tool_use" || block_kind == "server_tool_use" {
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
                } else if block_kind == "web_search_tool_result" {
                    self.search_result_blocks.insert(block_index);
                    let sources = match block.and_then(|b| b.get("content")) {
                        Some(Value::Array(arr)) => Value::Array(arr.clone()),
                        Some(other) => json!([other]),
                        None => json!([]),
                    };
                    events.push(ProviderEvent::SearchSources {
                        request_id: request_id.to_string(),
                        index: *index,
                        sources,
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
                } else if delta_type == "citations_delta" {
                    if let Some(citation) = delta.and_then(|d| d.get("citation")) {
                        let block_id = self
                            .blocks
                            .get(&block_index)
                            .cloned()
                            .unwrap_or_else(|| format!("block-{block_index}"));
                        if let Some(event) = citation_event(request_id, &block_id, *index, citation)
                        {
                            events.push(event);
                        }
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
                } else if self.search_result_blocks.remove(&block_index) {
                    // Hosted search result block — SearchSources already emitted.
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
                if matches!(
                    value.pointer("/delta/stop_reason").and_then(Value::as_str),
                    Some("max_tokens" | "model_context_window_exceeded")
                ) {
                    self.finish_reason = Some(FINISH_REASON_LENGTH);
                }
                if let Some(usage) = value.pointer("/usage") {
                    events.push(ProviderEvent::Usage {
                        request_id: request_id.to_string(),
                        usage: crate::schema::ProviderUsage {
                            input_tokens: usage.get("input_tokens").and_then(|v| v.as_u64()),
                            output_tokens: usage.get("output_tokens").and_then(|v| v.as_u64()),
                            cache_tokens: usage
                                .get("cache_read_input_tokens")
                                .and_then(|v| v.as_u64()),
                            cache_read_tokens: usage
                                .get("cache_read_input_tokens")
                                .and_then(|v| v.as_u64()),
                            cache_write_tokens: usage
                                .get("cache_creation_input_tokens")
                                .and_then(|v| v.as_u64()),
                            cost_hint: None,
                        },
                    });
                    *index += 1;
                    if let Some(n) = usage
                        .pointer("/server_tool_use/web_search_requests")
                        .and_then(|v| v.as_u64())
                    {
                        if n > 0 {
                            events.push(ProviderEvent::SearchCost {
                                request_id: request_id.to_string(),
                                index: *index,
                                tool_calls: n as u32,
                            });
                            *index += 1;
                        }
                    }
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

    fn finish_reason(&self) -> Option<&str> {
        self.finish_reason
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
                    "content": crate::adapters::anthropic_user_content(message),
                }));
            }
            MessageRole::System | MessageRole::Developer => {
                // Anthropic handles system/developer separately, skip here
                continue;
            }
        }
    }

    let max_tokens = request
        .generation_controls
        .as_ref()
        .and_then(|c| c.max_tokens)
        .unwrap_or_else(|| anthropic_default_max_tokens(&request.model_id));
    let mut body = json!({
      "model": request.model_id,
      "max_tokens": max_tokens,
      "messages": messages,
      "stream": true,
    });

    if let Some(system) = &request.system_prompt {
        body["system"] = json!(system);
    }

    let web_search = request.web_search.as_ref().filter(|w| w.enabled);

    if !request.tool_definitions.is_empty() || web_search.is_some() {
        let mut tools: Vec<Value> = request
            .tool_definitions
            .iter()
            .map(|tool| {
                let mut obj = json!({
                  "name": tool.name,
                  "description": tool.description,
                  "input_schema": tool.input_schema,
                });
                if web_search.is_some() {
                    obj["type"] = json!("custom");
                }
                obj
            })
            .collect();
        if let Some(ws) = web_search {
            tools.push(hosted_web_search_tool(ws));
        }
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

/// The adapter appends `/v1/...` itself. A user-entered base URL is accepted
/// with or without that suffix and with a trailing slash, since vendors
/// document it both ways (`…/api/anthropic` and `…/api/anthropic/v1`).
fn base_url(ctx: &AdapterContext) -> String {
    let configured = ctx.base_url.as_deref().map(str::trim).unwrap_or_default();
    let trimmed = configured.trim_end_matches('/');
    let trimmed = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
    if trimmed.is_empty() {
        DEFAULT_BASE.to_string()
    } else {
        trimmed.to_string()
    }
}

/// A base URL pointed at an Anthropic-compatible third party (Z.ai, a LiteLLM
/// proxy, …) cannot honour Anthropic's hosted `web_search` tool. Strip the
/// search request so the tool is never serialised, and return the event that
/// tells the user why the answer has no search.
fn withhold_hosted_search_off_anthropic(
    request: &mut ProviderRequest,
    resolved_base: &str,
) -> Option<ProviderEvent> {
    let web_search_intent = request.web_search.as_ref().is_some_and(|w| w.enabled);
    if !web_search_intent || endpoint_supports_hosted_search(Some(resolved_base)) {
        return None;
    }
    request.web_search = None;
    Some(ProviderEvent::SearchUnavailable {
        request_id: request.request_id.clone(),
        index: 0,
        code: "endpoint_mismatch".to_string(),
        message: format!(
            "The configured Anthropic-compatible endpoint ({resolved_base}) does not host web search. Falling back to a no-search response."
        ),
    })
}

/// Opt every user-defined tool into fine-grained tool streaming.
///
/// Without `eager_input_streaming` the API buffers and validates each tool
/// parameter before streaming it, so a `write_html_document` call delivers its
/// whole `html` argument in one burst at the end — the UI has nothing to show
/// for the entire time the document is being written. With it, fragments
/// arrive as they are generated. The accumulated input may then be invalid
/// JSON (e.g. a `max_tokens` stop mid-parameter); `content_block_stop` already
/// falls back to `{ "raw": … }` rather than failing the stream.
///
/// Only the first-party endpoint gets the field: Anthropic-compatible third
/// parties may reject an unknown tool property outright. Hosted server tools
/// (`web_search_20250305`) are not user-defined and keep their shape.
fn enable_eager_tool_input(body: &mut Value, resolved_base: &str) {
    if !endpoint_supports_hosted_search(Some(resolved_base)) {
        return;
    }
    let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) else {
        return;
    };
    for tool in tools {
        let user_defined = match tool.get("type").and_then(Value::as_str) {
            None => true,
            Some(kind) => kind == "custom",
        };
        if user_defined {
            tool["eager_input_streaming"] = json!(true);
        }
    }
}

pub(crate) fn endpoint_supports_hosted_search(base_url: Option<&str>) -> bool {
    const ANTHROPIC_HOSTED_SEARCH_HOSTS: &[&str] = &["api.anthropic.com"];
    let Some(raw) = base_url.filter(|s| !s.is_empty()) else {
        return true;
    };
    let Ok(parsed) = url::Url::parse(raw) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    ANTHROPIC_HOSTED_SEARCH_HOSTS.contains(&host)
}

fn hosted_web_search_tool(ws: &WebSearchRequest) -> Value {
    let mut tool = json!({
        "type": "web_search_20250305",
        "name": "web_search",
        "max_uses": 3,
    });
    if let Some(filters) = &ws.filters {
        if let Some(allowed) = &filters.allowed_domains {
            if !allowed.is_empty() {
                tool["allowed_domains"] = json!(allowed);
            }
        }
        if let Some(blocked) = &filters.blocked_domains {
            if !blocked.is_empty() {
                tool["blocked_domains"] = json!(blocked);
            }
        }
    }
    if let Some(loc) = &ws.user_location {
        let mut obj = json!({
            "type": "approximate",
            "country": loc.country,
        });
        if let Some(city) = &loc.city {
            obj["city"] = json!(city);
        }
        if let Some(region) = &loc.region {
            obj["region"] = json!(region);
        }
        tool["user_location"] = obj;
    }
    tool
}

fn citation_event(
    request_id: &str,
    block_id: &str,
    index: usize,
    citation: &Value,
) -> Option<ProviderEvent> {
    let url = citation.get("url").and_then(|v| v.as_str())?;
    if url.is_empty() {
        return None;
    }
    let title = citation
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Some(ProviderEvent::Citation {
        request_id: request_id.to_string(),
        block_id: block_id.to_string(),
        index,
        annotation: ContentAnnotation::UrlCitation {
            url: url.to_string(),
            title,
            start_index: 0,
            end_index: 0,
        },
    })
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
        mut request: ProviderRequest,
        ctx: AdapterContext,
        cancel: CancellationToken,
    ) -> Result<Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>, ProviderError> {
        let key = ctx.api_key.as_deref().ok_or_else(missing_key)?;
        let web_search_intent = request
            .web_search
            .as_ref()
            .map(|w| w.enabled)
            .unwrap_or(false);
        if ctx.local_only && web_search_intent {
            return Err(ProviderError {
                provider_code: Some("local_only_block".to_string()),
                retryable: false,
                message: "Web search is disabled while local-only mode is on.".to_string(),
            });
        }

        let search_unavailable =
            withhold_hosted_search_off_anthropic(&mut request, &base_url(&ctx));

        let normalized = normalized_or_err(request)?;
        let request_id = normalized.request.request_id.clone();
        let mut body = build_payload(&normalized);
        enable_eager_tool_input(&mut body, &base_url(&ctx));

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

        let inner = wrap_sse_stream(request_id, AnthropicParser::new(), sse);
        if let Some(unavailable) = search_unavailable {
            let prefix = async_stream::stream! {
                yield unavailable;
            };
            Ok(Box::pin(prefix.chain(inner)))
        } else {
            Ok(inner)
        }
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

    #[test]
    fn payload_includes_base64_image_block() {
        use crate::schema::Message;
        let request = ProviderRequest {
            request_id: "req-vision".into(),
            conversation_id: "conv-1".into(),
            model_id: "claude-sonnet-4".into(),
            messages: vec![Message {
                id: "m1".into(),
                conversation_id: "conv-1".into(),
                role: MessageRole::User,
                author_label: None,
                provider_message_id: None,
                request_id: None,
                interrupted_at: None,
                metadata: None,
                parts: vec![
                    MessagePart {
                        id: "p1".into(),
                        message_id: "m1".into(),
                        index: 0,
                        kind: MessagePartKind::Text,
                        content: Some("look".into()),
                        mime_type: None,
                        tool_call_id: None,
                        artifact_id: None,
                        attachment_id: None,
                        blob_ref: None,
                        metadata: None,
                        created_at: "now".into(),
                    },
                    MessagePart {
                        id: "p2".into(),
                        message_id: "m1".into(),
                        index: 1,
                        kind: MessagePartKind::Image,
                        content: Some("QUJD".into()),
                        mime_type: Some("image/jpeg".into()),
                        tool_call_id: None,
                        artifact_id: None,
                        attachment_id: Some("att-1".into()),
                        blob_ref: None,
                        metadata: None,
                        created_at: "now".into(),
                    },
                ],
                created_at: "now".into(),
            }],
            system_prompt: None,
            developer_prompt: None,
            attachments: None,
            tool_definitions: vec![],
            generation_controls: None,
            response_format: None,
            web_search: None,
        };
        let body = build_payload(&NormalizedRequest { request });
        let content = body
            .pointer("/messages/0/content")
            .and_then(|v| v.as_array())
            .expect("content blocks");
        assert_eq!(content[0]["type"], "text");
        assert_eq!(content[1]["type"], "image");
        assert_eq!(
            content[1]
                .pointer("/source/media_type")
                .and_then(|v| v.as_str()),
            Some("image/jpeg")
        );
        assert_eq!(
            content[1].pointer("/source/data").and_then(|v| v.as_str()),
            Some("QUJD")
        );
    }

    fn user_request(web_search: Option<crate::schema::WebSearchRequest>) -> ProviderRequest {
        use crate::schema::Message;
        ProviderRequest {
            request_id: "req-search".into(),
            conversation_id: "conv-1".into(),
            model_id: "claude-sonnet-4".into(),
            messages: vec![Message {
                id: "m1".into(),
                conversation_id: "conv-1".into(),
                role: MessageRole::User,
                author_label: None,
                provider_message_id: None,
                request_id: None,
                interrupted_at: None,
                metadata: None,
                parts: vec![MessagePart {
                    id: "p1".into(),
                    message_id: "m1".into(),
                    index: 0,
                    kind: MessagePartKind::Text,
                    content: Some("What's the weather in Paris?".into()),
                    mime_type: None,
                    tool_call_id: None,
                    artifact_id: None,
                    attachment_id: None,
                    blob_ref: None,
                    metadata: None,
                    created_at: "now".into(),
                }],
                created_at: "now".into(),
            }],
            system_prompt: None,
            developer_prompt: None,
            attachments: None,
            tool_definitions: vec![],
            generation_controls: None,
            response_format: None,
            web_search,
        }
    }

    #[test]
    fn payload_injects_hosted_web_search_tool() {
        let request = user_request(Some(crate::schema::WebSearchRequest {
            enabled: true,
            search_context_size: None,
            filters: Some(crate::schema::WebSearchFilters {
                allowed_domains: Some(vec!["weather.gov".into()]),
                blocked_domains: None,
            }),
            external_web_access: None,
            return_token_budget: None,
            user_location: Some(crate::schema::UserLocation {
                country: "FR".into(),
                city: Some("Paris".into()),
                region: None,
            }),
            include_sources: None,
        }));
        let body = build_payload(&NormalizedRequest { request });
        let tools = body
            .get("tools")
            .and_then(|v| v.as_array())
            .expect("tools array");
        let ws = tools
            .iter()
            .find(|t| t.get("type").and_then(|v| v.as_str()) == Some("web_search_20250305"))
            .expect("hosted web search tool");
        assert_eq!(ws.get("name").and_then(|v| v.as_str()), Some("web_search"));
        assert_eq!(ws.get("max_uses").and_then(|v| v.as_u64()), Some(3));
        assert_eq!(
            ws.get("allowed_domains")
                .and_then(|v| v.as_array())
                .map(|a| a.len()),
            Some(1)
        );
        assert_eq!(
            ws.pointer("/user_location/country")
                .and_then(|v| v.as_str()),
            Some("FR")
        );
    }

    #[test]
    fn payload_omits_hosted_search_when_disabled() {
        let body = build_payload(&NormalizedRequest {
            request: user_request(None),
        });
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn official_anthropic_endpoint_hosts_web_search() {
        assert!(endpoint_supports_hosted_search(Some(
            "https://api.anthropic.com"
        )));
        assert!(endpoint_supports_hosted_search(Some(
            "https://api.anthropic.com/v1"
        )));
        assert!(endpoint_supports_hosted_search(None));
        assert!(!endpoint_supports_hosted_search(Some(
            "https://example.invalid/anthropic"
        )));
    }

    fn search_on() -> Option<crate::schema::WebSearchRequest> {
        Some(crate::schema::WebSearchRequest {
            enabled: true,
            search_context_size: None,
            filters: None,
            external_web_access: None,
            return_token_budget: None,
            user_location: None,
            include_sources: None,
        })
    }

    /// Provider expansion Phase 2: the base-URL field lets `anthropic` point at
    /// a compatible third party. That endpoint must not be sent the hosted
    /// search tool, and the user must be told search was dropped.
    #[test]
    fn third_party_anthropic_endpoint_gets_no_hosted_search_tool() {
        let mut request = user_request(search_on());
        let event =
            withhold_hosted_search_off_anthropic(&mut request, "https://api.z.ai/api/anthropic");
        assert!(
            matches!(event, Some(ProviderEvent::SearchUnavailable { ref code, .. }) if code == "endpoint_mismatch"),
            "expected SearchUnavailable, got {event:?}"
        );
        let body = build_payload(&NormalizedRequest { request });
        assert!(
            body.get("tools").is_none(),
            "hosted search tool leaked: {body}"
        );
    }

    #[test]
    fn official_anthropic_endpoint_keeps_hosted_search_tool() {
        let mut request = user_request(search_on());
        assert!(withhold_hosted_search_off_anthropic(&mut request, &base_url_for(None)).is_none());
        let body = build_payload(&NormalizedRequest { request });
        assert!(body.get("tools").is_some());
    }

    fn tools_body() -> Value {
        json!({
            "tools": [
                { "name": "write_html_document", "input_schema": {} },
                { "name": "uuid", "type": "custom", "input_schema": {} },
                { "name": "web_search", "type": "web_search_20250305" },
            ]
        })
    }

    #[test]
    fn official_endpoint_streams_user_tool_input_eagerly() {
        let mut body = tools_body();
        enable_eager_tool_input(&mut body, DEFAULT_BASE);
        let tools = body["tools"].as_array().expect("tools array");
        assert_eq!(tools[0]["eager_input_streaming"], json!(true));
        assert_eq!(tools[1]["eager_input_streaming"], json!(true));
        assert!(
            tools[2].get("eager_input_streaming").is_none(),
            "hosted server tool must keep its shape: {}",
            tools[2]
        );
    }

    #[test]
    fn third_party_endpoint_gets_no_eager_tool_input_field() {
        let mut body = tools_body();
        enable_eager_tool_input(&mut body, "https://api.z.ai/api/anthropic");
        assert_eq!(body, tools_body());
    }

    #[test]
    fn truncated_eager_tool_input_still_completes_the_call() {
        let mut parser = AnthropicParser::new();
        let mut index = 0;
        let start = r#"{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"write_html_document","input":{}}}"#;
        let delta = r#"{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"html\": \"<p>cut off"}}"#;
        let stop = r#"{"type":"content_block_stop","index":0}"#;
        parser.parse_chunk("req", start, &mut index);
        parser.parse_chunk("req", delta, &mut index);
        let events = parser.parse_chunk("req", stop, &mut index);
        assert!(
            matches!(
                events.as_slice(),
                [ProviderEvent::ToolCallComplete { arguments, .. }] if arguments.get("raw").is_some()
            ),
            "expected a raw fallback completion, got {events:?}"
        );
    }

    #[test]
    fn max_tokens_stop_is_reported_as_length() {
        let fixture = [
            r#"data: {"type":"message_start","message":{"id":"msg_1"}}"#,
            r#"data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"write_html_document","input":{}}}"#,
            r#"data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"title\": \"Report\", \"html\": \"<h1>cut"}}"#,
            r#"data: {"type":"content_block_stop","index":0}"#,
            r#"data: {"type":"message_delta","delta":{"stop_reason":"max_tokens","stop_sequence":null},"usage":{"output_tokens":64000}}"#,
            r#"data: {"type":"message_stop"}"#,
        ]
        .join("\n");
        let events = parse_fixture_stream(&mut AnthropicParser::new(), "req", &fixture, |line| {
            line.strip_prefix("data:").map(str::trim)
        });
        assert!(
            matches!(
                events.last(),
                Some(ProviderEvent::MessageComplete { finish_reason, .. }) if finish_reason == "length"
            ),
            "expected a length completion, got {events:?}"
        );
    }

    #[test]
    fn end_turn_and_tool_use_stops_stay_stop() {
        for reason in ["end_turn", "tool_use", "stop_sequence"] {
            let mut parser = AnthropicParser::new();
            let delta = format!(
                r#"{{"type":"message_delta","delta":{{"stop_reason":"{reason}"}},"usage":{{"output_tokens":12}}}}"#
            );
            parser.parse_chunk("req", &delta, &mut 0);
            assert_eq!(parser.finish_reason(), None, "{reason}");
        }
    }

    #[test]
    fn payload_uses_the_model_output_ceiling_unless_max_tokens_is_set() {
        let body = build_payload(&NormalizedRequest {
            request: user_request(None),
        });
        assert_eq!(body["max_tokens"], json!(64_000));

        let mut request = user_request(None);
        request.generation_controls = Some(crate::schema::GenerationControls {
            temperature: None,
            top_p: None,
            max_tokens: Some(2_048),
            stop_sequences: None,
            tool_choice: None,
        });
        let body = build_payload(&NormalizedRequest { request });
        assert_eq!(body["max_tokens"], json!(2_048));
    }

    /// Clearing the base-URL field (empty string) must restore the default
    /// endpoint, not produce a relative URL.
    #[test]
    fn empty_base_url_falls_back_to_the_default_endpoint() {
        assert_eq!(base_url_for(Some("")), "https://api.anthropic.com");
        assert_eq!(base_url_for(None), "https://api.anthropic.com");
        assert_eq!(base_url_for(Some("  ")), "https://api.anthropic.com");
        for configured in [
            "https://api.z.ai/api/anthropic",
            "https://api.z.ai/api/anthropic/",
            "https://api.z.ai/api/anthropic/v1",
            "https://api.z.ai/api/anthropic/v1/",
        ] {
            assert_eq!(
                base_url_for(Some(configured)),
                "https://api.z.ai/api/anthropic",
                "{configured}"
            );
        }
    }

    fn base_url_for(configured: Option<&str>) -> String {
        base_url(&AdapterContext {
            api_key: Some("sk-test".into()),
            base_url: configured.map(str::to_string),
            http: crate::transport::HttpClient::new(),
            local_only: false,
        })
    }

    #[test]
    fn parses_hosted_web_search_fixture() {
        let fixture = include_str!("../../tests/fixtures/anthropic/web_search.sse");
        let events = parse_fixture("req-search", fixture);
        assert!(
            events.iter().any(|e| matches!(
                e,
                ProviderEvent::ToolCallStart {
                    tool_id,
                    name,
                    ..
                } if tool_id == "web_search" && name == "web_search"
            )),
            "expected ToolCallStart for web_search, got {events:?}"
        );
        assert!(events
            .iter()
            .any(|e| matches!(e, ProviderEvent::ToolCallComplete { .. })));
        assert!(events
            .iter()
            .any(|e| matches!(e, ProviderEvent::SearchSources { .. })));
        assert!(events.iter().any(|e| matches!(
            e,
            ProviderEvent::Citation {
                annotation: ContentAnnotation::UrlCitation { url, .. },
                ..
            } if url == "https://example.com/paris"
        )));
        assert!(events
            .iter()
            .any(|e| matches!(e, ProviderEvent::SearchCost { tool_calls: 1, .. })));
        assert!(events
            .iter()
            .any(|e| matches!(e, ProviderEvent::ContentDelta { .. })));
    }
}
