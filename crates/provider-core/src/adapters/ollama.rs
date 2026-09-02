use crate::adapter::{AdapterContext, ModelInfo, ProviderAdapter, StreamParser};
use crate::adapters::{
    message_text, normalized_or_err, parse_fixture_stream, role_to_string, wrap_sse_stream,
};
use crate::normalize::NormalizedRequest;
use crate::schema::{
    MessagePart, MessagePartKind, MessageRole, ProviderError, ProviderEvent, ProviderRequest,
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

struct OllamaParser;

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

    json!({
      "model": request.model_id,
      "messages": messages,
      "stream": true,
    })
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

        Ok(wrap_sse_stream(request_id, OllamaParser, sse))
    }
}

pub fn parse_fixture(request_id: &str, fixture: &str) -> Vec<ProviderEvent> {
    parse_fixture_stream(&mut OllamaParser, request_id, fixture, |line| {
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
