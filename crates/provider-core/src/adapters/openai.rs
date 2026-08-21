use crate::adapter::{AdapterContext, ModelInfo, ProviderAdapter, StreamParser};
use crate::adapters::{
    message_text, missing_key, normalized_or_err, parse_fixture_stream, role_to_string,
    wrap_sse_stream,
};
use crate::normalize::NormalizedRequest;
use crate::schema::{
    ContentAnnotation, GenerationControls, MessagePart, MessagePartKind, MessageRole,
    ProviderError, ProviderEvent, ProviderRequest, SearchContextSize, ToolChoice,
};
use crate::transport::{get_json, post_sse, SseRequest};
use async_trait::async_trait;
use futures::stream::{Stream, StreamExt};
use serde_json::{json, Value};
use std::collections::HashMap;

/// Phase 7 / M-WebSearch: merge a provider-agnostic hosted-tool config blob
/// onto an existing `tools[]` entry. Shallow merge — keys in `overlay` win.
/// Used so adapters can serialize a `ToolDefinition.host_config` onto the
/// provider-specific tool object without forking the type system.
fn merge_json(base: Value, overlay: Value) -> Value {
    match (base, overlay) {
        (Value::Object(mut a), Value::Object(b)) => {
            for (k, v) in b {
                a.insert(k, v);
            }
            Value::Object(a)
        }
        (_, b) => b,
    }
}
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

const DEFAULT_BASE: &str = "https://api.openai.com/v1";

#[derive(Clone)]
pub struct OpenAiAdapter {
    pub provider_id: &'static str,
    pub display: &'static str,
    pub default_base: &'static str,
    pub optional_api_key: bool,
    pub is_local_endpoint: bool,
    pub extra_headers: &'static [(&'static str, &'static str)],
    /// When true, always POST to `/chat/completions` (e.g. OpenCode Zen chat models).
    pub force_chat_completions: bool,
    /// When true, always POST to `/responses` with the Responses-API payload shape
    /// (e.g. OpenCode Zen GPT models).
    pub force_responses: bool,
}

impl OpenAiAdapter {
    pub fn official() -> Self {
        Self {
            provider_id: "openai",
            display: "OpenAI",
            default_base: DEFAULT_BASE,
            optional_api_key: false,
            is_local_endpoint: false,
            extra_headers: &[],
            force_chat_completions: false,
            force_responses: false,
        }
    }

    pub fn compat(default_base: &'static str) -> Self {
        Self {
            provider_id: "openai_compat",
            display: "OpenAI Compatible",
            default_base,
            optional_api_key: true,
            is_local_endpoint: true,
            extra_headers: &[],
            force_chat_completions: false,
            force_responses: false,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn preset(
        provider_id: &'static str,
        display: &'static str,
        default_base: &'static str,
        is_local: bool,
        optional_api_key: bool,
        extra_headers: &'static [(&'static str, &'static str)],
        force_chat_completions: bool,
        force_responses: bool,
    ) -> Self {
        Self {
            provider_id,
            display,
            default_base,
            optional_api_key,
            is_local_endpoint: is_local,
            extra_headers,
            force_chat_completions,
            force_responses,
        }
    }

    fn request_headers(
        &self,
        ctx: &AdapterContext,
    ) -> Result<reqwest::header::HeaderMap, ProviderError> {
        let token = if let Some(key) = ctx.api_key.as_deref() {
            key
        } else if self.optional_api_key {
            "noop"
        } else {
            return Err(missing_key());
        };
        crate::transport::bearer_header_with_extras(token, self.extra_headers)
    }
}

struct OpenAiParser {
    blocks: HashMap<u32, String>,
    tool_calls: HashMap<u32, (String, String, String, String)>,
    /// Phase 7 / M-WebSearch: open hosted web-search tool calls keyed by the
    /// provider's `ws_*` id. Each holds (tool_call_id, query_text, status)
    /// so we can emit `ToolCallStart` on `output_item.added` and
    /// `ToolCallComplete` on `output_item.done`.
    search_calls: HashMap<String, (String, String, String)>,
    /// Count of completed hosted web-search tool calls in this response.
    /// Surfaced as `ProviderEvent::SearchCost { tool_calls }` so the
    /// usage summary can show "Web searches: N".
    completed_search_calls: u32,
    /// Responses-API function calls, keyed by the item id (`fc_*`) that the
    /// argument-delta events carry, holding the `call_id` the *rest of the
    /// system* uses. The two ids are different and only the item id appears on
    /// `response.function_call_arguments.delta`, so without this map the
    /// streamed arguments cannot be attributed to the call they belong to.
    function_calls: HashMap<String, String>,
}

impl OpenAiParser {
    fn new() -> Self {
        Self {
            blocks: HashMap::new(),
            tool_calls: HashMap::new(),
            search_calls: HashMap::new(),
            completed_search_calls: 0,
            function_calls: HashMap::new(),
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
                    input_tokens: usage
                        .get("prompt_tokens")
                        .and_then(|v| v.as_u64())
                        .or_else(|| usage.get("input_tokens").and_then(|v| v.as_u64())),
                    output_tokens: usage
                        .get("completion_tokens")
                        .and_then(|v| v.as_u64())
                        .or_else(|| usage.get("output_tokens").and_then(|v| v.as_u64())),
                    cache_tokens: usage
                        .get("prompt_tokens_details")
                        .and_then(|d| d.get("cached_tokens"))
                        .and_then(|v| v.as_u64()),
                    cache_read_tokens: usage
                        .get("prompt_tokens_details")
                        .and_then(|d| d.get("cached_tokens"))
                        .and_then(|v| v.as_u64()),
                    cache_write_tokens: None,
                    cost_hint: usage
                        .pointer("/cost_hint")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                },
            });
            *index += 1;
        }

        // -----------------------------------------------------------------
        // Phase 7 / M-WebSearch: Responses-API dispatch.
        //
        // OpenAI's hosted web_search tool surfaces as a discrete output item
        // rather than a function tool call. Items come wrapped in
        // `response.output_item.added` / `response.output_item.done` events
        // with the item under `.item`, or sometimes as a top-level item with
        // `type == "web_search_call"`. URL citations ride the message item's
        // `content[].annotations` arrays.
        //
        // The two helpers below keep the dispatch table out of `parse_chunk`
        // so the chat-completions path above stays untouched.
        // -----------------------------------------------------------------
        if let Some(events_from_item) = self.parse_openai_response_item(request_id, &value, index) {
            events.extend(events_from_item);
        }
        if let Some(events_from_args) =
            self.parse_openai_response_function_args(request_id, &value, index)
        {
            events.extend(events_from_args);
        }
        // Text deltas must be parsed before annotations so `ContentBlockStart`
        // opens the target block before `Citation` events bind to it.
        if let Some(events_from_text) =
            self.parse_openai_response_output_text(request_id, &value, index)
        {
            events.extend(events_from_text);
        }
        if let Some(events_from_annotations) =
            self.parse_openai_response_annotations(request_id, &value, index)
        {
            events.extend(events_from_annotations);
        }
        // Surface the per-response search-call count once, on the same chunk
        // as `MessageComplete` (or whenever the response payload lands). We
        // emit it only when at least one hosted search call completed, to
        // avoid adding noise to non-search turns.
        if value.get("type").and_then(|v| v.as_str()) == Some("response.completed")
            && self.completed_search_calls > 0
        {
            let count = self.completed_search_calls;
            self.completed_search_calls = 0;
            events.push(ProviderEvent::SearchCost {
                request_id: request_id.to_string(),
                index: *index,
                tool_calls: count,
            });
            *index += 1;
        }

        events
    }
}

impl OpenAiParser {
    /// Handle Responses-API output items. Returns events for hosted
    /// `web_search_call` items; ignores everything else (the chat-completions
    /// branch above handles function tool calls and message deltas).
    fn parse_openai_response_item(
        &mut self,
        request_id: &str,
        value: &Value,
        index: &mut usize,
    ) -> Option<Vec<ProviderEvent>> {
        // Locate the item, whether it is wrapped (`response.output_item.*`)
        // or top-level. We accept either shape so the parser stays robust if
        // the upstream serialization changes.
        let item = value.get("item").filter(|v| v.is_object()).or_else(|| {
            if value.get("type").is_some() {
                Some(value)
            } else {
                None
            }
        })?;
        let item_type = item.get("type").and_then(|v| v.as_str())?;
        if item_type == "function_call" {
            return self.parse_openai_response_function_call(request_id, value, item, index);
        }
        if item_type != "web_search_call" {
            return None;
        }

        let event_type = value.get("type").and_then(|v| v.as_str());
        let item_id = item
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("web_search")
            .to_string();
        let query = item
            .pointer("/action/query")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let status = item
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("completed")
            .to_string();

        let mut events = Vec::new();
        let is_done = event_type
            .map(|t| t == "response.output_item.done" || t == "web_search_call")
            .unwrap_or(false);

        if is_done {
            // Complete path: we may not have seen the matching `added`
            // event (e.g. legacy / non-streaming shapes). Synthesize a Start
            // before Complete so the renderer's ToolCallStart/Delta/Complete
            // envelope is consistent.
            if !self.search_calls.contains_key(&item_id) {
                events.push(ProviderEvent::ToolCallStart {
                    request_id: request_id.to_string(),
                    tool_call_id: item_id.clone(),
                    index: *index,
                    tool_id: "web_search".to_string(),
                    name: "web_search".to_string(),
                });
                *index += 1;
            }
            if !query.is_empty() {
                events.push(ProviderEvent::ToolCallDelta {
                    request_id: request_id.to_string(),
                    tool_call_id: item_id.clone(),
                    index: *index,
                    content: query.clone(),
                });
                *index += 1;
            }
            let sources = item
                .pointer("/action/sources")
                .cloned()
                .unwrap_or(Value::Null);
            let arguments = if sources.is_null() {
                json!({ "query": query, "status": status })
            } else {
                json!({ "query": query, "status": status, "sources": sources })
            };
            events.push(ProviderEvent::ToolCallComplete {
                request_id: request_id.to_string(),
                tool_call_id: item_id.clone(),
                index: *index,
                arguments,
            });
            *index += 1;
            self.search_calls.remove(&item_id);
            self.completed_search_calls = self.completed_search_calls.saturating_add(1);
            // Forward sources as a discrete event so the renderer can show a
            // sources list separately from the search block. Only emit when
            // the provider actually returned sources.
            if !sources.is_null() {
                if let Value::Array(arr) = sources {
                    events.push(ProviderEvent::SearchSources {
                        request_id: request_id.to_string(),
                        index: *index,
                        sources: Value::Array(arr),
                    });
                    *index += 1;
                }
            }
        } else {
            // `response.output_item.added`: track the open call so the
            // eventual `done` event can correlate. Emit ToolCallStart here
            // so the renderer sees the search the moment it begins.
            self.search_calls.insert(
                item_id.clone(),
                (item_id.clone(), query.clone(), status.clone()),
            );
            events.push(ProviderEvent::ToolCallStart {
                request_id: request_id.to_string(),
                tool_call_id: item_id,
                index: *index,
                tool_id: "web_search".to_string(),
                name: "web_search".to_string(),
            });
            *index += 1;
        }

        Some(events)
    }

    /// Handle a Responses-API `function_call` output item.
    ///
    /// This is how *client* tools come back on `/responses` — as an output item
    /// with `call_id` / `name` / `arguments`, not as `choices[].delta.tool_calls`,
    /// which is the only shape the chat-completions branch above understands.
    ///
    /// Nothing parsed these, and the consequence was larger than a missing
    /// feature: enabling web search switches the whole request to `/responses`
    /// (see `build_payload`), and the request still declares every function
    /// tool. So the model was offered `write_html`, called it, and the call was
    /// dropped on the floor — the turn ended having produced no visible text and
    /// no runnable tool call. Turning web search *on* silently disabled every
    /// client-side tool, which is the opposite of what the toggle promises.
    ///
    /// The events emitted here are deliberately identical in shape to the
    /// chat-completions branch, so `StreamManager`'s Start→Complete correlation,
    /// the agent loop's declared-tool partition, and the renderer's tool card
    /// all work unchanged.
    fn parse_openai_response_function_call(
        &mut self,
        request_id: &str,
        value: &Value,
        item: &Value,
        index: &mut usize,
    ) -> Option<Vec<ProviderEvent>> {
        // `call_id` is the id the continuation must echo back; `id` (`fc_*`) is
        // only an addressing handle for the delta events. Falling back to `id`
        // keeps a malformed item from producing an unroutable empty tool id.
        let call_id = item
            .get("call_id")
            .and_then(|v| v.as_str())
            .or_else(|| item.get("id").and_then(|v| v.as_str()))?
            .to_string();
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("tool")
            .to_string();
        let item_id = item
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or(call_id.as_str())
            .to_string();

        let event_type = value.get("type").and_then(|v| v.as_str());
        let is_done = event_type
            .map(|t| t == "response.output_item.done" || t == "function_call")
            .unwrap_or(false);

        let mut events = Vec::new();
        if !self.function_calls.contains_key(&item_id) {
            self.function_calls.insert(item_id.clone(), call_id.clone());
            events.push(ProviderEvent::ToolCallStart {
                request_id: request_id.to_string(),
                tool_call_id: call_id.clone(),
                index: *index,
                tool_id: name.clone(),
                name: name.clone(),
            });
            *index += 1;
        }

        if is_done {
            // `output_item.done` carries the complete argument string, so the
            // accumulated deltas are not needed to build the final object —
            // which also means a stream that never sent deltas still completes.
            let raw = item
                .get("arguments")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let arguments = if raw.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&raw).unwrap_or_else(|_| json!({ "raw": raw }))
            };
            self.function_calls.remove(&item_id);
            events.push(ProviderEvent::ToolCallComplete {
                request_id: request_id.to_string(),
                tool_call_id: call_id,
                index: *index,
                arguments,
            });
            *index += 1;
        }

        Some(events)
    }

    /// Stream argument text for an in-flight Responses-API function call.
    ///
    /// Display only — `output_item.done` carries the full argument string, so
    /// the tool still executes correctly if these never arrive. They are
    /// forwarded so the tool card fills in as the model writes, matching the
    /// chat-completions path.
    fn parse_openai_response_function_args(
        &mut self,
        request_id: &str,
        value: &Value,
        index: &mut usize,
    ) -> Option<Vec<ProviderEvent>> {
        if value.get("type").and_then(|v| v.as_str())? != "response.function_call_arguments.delta" {
            return None;
        }
        let item_id = value.get("item_id").and_then(|v| v.as_str())?;
        // Only a call we opened: an unknown id would emit a delta against a
        // tool call the renderer never saw start.
        let call_id = self.function_calls.get(item_id)?.clone();
        let delta = value.get("delta").and_then(|v| v.as_str())?;
        if delta.is_empty() {
            return None;
        }
        let event = ProviderEvent::ToolCallDelta {
            request_id: request_id.to_string(),
            tool_call_id: call_id,
            index: *index,
            content: delta.to_string(),
        };
        *index += 1;
        Some(vec![event])
    }

    /// Open a Responses-API content block keyed by `output_index`. Reuses the
    /// chat-completions `blocks` map; the two paths are mutually exclusive per
    /// request (web-search turns use `/responses`, everything else uses
    /// `/chat/completions`).
    fn ensure_response_content_block(
        &mut self,
        request_id: &str,
        output_index: u32,
        index: &mut usize,
    ) -> (String, Option<ProviderEvent>) {
        match self.blocks.entry(output_index) {
            std::collections::hash_map::Entry::Occupied(e) => (e.get().clone(), None),
            std::collections::hash_map::Entry::Vacant(e) => {
                let block_id = format!("block-{output_index}");
                e.insert(block_id.clone());
                let start = ProviderEvent::ContentBlockStart {
                    request_id: request_id.to_string(),
                    block_id: block_id.clone(),
                    index: *index,
                    block_kind: "text".to_string(),
                };
                *index += 1;
                (block_id, Some(start))
            }
        }
    }

    /// Stream assistant prose from Responses-API `output_text` events. The
    /// chat-completions branch above handles `choices[].delta.content`; this
    /// path handles `response.output_text.delta` / `response.output_text.done`.
    fn parse_openai_response_output_text(
        &mut self,
        request_id: &str,
        value: &Value,
        index: &mut usize,
    ) -> Option<Vec<ProviderEvent>> {
        let event_type = value.get("type").and_then(|v| v.as_str())?;
        let is_delta = match event_type {
            "response.output_text.delta" => true,
            "response.output_text.done" => false,
            _ => return None,
        };

        let content = if is_delta {
            value.get("delta").and_then(|v| v.as_str())?
        } else {
            value.get("text").and_then(|v| v.as_str())?
        };
        if content.is_empty() {
            return None;
        }

        let output_index = value
            .get("output_index")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;

        let (block_id, maybe_start) =
            self.ensure_response_content_block(request_id, output_index, index);

        // `output_text.done` repeats the final text after deltas; skip when the
        // block was already opened by an earlier delta on this output item.
        if !is_delta && maybe_start.is_none() {
            return None;
        }

        let mut events = Vec::new();
        if let Some(start) = maybe_start {
            events.push(start);
        }
        events.push(ProviderEvent::ContentDelta {
            request_id: request_id.to_string(),
            block_id,
            index: *index,
            content: content.to_string(),
        });
        *index += 1;

        Some(events)
    }

    /// Surface `url_citation` annotations from Responses-API message items
    /// and from inline `output_text` payloads. Citations are bound to the
    /// originating `ContentBlock` (`block_id`); the renderer walks them in
    /// `start_index`/`end_index` order to insert inline `[n]` markers.
    fn parse_openai_response_annotations(
        &self,
        request_id: &str,
        value: &Value,
        index: &mut usize,
    ) -> Option<Vec<ProviderEvent>> {
        let mut events = Vec::new();

        // The Responses API emits the message item both in `output_item.done`
        // and in `output_text.done` chunks; the latter carries the most
        // up-to-date `text` and `annotations` for a single content part.
        // We pull annotations from both shapes so the renderer sees them
        // regardless of which shape the chunk uses.
        let mut annotations: Vec<&Value> = Vec::new();
        if let Some(arr) = value.get("annotations").and_then(|v| v.as_array()) {
            annotations.extend(arr.iter());
        }
        if let Some(content) = value.get("content").and_then(|v| v.as_array()) {
            for part in content {
                if let Some(arr) = part.get("annotations").and_then(|v| v.as_array()) {
                    annotations.extend(arr.iter());
                }
            }
        }
        if let Some(item_content) = value.pointer("/item/content").and_then(|v| v.as_array()) {
            for part in item_content {
                if let Some(arr) = part.get("annotations").and_then(|v| v.as_array()) {
                    annotations.extend(arr.iter());
                }
            }
        }

        // Bind citations to the most recently opened content block for this
        // response. The chat-completions path uses `block-{choice_index}`
        // ids; the Responses-API message path uses `block-{output_index}`.
        // We use the chunk's `output_index` (preferred) or `item_id` (fallback)
        // to derive a stable id.
        let block_id = value
            .get("output_index")
            .and_then(|v| v.as_u64())
            .map(|i| format!("block-{i}"))
            .or_else(|| {
                value
                    .get("item_id")
                    .and_then(|v| v.as_str())
                    .map(|s| format!("block-{s}"))
            })
            .or_else(|| {
                value
                    .pointer("/item/id")
                    .and_then(|v| v.as_str())
                    .map(|s| format!("block-{s}"))
            })
            .unwrap_or_else(|| "block-0".to_string());

        for ann in annotations {
            if ann.get("type").and_then(|v| v.as_str()) != Some("url_citation") {
                continue;
            }
            let url = ann.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let title = ann.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let start_index = ann.get("start_index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let end_index = ann.get("end_index").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            if url.is_empty() {
                continue;
            }
            events.push(ProviderEvent::Citation {
                request_id: request_id.to_string(),
                block_id: block_id.clone(),
                index: *index,
                annotation: ContentAnnotation::UrlCitation {
                    url: url.to_string(),
                    title: title.to_string(),
                    start_index,
                    end_index,
                },
            });
            *index += 1;
        }

        if events.is_empty() {
            None
        } else {
            Some(events)
        }
    }
}

fn serialize_function_tool(tool: &crate::schema::ToolDefinition, responses_api: bool) -> Value {
    if responses_api {
        // Responses API: name/description/parameters are top-level on the tool
        // object, not nested under `function` (chat-completions shape).
        json!({
            "type": "function",
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.input_schema,
        })
    } else {
        json!({
            "type": "function",
            "function": {
                "name": tool.name,
                "description": tool.description,
                "parameters": tool.input_schema,
            }
        })
    }
}

/// Rewrite chat-completions messages into Responses-API `input` items.
///
/// Plain `{role, content}` messages pass through — the two shapes agree there,
/// which is why one build step served both endpoints. Tool calls are where they
/// diverge, and the divergence is silent: `/responses` does not recognise an
/// assistant message carrying `tool_calls`, nor a `{"role":"tool"}` message. It
/// wants flat items, and the id it correlates on is `call_id`, not
/// `tool_call_id`.
///
/// Without this, the first round of a web-search turn could call a tool but the
/// *continuation* carrying its result was malformed — so the fix that lets
/// `function_call` items be parsed would have produced a turn that ran the tool
/// and then failed on the next request instead of ending quietly. The two
/// halves only work together.
fn to_responses_input(messages: Vec<Value>) -> Vec<Value> {
    let mut input = Vec::with_capacity(messages.len());
    for message in messages {
        let role = message.get("role").and_then(|v| v.as_str()).unwrap_or("");
        let tool_calls = message
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        if role == "tool" {
            input.push(json!({
                "type": "function_call_output",
                "call_id": message.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or(""),
                "output": message.get("content").and_then(|v| v.as_str()).unwrap_or(""),
            }));
            continue;
        }

        if role == "assistant" && !tool_calls.is_empty() {
            // Any text the assistant produced alongside its calls is a separate
            // item and has to keep its place ahead of them.
            if let Some(text) = message.get("content").and_then(|v| v.as_str()) {
                if !text.is_empty() {
                    input.push(json!({ "role": "assistant", "content": text }));
                }
            }
            for call in tool_calls {
                let function = call.get("function");
                input.push(json!({
                    "type": "function_call",
                    "call_id": call.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                    "name": function.and_then(|f| f.get("name")).and_then(|v| v.as_str()).unwrap_or(""),
                    "arguments": function
                        .and_then(|f| f.get("arguments"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("{}"),
                }));
            }
            continue;
        }

        // `content: null` is legal in chat-completions and rejected here.
        if message.get("content").map(Value::is_null).unwrap_or(false) {
            let mut cleaned = message.clone();
            cleaned["content"] = json!("");
            input.push(cleaned);
            continue;
        }

        input.push(message);
    }
    input
}

fn build_payload(normalized: &NormalizedRequest, force_responses_api: bool) -> Value {
    let request = &normalized.request;
    let mut messages = Vec::new();

    if let Some(system) = &request.system_prompt {
        messages.push(json!({"role": "system", "content": system}));
    }
    if let Some(developer) = &request.developer_prompt {
        messages.push(json!({"role": "developer", "content": developer}));
    }

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
                    // Assistant message with tool calls
                    let text_content = message_text(message);
                    let tool_calls: Vec<Value> = tool_call_parts
                        .iter()
                        .map(|p| {
                            let name = p
                                .metadata
                                .as_ref()
                                .and_then(|m| m.get("name").and_then(|v| v.as_str()))
                                .unwrap_or("");
                            json!({
                                "id": p.tool_call_id.as_deref().unwrap_or(""),
                                "type": "function",
                                "function": {
                                    "name": name,
                                    "arguments": p.content.as_deref().unwrap_or("{}"),
                                }
                            })
                        })
                        .collect();

                    let mut msg = json!({
                        "role": "assistant",
                        "tool_calls": tool_calls,
                    });
                    if !text_content.is_empty() {
                        msg["content"] = json!(text_content);
                    } else {
                        msg["content"] = Value::Null;
                    }
                    messages.push(msg);
                } else {
                    // Fallback: check metadata-based tool_calls for backward compat
                    let legacy_tc = message
                        .parts
                        .iter()
                        .find_map(|p| p.metadata.as_ref()?.get("tool_calls"))
                        .and_then(|v| v.as_array());
                    if let Some(tc_array) = legacy_tc {
                        let text_content = message_text(message);
                        let tool_calls: Vec<Value> = tc_array
                            .iter()
                            .map(|tc| {
                                json!({
                                    "id": tc.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or(""),
                                    "type": "function",
                                    "function": {
                                        "name": tc.get("name").and_then(|v| v.as_str()).unwrap_or(""),
                                        "arguments": tc.get("arguments")
                                            .map(|a| a.to_string())
                                            .unwrap_or_else(|| "{}".to_string()),
                                    }
                                })
                            })
                            .collect();
                        let mut msg = json!({
                            "role": "assistant",
                            "tool_calls": tool_calls,
                        });
                        if !text_content.is_empty() {
                            msg["content"] = json!(text_content);
                        } else {
                            msg["content"] = Value::Null;
                        }
                        messages.push(msg);
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
                // Tool result message — one message per tool_call_id
                for part in &message.parts {
                    if part.kind == MessagePartKind::ToolResult {
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": part.tool_call_id.as_deref().unwrap_or(""),
                            "content": part.content.as_deref().unwrap_or(""),
                        }));
                    }
                }
            }
            _ => {
                // System, Developer, User — unchanged
                messages.push(json!({
                    "role": role_to_string(&message.role),
                    "content": message_text(message),
                }));
            }
        }
    }

    let web_search_intent = request
        .web_search
        .as_ref()
        .map(|w| w.enabled)
        .unwrap_or(false);
    let responses_api = web_search_intent || force_responses_api;

    let mut body = json!({
      "model": request.model_id,
      "stream": true,
    });

    // `stream_options.include_usage` is chat-completions only. The Responses API
    // rejects it with `unknown_parameter` and the whole request fails — which
    // blocks web search even when the user opted in.
    if !responses_api {
        body["stream_options"] = json!({ "include_usage": true });
    }

    // Phase 7 / M-WebSearch: the Responses API (`/responses`) takes `input`
    // rather than `messages`. The two payloads are largely compatible — the
    // messages above are `{role, content}` shaped; Responses accepts that
    // shape directly under `input`. Rename the field so a single `messages`
    // build step serves both endpoints.
    if responses_api {
        body["input"] = json!(to_responses_input(messages));
    } else {
        body["messages"] = json!(messages);
    }

    if !request.tool_definitions.is_empty() {
        let tools: Vec<Value> = request
            .tool_definitions
            .iter()
            .map(|tool| {
                // Phase 7 / M-WebSearch: hosted tools ride alongside function
                // tools on the same `tools` array, but with a different shape.
                // The renderer / catalog marks them with `kind = Hosted`; the
                // adapter is the sole authority on the wire shape per provider.
                if matches!(tool.kind, Some(crate::schema::ToolKind::Hosted)) {
                    let mut obj = json!({ "type": tool.name });
                    if let Some(cfg) = &tool.host_config {
                        obj = merge_json(obj, cfg.clone());
                    }
                    obj
                } else {
                    serialize_function_tool(tool, responses_api)
                }
            })
            .collect();
        body["tools"] = json!(tools);
    }

    // Phase 7 / M-WebSearch: inject the hosted `web_search` tool when the
    // turn opts in. The provider-agnostic `WebSearchRequest` is serialized
    // directly onto the Responses-API tool object. Domain lists are forwarded
    // as-is; the provider validates entries and rejects malformed ones in-band
    // (the existing `{"error":...}` branch surfaces them as `ProviderEvent::Error`).
    if let Some(ws) = request.web_search.as_ref().filter(|w| w.enabled) {
        let mut web_search_tool = json!({ "type": "web_search" });
        if let Some(size) = ws.search_context_size {
            let value = match size {
                SearchContextSize::Low => "low",
                SearchContextSize::Medium => "medium",
                SearchContextSize::High => "high",
            };
            web_search_tool["search_context_size"] = json!(value);
        }
        if let Some(filters) = &ws.filters {
            let mut f = serde_json::Map::new();
            if let Some(allowed) = &filters.allowed_domains {
                if !allowed.is_empty() {
                    f.insert("allowed_domains".to_string(), json!(allowed));
                }
            }
            if let Some(blocked) = &filters.blocked_domains {
                if !blocked.is_empty() {
                    f.insert("blocked_domains".to_string(), json!(blocked));
                }
            }
            if !f.is_empty() {
                web_search_tool["filters"] = Value::Object(f);
            }
        }
        if let Some(external) = ws.external_web_access {
            web_search_tool["external_web_access"] = json!(external);
        }
        if let Some(budget) = ws.return_token_budget {
            let value = match budget {
                crate::schema::ReturnTokenBudget::Default => "default",
                crate::schema::ReturnTokenBudget::Unlimited => "unlimited",
            };
            web_search_tool["return_token_budget"] = json!(value);
        }
        if let Some(loc) = &ws.user_location {
            web_search_tool["user_location"] = json!({
                "type": "approximate",
                "approximate": {
                    "country": loc.country,
                    "city": loc.city,
                    "region": loc.region,
                }
            });
        }

        // Append to the `tools` array we built above. `build_payload` always
        // initializes `tools` as an array when the request carried any tool
        // definitions, so we can safely extend in place.
        if let Some(arr) = body.get_mut("tools").and_then(|v| v.as_array_mut()) {
            arr.push(web_search_tool);
        } else {
            body["tools"] = json!([web_search_tool]);
        }

        if ws.include_sources.unwrap_or(false) {
            let include_entry = json!("web_search_call.action.sources");
            if let Some(arr) = body.get_mut("include").and_then(|v| v.as_array_mut()) {
                if !arr.iter().any(|v| v == &include_entry) {
                    arr.push(include_entry);
                }
            } else {
                body["include"] = json!([include_entry]);
            }
        }
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
        self.is_local_endpoint
    }

    async fn validate_credentials(&self, ctx: &AdapterContext) -> Result<(), ProviderError> {
        let cancel = CancellationToken::new();
        let _ = get_json(
            &ctx.http,
            &format!("{}/models", base_url(self, ctx)),
            self.request_headers(ctx)?,
            cancel,
        )
        .await?;
        Ok(())
    }

    async fn list_models(&self, ctx: &AdapterContext) -> Result<Vec<ModelInfo>, ProviderError> {
        let cancel = CancellationToken::new();
        let headers = self.request_headers(ctx)?;

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
        mut request: ProviderRequest,
        ctx: AdapterContext,
        cancel: CancellationToken,
    ) -> Result<Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>, ProviderError> {
        // Phase 7 / M-WebSearch: trust-boundary check. Refuse to send any
        // hosted search tool when `local_only` is on. The renderer's chat-bar
        // hides the toggle, and `stream_manager.rs` blocks cloud providers
        // outright when local-only is on; this is defense-in-depth so a
        // direct adapter call (e.g. from a future tenant-provided MCP server)
        // cannot bypass the user's local-only intent.
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

        let resolved_base = base_url(self, &ctx);
        let mut search_unavailable: Option<ProviderEvent> = None;
        if web_search_intent && !endpoint_supports_hosted_search(Some(&resolved_base)) {
            let endpoint_msg = resolved_base.clone();
            search_unavailable = Some(ProviderEvent::SearchUnavailable {
                request_id: request.request_id.clone(),
                index: 0,
                code: "endpoint_mismatch".to_string(),
                message: format!(
                    "The configured OpenAI-compatible endpoint ({endpoint_msg}) does not host web search. Falling back to a no-search response."
                ),
            });
            request.web_search = None;
            request.tool_definitions = std::mem::take(&mut request.tool_definitions)
                .into_iter()
                .filter(|t| !matches!(t.kind, Some(crate::schema::ToolKind::Hosted)))
                .collect();
        }

        let normalized = normalized_or_err(request)?;
        let request_id = normalized.request.request_id.clone();
        let body = build_payload(&normalized, self.force_responses);

        let headers = self.request_headers(&ctx)?;

        // Phase 7 / M-WebSearch: hosted web_search lives on the Responses API.
        // Switch to `/responses` when the turn opted in. The chat-completions
        // path is preserved for turns that did not opt in (and for non-search
        // function tools, which still work on both endpoints).
        let endpoint = if self.force_chat_completions {
            "chat/completions"
        } else if self.force_responses || (web_search_intent && search_unavailable.is_none()) {
            "responses"
        } else {
            "chat/completions"
        };

        let sse = post_sse(
            &ctx.http,
            SseRequest {
                url: format!("{}/{}", base_url(self, &ctx), endpoint),
                headers,
                body,
            },
            cancel,
        )
        .await?;

        let inner = wrap_sse_stream(request_id, OpenAiParser::new(), sse);
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

/// Phase 7 / M-WebSearch: hosts we trust to implement OpenAI's hosted
/// `web_search` tool on an OpenAI-compatible base URL.
pub(crate) fn endpoint_supports_hosted_search(base_url: Option<&str>) -> bool {
    // M4: extend when Zen v2 routes real upstream search, or move to a
    // descriptor-driven `supports_hosted_search` flag on ProviderDescriptor.
    const OPENAI_HOSTED_SEARCH_HOSTS: &[&str] = &["api.openai.com"];
    let Some(raw) = base_url else {
        return false;
    };
    let Ok(parsed) = url::Url::parse(raw) else {
        return false;
    };
    let Some(host) = parsed.host_str() else {
        return false;
    };
    OPENAI_HOSTED_SEARCH_HOSTS.contains(&host)
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
    use crate::schema::{
        Message, MessagePart, MessagePartKind, MessageRole, PermissionLevel, ToolDefinition,
        ToolKind, WebSearchRequest,
    };

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

    // ---------------------------------------------------------------------
    // Phase 7 / M-WebSearch: parser tests for the Responses-API hosted
    // `web_search_call` item + `url_citation` annotations. The fixture
    // exercises the full envelope: web_search_call (added + done), message
    // item with output_text annotations, and the response.completed event.
    // ---------------------------------------------------------------------

    #[test]
    fn parses_web_search_call_as_tool_call_envelope() {
        let fixture = include_str!("../../tests/fixtures/openai/web_search_call.sse");
        let events = parse_fixture("req-ws-1", fixture);

        // The web_search_call must surface as a tool call with
        // tool_id="web_search" so the renderer reuses ToolCallBlock.
        let starts: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::ToolCallStart {
                    tool_call_id,
                    tool_id,
                    name,
                    ..
                } => Some((tool_call_id.clone(), tool_id.clone(), name.clone())),
                _ => None,
            })
            .collect();
        assert!(
            starts
                .iter()
                .any(|(_, id, n)| id == "web_search" && n == "web_search"),
            "expected a ToolCallStart with tool_id=name=web_search, got {starts:?}"
        );

        // The query must appear as a ToolCallDelta so the renderer can show
        // the search query as it streams.
        let deltas: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::ToolCallDelta {
                    tool_call_id,
                    content,
                    ..
                } => Some((tool_call_id.clone(), content.clone())),
                _ => None,
            })
            .collect();
        assert!(
            deltas.iter().any(|(_, c)| c.contains("best picture 2025")),
            "expected a ToolCallDelta with the search query, got {deltas:?}"
        );

        // The complete event carries the query + status as JSON arguments.
        let completes: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::ToolCallComplete {
                    tool_call_id,
                    arguments,
                    ..
                } => Some((tool_call_id.clone(), arguments.clone())),
                _ => None,
            })
            .collect();
        assert!(
            completes
                .iter()
                .any(|(_, args)| args.get("query").is_some() && args.get("status").is_some()),
            "expected ToolCallComplete with query+status, got {completes:?}"
        );
    }

    #[test]
    fn parses_response_output_text_as_content_deltas() {
        let fixture = include_str!("../../tests/fixtures/openai/web_search_call.sse");
        let events = parse_fixture("req-ws-text", fixture);

        let deltas: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::ContentDelta {
                    block_id, content, ..
                } => Some((block_id.clone(), content.clone())),
                _ => None,
            })
            .collect();
        assert!(
            deltas
                .iter()
                .any(|(id, c)| id == "block-1" && c.contains("Anora")),
            "expected ContentDelta for block-1 with the answer text, got {deltas:?}"
        );

        assert!(
            events.iter().any(|e| matches!(
                e,
                ProviderEvent::ContentBlockStart { block_id, block_kind, .. }
                    if block_id == "block-1" && block_kind == "text"
            )),
            "expected ContentBlockStart for block-1 before the text deltas"
        );
    }

    #[test]
    fn parses_url_citation_annotations() {
        let fixture = include_str!("../../tests/fixtures/openai/web_search_call.sse");
        let events = parse_fixture("req-ws-2", fixture);

        let citations: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::Citation {
                    annotation,
                    block_id,
                    ..
                } => Some((block_id.clone(), annotation.clone())),
                _ => None,
            })
            .collect();

        assert!(
            !citations.is_empty(),
            "expected at least one Citation event from the web_search_call fixture"
        );
        let (block_id, annotation) = &citations[0];
        match annotation {
            ContentAnnotation::UrlCitation {
                url,
                title,
                start_index,
                end_index,
            } => {
                assert_eq!(url, "https://www.example.com/oscars-2025");
                assert_eq!(title, "Oscars 2025: Best Picture");
                assert_eq!(*start_index, 0);
                assert_eq!(*end_index, 46);
            }
        }
        // The block_id must be derived from output_index so the renderer
        // can bind the citation to the correct ContentBlock.
        assert!(
            block_id.starts_with("block-"),
            "block_id should be derived from output_index, got {block_id}"
        );
    }

    #[test]
    fn surfaces_search_cost_when_response_completes() {
        let fixture = include_str!("../../tests/fixtures/openai/web_search_call.sse");
        let events = parse_fixture("req-ws-3", fixture);

        let costs: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::SearchCost { tool_calls, .. } => Some(*tool_calls),
                _ => None,
            })
            .collect();
        assert_eq!(
            costs.len(),
            1,
            "expected exactly one SearchCost on response.completed, got {costs:?}"
        );
        assert_eq!(costs[0], 1, "one web_search_call completed in the fixture");
    }

    #[test]
    fn payload_builds_responses_api_when_web_search_enabled() {
        // When web_search is enabled, the payload must use `input` (Responses
        // API) instead of `messages` (chat completions), inject the hosted
        // web_search tool with the user-specified knobs, and add the include
        // directive when sources are requested.
        let request = ProviderRequest {
            request_id: "req-payload".into(),
            conversation_id: "conv-1".into(),
            model_id: "gpt-5".into(),
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
                    content: Some("What's the best restaurant in Paris?".into()),
                    mime_type: None,
                    tool_call_id: None,
                    artifact_id: None,
                    attachment_id: None,
                    blob_ref: None,
                    metadata: None,
                    created_at: "2026-06-28T00:00:00Z".into(),
                }],
                created_at: "2026-06-28T00:00:00Z".into(),
            }],
            system_prompt: None,
            developer_prompt: None,
            attachments: None,
            tool_definitions: vec![],
            generation_controls: None,
            response_format: None,
            web_search: Some(WebSearchRequest {
                enabled: true,
                search_context_size: Some(SearchContextSize::Low),
                filters: Some(crate::schema::WebSearchFilters {
                    allowed_domains: Some(vec!["pubmed.ncbi.nlm.nih.gov".into()]),
                    blocked_domains: None,
                }),
                external_web_access: Some(true),
                return_token_budget: None,
                user_location: Some(crate::schema::UserLocation {
                    country: "FR".into(),
                    city: Some("Paris".into()),
                    region: None,
                }),
                include_sources: Some(true),
            }),
        };

        let body = build_payload(&NormalizedRequest { request }, false);
        // Responses-API field shape, not chat-completions.
        assert!(
            body.get("input").is_some(),
            "must use Responses-API `input` field"
        );
        assert!(
            body.get("messages").is_none(),
            "must not emit chat-completions `messages`"
        );

        // Hosted tool injection.
        let tools = body
            .get("tools")
            .and_then(|v| v.as_array())
            .expect("tools array");
        let ws_tool = tools
            .iter()
            .find(|t| t.get("type").and_then(|v| v.as_str()) == Some("web_search"))
            .expect("web_search tool must be injected");
        assert_eq!(
            ws_tool.get("search_context_size").and_then(|v| v.as_str()),
            Some("low")
        );
        assert_eq!(
            ws_tool
                .pointer("/filters/allowed_domains/0")
                .and_then(|v| v.as_str()),
            Some("pubmed.ncbi.nlm.nih.gov")
        );
        assert_eq!(
            ws_tool.get("external_web_access").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            ws_tool
                .pointer("/user_location/approximate/country")
                .and_then(|v| v.as_str()),
            Some("FR")
        );

        // include directive when sources are requested.
        let includes = body
            .get("include")
            .and_then(|v| v.as_array())
            .expect("include array");
        assert!(
            includes
                .iter()
                .any(|v| v.as_str() == Some("web_search_call.action.sources")),
            "include must request sources when include_sources=true"
        );

        // Responses API rejects chat-completions-only fields.
        assert!(
            body.get("stream_options").is_none(),
            "must not send stream_options on Responses API"
        );
    }

    #[test]
    fn payload_omits_empty_domain_filter_arrays() {
        let request = ProviderRequest {
            request_id: "req-ws-empty-filters".into(),
            conversation_id: "conv-1".into(),
            model_id: "gpt-5".into(),
            messages: vec![],
            system_prompt: None,
            developer_prompt: None,
            attachments: None,
            tool_definitions: vec![],
            generation_controls: None,
            response_format: None,
            web_search: Some(WebSearchRequest {
                enabled: true,
                search_context_size: None,
                filters: Some(crate::schema::WebSearchFilters {
                    allowed_domains: Some(vec![]),
                    blocked_domains: Some(vec![]),
                }),
                external_web_access: None,
                return_token_budget: None,
                user_location: None,
                include_sources: None,
            }),
        };

        let body = build_payload(&NormalizedRequest { request }, false);
        let ws_tool = body
            .get("tools")
            .and_then(|v| v.as_array())
            .and_then(|tools| {
                tools
                    .iter()
                    .find(|t| t.get("type").and_then(|v| v.as_str()) == Some("web_search"))
            })
            .expect("web_search tool");
        assert!(
            ws_tool.get("filters").is_none(),
            "empty domain lists must be omitted — OpenAI rejects empty allowed_domains arrays"
        );
    }

    #[test]
    fn payload_responses_api_function_tools_use_flat_shape() {
        let request = ProviderRequest {
            request_id: "req-ws-tools".into(),
            conversation_id: "conv-1".into(),
            model_id: "gpt-5".into(),
            messages: vec![],
            system_prompt: None,
            developer_prompt: None,
            attachments: None,
            tool_definitions: vec![ToolDefinition {
                tool_id: "create_artifact".into(),
                name: "create_artifact".into(),
                description: "Create an artifact".into(),
                input_schema: serde_json::json!({"type": "object"}),
                kind: Some(ToolKind::Function),
                host_config: None,
                permission_level: None,
                display_group: None,
                tenant_scope: None,
            }],
            generation_controls: None,
            response_format: None,
            web_search: Some(WebSearchRequest {
                enabled: true,
                search_context_size: None,
                filters: None,
                external_web_access: None,
                return_token_budget: None,
                user_location: None,
                include_sources: None,
            }),
        };

        let body = build_payload(&NormalizedRequest { request }, false);
        let tools = body.get("tools").and_then(|v| v.as_array()).expect("tools");
        let fn_tool = tools
            .iter()
            .find(|t| t.get("type").and_then(|v| v.as_str()) == Some("function"))
            .expect("function tool");
        assert_eq!(
            fn_tool.get("name").and_then(|v| v.as_str()),
            Some("create_artifact")
        );
        assert!(
            fn_tool.get("function").is_none(),
            "Responses API uses flat function tool shape, not nested function object"
        );
    }

    #[test]
    fn payload_uses_chat_completions_when_web_search_disabled() {
        // Default path: no web_search on the request, so the payload stays
        // on chat-completions (`messages`) and emits no hosted tool.
        let request = ProviderRequest {
            request_id: "req-no-ws".into(),
            conversation_id: "conv-1".into(),
            model_id: "gpt-5".into(),
            messages: vec![],
            system_prompt: None,
            developer_prompt: None,
            attachments: None,
            tool_definitions: vec![],
            generation_controls: None,
            response_format: None,
            web_search: None,
        };

        let body = build_payload(&NormalizedRequest { request }, false);
        assert!(
            body.get("messages").is_some(),
            "chat-completions path keeps `messages`"
        );
        assert!(
            body.get("input").is_none(),
            "must not emit Responses-API `input`"
        );
        assert!(
            body.get("tools").is_none()
                || body
                    .get("tools")
                    .and_then(|v| v.as_array())
                    .is_none_or(|a| a.is_empty()),
            "must not inject hosted tools on the chat-completions path"
        );
    }

    #[test]
    fn hosted_tool_definition_serializes_as_provider_hosted_object() {
        // A ToolDefinition with `kind=Hosted` must serialize as a bare
        // provider-hosted object (e.g. `{"type":"web_search", ...}`) so it
        // can ride alongside function tools on the same `tools` array.
        let mut request = ProviderRequest {
            request_id: "req-hosted".into(),
            conversation_id: "conv-1".into(),
            model_id: "gpt-5".into(),
            messages: vec![],
            system_prompt: None,
            developer_prompt: None,
            attachments: None,
            tool_definitions: vec![ToolDefinition {
                tool_id: "web_search".into(),
                name: "web_search".into(),
                description: "Hosted web search tool".into(),
                input_schema: json!({}),
                kind: Some(ToolKind::Hosted),
                host_config: Some(json!({ "search_context_size": "high" })),
                permission_level: Some(PermissionLevel::SideEffectful),
                display_group: None,
                tenant_scope: None,
            }],
            generation_controls: None,
            response_format: None,
            web_search: None,
        };
        // Web search is not on the request itself, but the catalog is exposing
        // a hosted tool. build_payload should still emit it as a hosted tool
        // object, not a function tool.
        let body = build_payload(
            &NormalizedRequest {
                request: request.clone(),
            },
            false,
        );
        let tools = body
            .get("tools")
            .and_then(|v| v.as_array())
            .expect("tools array");
        assert_eq!(tools.len(), 1);
        assert_eq!(
            tools[0].get("type").and_then(|v| v.as_str()),
            Some("web_search")
        );
        assert_eq!(
            tools[0].get("search_context_size").and_then(|v| v.as_str()),
            Some("high"),
            "host_config fields must merge into the tool object"
        );

        // Sanity: a function-kind tool stays as a function tool.
        request.tool_definitions = vec![ToolDefinition {
            tool_id: "get_weather".into(),
            name: "get_weather".into(),
            description: "Get the weather".into(),
            input_schema: json!({"type": "object"}),
            kind: None,
            host_config: None,
            permission_level: None,
            display_group: None,
            tenant_scope: None,
        }];
        let body = build_payload(&NormalizedRequest { request }, false);
        let tools = body
            .get("tools")
            .and_then(|v| v.as_array())
            .expect("tools array");
        assert_eq!(
            tools[0].get("type").and_then(|v| v.as_str()),
            Some("function")
        );
        assert_eq!(
            tools[0].pointer("/function/name").and_then(|v| v.as_str()),
            Some("get_weather")
        );
    }

    #[test]
    fn force_responses_payload_uses_input_field() {
        let request = ProviderRequest {
            request_id: "req-zen-gpt".into(),
            conversation_id: "conv-1".into(),
            model_id: "gpt-5.4".into(),
            messages: vec![],
            system_prompt: None,
            developer_prompt: None,
            attachments: None,
            tool_definitions: vec![],
            generation_controls: None,
            response_format: None,
            web_search: None,
        };

        let body = build_payload(&NormalizedRequest { request }, true);
        assert!(body.get("input").is_some());
        assert!(body.get("messages").is_none());
        assert!(body.get("stream_options").is_none());
    }

    #[test]
    fn official_openai_default_endpoint_hosts_web_search() {
        // Regression: when no custom base_url is configured, the adapter must
        // still recognize the official OpenAI endpoint as hosting web search.
        // Previously the check only inspected ctx.base_url, which is None by
        // default, and silently disabled search for official OpenAI users.
        let adapter = OpenAiAdapter::official();
        let ctx = crate::adapter::AdapterContext {
            api_key: Some("sk-test".into()),
            base_url: None,
            http: crate::transport::HttpClient::new(),
            local_only: false,
        };
        let resolved = base_url(&adapter, &ctx);
        assert_eq!(resolved, "https://api.openai.com/v1");
        assert!(
            endpoint_supports_hosted_search(Some(&resolved)),
            "official OpenAI default endpoint must host web search"
        );
    }

    // ---------------------------------------------------------------------
    // Responses-API function calls.
    //
    // Enabling web search switches the whole request to `/responses`, and the
    // request still declares every function tool — so on a web-search turn the
    // model is offered `write_html`, calls it, and the call arrives as a
    // `function_call` output item. Nothing parsed that shape, so the call was
    // dropped: the turn produced no visible text and no runnable tool call, and
    // ended silently. Turning web search *on* disabled every client-side tool.
    // ---------------------------------------------------------------------

    #[test]
    fn parses_a_responses_api_function_call() {
        let fixture = include_str!("../../tests/fixtures/openai/responses_function_call.sse");
        let events = parse_fixture("req-fc-1", fixture);

        let started = events.iter().any(|e| {
            matches!(
                e,
                ProviderEvent::ToolCallStart { tool_call_id, name, .. }
                    if tool_call_id == "call_write_1" && name == "write_html"
            )
        });
        assert!(
            started,
            "the function call must open a tool call envelope: {events:?}"
        );

        let completed = events.iter().find_map(|e| match e {
            ProviderEvent::ToolCallComplete {
                tool_call_id,
                arguments,
                ..
            } if tool_call_id == "call_write_1" => Some(arguments.clone()),
            _ => None,
        });
        let arguments = completed.expect("the function call must complete");
        assert_eq!(
            arguments.get("title").and_then(|v| v.as_str()),
            Some("Today"),
            "arguments must be parsed into an object the tool can consume"
        );
    }

    /// `call_id` is what the continuation echoes back; `id` (`fc_*`) only
    /// addresses the delta events. Emitting the wrong one produces a
    /// continuation the Responses API rejects.
    #[test]
    fn a_function_call_is_keyed_by_call_id_not_item_id() {
        let fixture = include_str!("../../tests/fixtures/openai/responses_function_call.sse");
        let events = parse_fixture("req-fc-2", fixture);
        assert!(
            !events.iter().any(|e| matches!(
                e,
                ProviderEvent::ToolCallStart { tool_call_id, .. } if tool_call_id == "fc_123"
            )),
            "the item id must not leak out as the tool call id"
        );
    }

    /// Hosted and client tools coexist in one response; parsing one must not
    /// consume the other.
    #[test]
    fn a_hosted_search_and_a_function_call_both_survive() {
        let fixture = include_str!("../../tests/fixtures/openai/responses_function_call.sse");
        let events = parse_fixture("req-fc-3", fixture);
        let ids: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::ToolCallComplete { tool_call_id, .. } => Some(tool_call_id.as_str()),
                _ => None,
            })
            .collect();
        assert!(ids.contains(&"ws_abc"), "hosted search lost: {ids:?}");
        assert!(ids.contains(&"call_write_1"), "function call lost: {ids:?}");
    }

    /// Display only — `output_item.done` carries the full argument string, so a
    /// stream with no deltas still completes. But when they do arrive they must
    /// bind to the call the renderer opened.
    #[test]
    fn streamed_arguments_bind_to_the_open_call() {
        let fixture = include_str!("../../tests/fixtures/openai/responses_function_call.sse");
        let events = parse_fixture("req-fc-4", fixture);
        let deltas: Vec<&str> = events
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::ToolCallDelta {
                    tool_call_id,
                    content,
                    ..
                } if tool_call_id == "call_write_1" => Some(content.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(deltas.concat(), "{\"title\":\"Today\"}");
    }

    // ---------------------------------------------------------------------
    // The continuation. `/responses` does not accept an assistant message
    // carrying `tool_calls`, nor a `{"role":"tool"}` message — it wants flat
    // `function_call` / `function_call_output` items keyed by `call_id`. Without
    // this, parsing the call above would only move the failure one round later.
    // ---------------------------------------------------------------------

    #[test]
    fn tool_results_become_function_call_output_items() {
        let input = to_responses_input(vec![
            json!({"role": "user", "content": "make it"}),
            json!({
                "role": "assistant",
                "content": Value::Null,
                "tool_calls": [{
                    "id": "call_write_1",
                    "type": "function",
                    "function": {"name": "write_html", "arguments": "{\"title\":\"Today\"}"}
                }]
            }),
            json!({"role": "tool", "tool_call_id": "call_write_1", "content": "ok"}),
        ]);

        assert_eq!(input[0]["role"], "user");

        assert_eq!(input[1]["type"], "function_call");
        assert_eq!(input[1]["call_id"], "call_write_1");
        assert_eq!(input[1]["name"], "write_html");
        assert_eq!(input[1]["arguments"], "{\"title\":\"Today\"}");
        assert!(
            input[1].get("role").is_none(),
            "a function_call is an item, not a message"
        );

        assert_eq!(input[2]["type"], "function_call_output");
        assert_eq!(input[2]["call_id"], "call_write_1");
        assert_eq!(input[2]["output"], "ok");
    }

    /// Text emitted alongside the calls is a separate item and keeps its place
    /// ahead of them.
    #[test]
    fn assistant_text_alongside_a_call_survives_in_order() {
        let input = to_responses_input(vec![json!({
            "role": "assistant",
            "content": "writing it now",
            "tool_calls": [{
                "id": "call_1",
                "type": "function",
                "function": {"name": "write_html", "arguments": "{}"}
            }]
        })]);
        assert_eq!(input.len(), 2);
        assert_eq!(input[0]["role"], "assistant");
        assert_eq!(input[0]["content"], "writing it now");
        assert_eq!(input[1]["type"], "function_call");
    }

    /// `content: null` is legal in chat-completions and rejected by `/responses`.
    #[test]
    fn a_null_content_message_is_not_sent_as_null() {
        let input = to_responses_input(vec![json!({"role": "assistant", "content": Value::Null})]);
        assert_eq!(input[0]["content"], "");
    }

    /// Ordinary turns are the common case and must pass through untouched.
    #[test]
    fn plain_messages_are_unchanged() {
        let messages = vec![
            json!({"role": "system", "content": "be brief"}),
            json!({"role": "user", "content": "hi"}),
        ];
        assert_eq!(to_responses_input(messages.clone()), messages);
    }
}
