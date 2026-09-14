use crate::adapter::{AdapterContext, ModelInfo, ProviderAdapter, StreamParser};
use crate::adapters::{
    message_text, normalized_or_err, parse_fixture_stream, role_to_string, wrap_sse_stream,
};
use crate::normalize::NormalizedRequest;
use crate::output_limits::FINISH_REASON_LENGTH;
use crate::schema::{
    MessagePart, MessagePartKind, MessageRole, ProviderError, ProviderEvent, ProviderRequest,
    ToolKind,
};
use crate::transport::{get_json, post_sse, SseRequest};
use async_trait::async_trait;
use futures::stream::Stream;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use serde_json::{json, Value};
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

const DEFAULT_BASE: &str = "http://127.0.0.1:11434";

pub struct OllamaAdapter;

struct OllamaParser {
    /// Set once this round has parsed at least one `message.tool_calls`
    /// entry. Read on the `done: true` chunk to pick `MessageComplete`'s
    /// `finish_reason` — Ollama's own `done_reason` is not a reliable "did it
    /// call a tool" signal (the docs only show `"stop"`), so the adapter
    /// tracks it itself, the same way the agent loop already infers a tool
    /// round from `ToolCallComplete` events.
    saw_tool_call: bool,
    /// Monotonic counter for synthesizing a stable `tool_call_id` when Ollama
    /// omits one (its wire format carries no `id`/`index` on tool calls,
    /// unlike OpenAI/Gemini).
    tool_call_seq: u32,
}

impl OllamaParser {
    fn new() -> Self {
        Self {
            saw_tool_call: false,
            tool_call_seq: 0,
        }
    }

    /// Parses `message.tool_calls` into `ToolCallStart` + `ToolCallComplete`
    /// pairs, mirroring `gemini.rs::parse_function_call`. Ollama streams each
    /// call whole (not incrementally) and its `function.arguments` is already
    /// a JSON object per the official docs, so there is no delta phase and no
    /// string-to-object parsing in the common case — but a string is handled
    /// defensively in case a model or proxy stringifies it anyway.
    fn parse_tool_calls(
        &mut self,
        request_id: &str,
        tool_calls: &[Value],
        index: &mut usize,
    ) -> Vec<ProviderEvent> {
        let mut events = Vec::new();
        for call in tool_calls {
            let name = call
                .pointer("/function/name")
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let tool_call_id = call
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    let seq = self.tool_call_seq;
                    self.tool_call_seq += 1;
                    format!("ollama-call-{name}-{seq}")
                });
            let arguments = match call.pointer("/function/arguments") {
                Some(Value::String(s)) => {
                    serde_json::from_str(s).unwrap_or_else(|_| json!({ "raw": s }))
                }
                Some(v) => v.clone(),
                None => json!({}),
            };

            self.saw_tool_call = true;

            events.push(ProviderEvent::ToolCallStart {
                request_id: request_id.to_string(),
                tool_call_id: tool_call_id.clone(),
                index: *index,
                tool_id: name.clone(),
                name,
            });
            *index += 1;
            events.push(ProviderEvent::ToolCallComplete {
                request_id: request_id.to_string(),
                tool_call_id,
                index: *index,
                arguments,
            });
            *index += 1;
        }
        events
    }
}

impl StreamParser for OllamaParser {
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
        let block_id = "block-0".to_string();

        if value.get("message").is_some() || value.get("response").is_some() {
            if *index == 0 {
                events.push(ProviderEvent::ContentBlockStart {
                    request_id: request_id.to_string(),
                    block_id: block_id.clone(),
                    index: *index,
                    block_kind: "text".to_string(),
                });
                *index += 1;
            }

            let content = value
                .pointer("/message/content")
                .or_else(|| value.get("response"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();

            if !content.is_empty() {
                events.push(ProviderEvent::ContentDelta {
                    request_id: request_id.to_string(),
                    block_id: block_id.clone(),
                    index: *index,
                    content,
                });
                *index += 1;
            }
        }

        if let Some(tool_calls) = value
            .pointer("/message/tool_calls")
            .and_then(|v| v.as_array())
        {
            events.extend(self.parse_tool_calls(request_id, tool_calls, index));
        }

        if value.get("done").and_then(|v| v.as_bool()) == Some(true) {
            events.push(ProviderEvent::ContentBlockStop {
                request_id: request_id.to_string(),
                block_id,
                index: *index,
            });
            *index += 1;

            if let Some(prompt_eval) = value.pointer("/prompt_eval_count").and_then(|v| v.as_u64())
            {
                let eval_count = value.pointer("/eval_count").and_then(|v| v.as_u64());
                events.push(ProviderEvent::Usage {
                    request_id: request_id.to_string(),
                    usage: crate::schema::ProviderUsage {
                        input_tokens: Some(prompt_eval),
                        output_tokens: eval_count,
                        cache_tokens: None,
                        cache_read_tokens: None,
                        cache_write_tokens: None,
                        cost_hint: None,
                    },
                });
                *index += 1;
            }

            // Ollama's own `done_reason` is not a dependable "ended on a tool
            // call" signal (see module doc on `saw_tool_call`), so the
            // adapter emits its own `MessageComplete` here rather than
            // leaving it to `wrap_sse_stream`'s generic "stop" — that is what
            // lets a tool-calling round report `finish_reason: "tool_calls"`
            // the way OpenAI's does, so the renderer and agent loop treat it
            // consistently across providers.
            // `done_reason: "length"` does mean the response hit `num_predict`
            // or the context window, and outranks the tool-call signal.
            let finish_reason =
                if value.get("done_reason").and_then(|v| v.as_str()) == Some("length") {
                    FINISH_REASON_LENGTH
                } else if self.saw_tool_call {
                    "tool_calls"
                } else {
                    "stop"
                };
            events.push(ProviderEvent::MessageComplete {
                request_id: request_id.to_string(),
                index: *index,
                finish_reason: finish_reason.to_string(),
            });
            *index += 1;
        }

        events
    }
}

fn ollama_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers
}

fn build_payload(normalized: &NormalizedRequest) -> Value {
    let request = &normalized.request;
    let mut messages = Vec::new();

    if let Some(system) = &request.system_prompt {
        messages.push(json!({"role": "system", "content": system}));
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
                        messages.push(json!({
                            "role": "assistant",
                            "content": message_text(message),
                        }));
                    }
                }
            }
            MessageRole::Tool => {
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
                if message.role == MessageRole::User {
                    messages.push(crate::adapters::ollama_user_message(message));
                } else {
                    messages.push(json!({
                        "role": role_to_string(&message.role),
                        "content": message_text(message),
                    }));
                }
            }
        }
    }

    let mut body = json!({
      "model": request.model_id,
      "messages": messages,
      "stream": true,
    });

    // `/api/chat` takes `tools` in the same chat-completions function shape
    // OpenAI uses (`{"type":"function","function":{name,description,parameters}}`,
    // per https://github.com/ollama/ollama/blob/main/docs/api.md). Ollama has
    // no hosted-tool concept, so a `ToolKind::Hosted` definition (e.g. a
    // future web_search) is silently dropped rather than sent in a shape the
    // model can't use.
    if !request.tool_definitions.is_empty() {
        let tools: Vec<Value> = request
            .tool_definitions
            .iter()
            .filter(|tool| !matches!(tool.kind, Some(ToolKind::Hosted)))
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
        if !tools.is_empty() {
            body["tools"] = json!(tools);
        }
    }

    if let Some(max_tokens) = request
        .generation_controls
        .as_ref()
        .and_then(|c| c.max_tokens)
    {
        body["options"] = json!({ "num_predict": max_tokens });
    }

    body
}

fn base_url(ctx: &AdapterContext) -> String {
    ctx.base_url
        .clone()
        .filter(|u| !u.is_empty())
        .unwrap_or_else(|| DEFAULT_BASE.to_string())
        .trim_end_matches('/')
        .to_string()
}

#[async_trait]
impl ProviderAdapter for OllamaAdapter {
    fn id(&self) -> &'static str {
        "ollama"
    }

    fn display_name(&self) -> &'static str {
        "Ollama"
    }

    fn is_local(&self) -> bool {
        true
    }

    async fn validate_credentials(&self, ctx: &AdapterContext) -> Result<(), ProviderError> {
        let cancel = CancellationToken::new();
        let _ = get_json(
            &ctx.http,
            &format!("{}/api/tags", base_url(ctx)),
            ollama_headers(),
            cancel,
        )
        .await?;
        Ok(())
    }

    async fn list_models(&self, ctx: &AdapterContext) -> Result<Vec<ModelInfo>, ProviderError> {
        let cancel = CancellationToken::new();
        let response = get_json(
            &ctx.http,
            &format!("{}/api/tags", base_url(ctx)),
            ollama_headers(),
            cancel,
        )
        .await?;

        let models = response
            .pointer("/models")
            .and_then(|d| d.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let id = item.get("name")?.as_str()?.to_string();
                        Some(ModelInfo {
                            id: id.clone(),
                            display_name: Some(id),
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

        let sse = post_sse(
            &ctx.http,
            SseRequest {
                url: format!("{}/api/chat", base_url(&ctx)),
                headers: ollama_headers(),
                body,
            },
            cancel,
        )
        .await?;

        Ok(wrap_sse_stream(request_id, OllamaParser::new(), sse))
    }
}

pub fn parse_fixture(request_id: &str, fixture: &str) -> Vec<ProviderEvent> {
    parse_fixture_stream(&mut OllamaParser::new(), request_id, fixture, |line| {
        if line.is_empty() {
            None
        } else {
            Some(line)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_text_fixture() {
        let fixture = include_str!("../../tests/fixtures/ollama/plain_text.sse");
        let events = parse_fixture("req-1", fixture);
        assert!(events
            .iter()
            .any(|e| matches!(e, ProviderEvent::ContentDelta { .. })));
        assert!(events.iter().any(|e| matches!(
            e,
            ProviderEvent::MessageComplete { finish_reason, .. } if finish_reason == "stop"
        )));
    }

    #[test]
    fn length_done_reason_is_reported_as_length() {
        let fixture = include_str!("../../tests/fixtures/ollama/length.sse");
        let events = parse_fixture("req-1", fixture);
        assert!(
            matches!(
                events.last(),
                Some(ProviderEvent::MessageComplete { finish_reason, .. }) if finish_reason == "length"
            ),
            "{events:?}"
        );
    }

    #[test]
    fn payload_maps_max_tokens_to_num_predict() {
        let mut request = ProviderRequest {
            request_id: "req-opts".into(),
            conversation_id: "conv-1".into(),
            model_id: "llama3.2".into(),
            messages: vec![],
            system_prompt: None,
            developer_prompt: None,
            attachments: None,
            tool_definitions: vec![],
            generation_controls: None,
            response_format: None,
            web_search: None,
        };
        let body = build_payload(&NormalizedRequest {
            request: request.clone(),
        });
        assert!(body.get("options").is_none());

        request.generation_controls = Some(crate::schema::GenerationControls {
            temperature: None,
            top_p: None,
            max_tokens: Some(2_048),
            stop_sequences: None,
            tool_choice: None,
        });
        let body = build_payload(&NormalizedRequest { request });
        assert_eq!(body.pointer("/options/num_predict"), Some(&json!(2_048)));
    }

    #[test]
    fn parses_tool_call_fixture() {
        let fixture = include_str!("../../tests/fixtures/ollama/tool_call_single.sse");
        let events = parse_fixture("req-1", fixture);

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
        assert_eq!(starts.len(), 1);
        assert_eq!(starts[0].1, "get_weather");
        assert_eq!(starts[0].2, "get_weather");

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
        assert_eq!(completes.len(), 1);
        // Correlates with the ToolCallStart above.
        assert_eq!(completes[0].0, starts[0].0);
        assert_eq!(
            completes[0].1.get("city").and_then(|v| v.as_str()),
            Some("Tokyo")
        );

        // A round that ends in a tool call reports finish_reason "tool_calls",
        // not Ollama's own (unreliable) done_reason "stop" — see
        // OllamaParser::saw_tool_call.
        assert!(events.iter().any(|e| matches!(
            e,
            ProviderEvent::MessageComplete { finish_reason, .. } if finish_reason == "tool_calls"
        )));
        // Exactly one MessageComplete — the parser's own, not a second one
        // tacked on by parse_fixture_stream/wrap_sse_stream.
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, ProviderEvent::MessageComplete { .. }))
                .count(),
            1
        );
    }

    #[test]
    fn payload_includes_tools_array() {
        use crate::schema::{PermissionLevel, ToolDefinition, ToolKind};

        let mut request = ProviderRequest {
            request_id: "req-tools".into(),
            conversation_id: "conv-1".into(),
            model_id: "llama3.2".into(),
            messages: vec![],
            system_prompt: None,
            developer_prompt: None,
            attachments: None,
            tool_definitions: vec![
                ToolDefinition {
                    tool_id: "get_weather".into(),
                    name: "get_weather".into(),
                    description: "Get the weather in a given city".into(),
                    input_schema: json!({
                        "type": "object",
                        "properties": { "city": { "type": "string" } },
                        "required": ["city"],
                    }),
                    kind: Some(ToolKind::Function),
                    host_config: None,
                    permission_level: None,
                    display_group: None,
                    tenant_scope: None,
                },
                ToolDefinition {
                    tool_id: "web_search".into(),
                    name: "web_search".into(),
                    description: "Hosted web search tool".into(),
                    input_schema: json!({}),
                    kind: Some(ToolKind::Hosted),
                    host_config: None,
                    permission_level: Some(PermissionLevel::SideEffectful),
                    display_group: None,
                    tenant_scope: None,
                },
            ],
            generation_controls: None,
            response_format: None,
            web_search: None,
        };

        let body = build_payload(&NormalizedRequest {
            request: request.clone(),
        });
        let tools = body.get("tools").and_then(|v| v.as_array()).expect("tools");
        // Only the function tool: the hosted tool has no wire shape on Ollama.
        assert_eq!(tools.len(), 1);
        assert_eq!(
            tools[0].get("type").and_then(|v| v.as_str()),
            Some("function")
        );
        assert_eq!(
            tools[0].pointer("/function/name").and_then(|v| v.as_str()),
            Some("get_weather")
        );
        assert_eq!(
            tools[0]
                .pointer("/function/description")
                .and_then(|v| v.as_str()),
            Some("Get the weather in a given city")
        );
        assert_eq!(
            tools[0]
                .pointer("/function/parameters/type")
                .and_then(|v| v.as_str()),
            Some("object")
        );

        // No tool_definitions at all -> no "tools" key.
        request.tool_definitions = vec![];
        let body = build_payload(&NormalizedRequest { request });
        assert!(body.get("tools").is_none());
    }

    #[test]
    fn payload_includes_images_array() {
        use crate::schema::Message;
        let request = ProviderRequest {
            request_id: "req-vision".into(),
            conversation_id: "conv-1".into(),
            model_id: "llava".into(),
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
                        mime_type: Some("image/png".into()),
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
        let images = body
            .pointer("/messages/0/images")
            .and_then(|v| v.as_array())
            .expect("images");
        assert_eq!(images[0].as_str(), Some("QUJD"));
        assert_eq!(
            body.pointer("/messages/0/content").and_then(|v| v.as_str()),
            Some("look")
        );
    }
}
