use crate::adapter::{AdapterContext, ModelInfo, ProviderAdapter, StreamParser};
use crate::adapters::{
    message_text, missing_key, normalized_or_err, parse_fixture_stream, wrap_sse_stream,
};
use crate::error::fatal;
use crate::image_generation::{decode_generated_image, top_level_keys};
use crate::normalize::NormalizedRequest;
use crate::output_limits::FINISH_REASON_LENGTH;
use crate::schema::{
    ContentAnnotation, ImageGenerationRequest, ImageGenerationResult, MessagePartKind, MessageRole,
    ProviderError, ProviderEvent, ProviderRequest, ToolChoice, ToolKind,
};
use crate::transport::{gemini_api_key_header, get_json, post_json, post_sse, SseRequest};
use async_trait::async_trait;
use futures::stream::Stream;
use serde_json::{json, Value};
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

const DEFAULT_BASE: &str = "https://generativelanguage.googleapis.com/v1beta";

pub struct GeminiAdapter;

struct GeminiParser {
    block_id: String,
    text_block_started: bool,
    emitted_search_call: bool,
    search_call_id: String,
    /// Monotonic counter for synthesizing unique tool_call_ids when the API
    /// omits `id` on functionCall parts (parallel same-name calls).
    function_call_seq: u32,
    /// Set when a candidate reports `finishReason: "MAX_TOKENS"`.
    finish_reason: Option<&'static str>,
}

impl GeminiParser {
    fn new() -> Self {
        Self {
            block_id: "gemini-text-0".to_string(),
            text_block_started: false,
            emitted_search_call: false,
            search_call_id: "gemini-web-search-0".to_string(),
            function_call_seq: 0,
            finish_reason: None,
        }
    }

    fn parse_generate_content_response(
        &mut self,
        request_id: &str,
        value: &Value,
        index: &mut usize,
    ) -> Vec<ProviderEvent> {
        if let Some(err) = value.get("error") {
            let message = err
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("Gemini stream error")
                .to_string();
            return vec![ProviderEvent::Error {
                request_id: request_id.to_string(),
                error: ProviderError {
                    provider_code: err
                        .get("status")
                        .or_else(|| err.get("code"))
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    retryable: false,
                    message,
                },
            }];
        }

        let mut events = Vec::new();
        let Some(candidate) = value.pointer("/candidates/0") else {
            return events;
        };
        if candidate.get("finishReason").and_then(|v| v.as_str()) == Some("MAX_TOKENS") {
            self.finish_reason = Some(FINISH_REASON_LENGTH);
        }

        if let Some(parts) = candidate
            .pointer("/content/parts")
            .and_then(|p| p.as_array())
        {
            for part in parts {
                if let Some(text) = part.get("text").and_then(|v| v.as_str()) {
                    if part.get("thought").and_then(|v| v.as_bool()) == Some(true) {
                        events.push(ProviderEvent::ReasoningDelta {
                            request_id: request_id.to_string(),
                            block_id: self.block_id.clone(),
                            index: *index,
                            content: text.to_string(),
                        });
                    } else if !text.is_empty() {
                        if !self.text_block_started {
                            self.text_block_started = true;
                            events.push(ProviderEvent::ContentBlockStart {
                                request_id: request_id.to_string(),
                                block_id: self.block_id.clone(),
                                index: *index,
                                block_kind: "text".to_string(),
                            });
                        }
                        events.push(ProviderEvent::ContentDelta {
                            request_id: request_id.to_string(),
                            block_id: self.block_id.clone(),
                            index: *index,
                            content: text.to_string(),
                        });
                    }
                    *index += 1;
                }

                if let Some(call) = part.get("functionCall") {
                    events.extend(self.parse_function_call(request_id, call, index));
                }
            }
        }

        if let Some(metadata) = candidate.get("groundingMetadata") {
            events.extend(self.parse_grounding_metadata(request_id, metadata, index));
        }

        if let Some(usage) = value.get("usageMetadata") {
            events.push(ProviderEvent::Usage {
                request_id: request_id.to_string(),
                usage: crate::schema::ProviderUsage {
                    input_tokens: usage.get("promptTokenCount").and_then(|v| v.as_u64()),
                    output_tokens: usage.get("candidatesTokenCount").and_then(|v| v.as_u64()),
                    cache_tokens: usage
                        .get("cachedContentTokenCount")
                        .and_then(|v| v.as_u64()),
                    cache_read_tokens: usage
                        .get("cachedContentTokenCount")
                        .and_then(|v| v.as_u64()),
                    cache_write_tokens: None,
                    cost_hint: None,
                },
            });
            *index += 1;
        }

        events
    }

    fn parse_function_call(
        &mut self,
        request_id: &str,
        call: &Value,
        index: &mut usize,
    ) -> Vec<ProviderEvent> {
        let name = call
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("tool")
            .to_string();
        let tool_call_id = call
            .get("id")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| {
                let seq = self.function_call_seq;
                self.function_call_seq += 1;
                format!("gemini-fc-{name}-{seq}")
            });
        let args = call.get("args").cloned().unwrap_or_else(|| json!({}));

        let start = ProviderEvent::ToolCallStart {
            request_id: request_id.to_string(),
            tool_call_id: tool_call_id.clone(),
            index: *index,
            tool_id: name.clone(),
            name,
        };
        *index += 1;
        let complete = ProviderEvent::ToolCallComplete {
            request_id: request_id.to_string(),
            tool_call_id,
            index: *index,
            arguments: args,
        };
        *index += 1;
        vec![start, complete]
    }

    fn parse_grounding_metadata(
        &mut self,
        request_id: &str,
        metadata: &Value,
        index: &mut usize,
    ) -> Vec<ProviderEvent> {
        let mut events = Vec::new();

        if let Some(queries) = metadata.get("webSearchQueries").and_then(|v| v.as_array()) {
            if !queries.is_empty() && !self.emitted_search_call {
                self.emitted_search_call = true;
                let query = queries
                    .first()
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                events.push(ProviderEvent::ToolCallStart {
                    request_id: request_id.to_string(),
                    tool_call_id: self.search_call_id.clone(),
                    index: *index,
                    tool_id: "web_search".to_string(),
                    name: "web_search".to_string(),
                });
                *index += 1;
                events.push(ProviderEvent::ToolCallComplete {
                    request_id: request_id.to_string(),
                    tool_call_id: self.search_call_id.clone(),
                    index: *index,
                    arguments: json!({ "query": query }),
                });
                *index += 1;
                events.push(ProviderEvent::SearchCost {
                    request_id: request_id.to_string(),
                    index: *index,
                    tool_calls: queries.len() as u32,
                });
                *index += 1;
            }
        }

        let chunks = metadata
            .get("groundingChunks")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        if !chunks.is_empty() {
            let sources: Vec<Value> = chunks
                .iter()
                .filter_map(|chunk| {
                    let web = chunk.get("web")?;
                    Some(json!({
                        "url": web.get("uri").and_then(|v| v.as_str()).unwrap_or(""),
                        "title": web.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                    }))
                })
                .collect();
            if !sources.is_empty() {
                events.push(ProviderEvent::SearchSources {
                    request_id: request_id.to_string(),
                    index: *index,
                    sources: Value::Array(sources),
                });
                *index += 1;
            }
        }

        if let Some(supports) = metadata.get("groundingSupports").and_then(|v| v.as_array()) {
            for support in supports {
                let Some(segment) = support.get("segment") else {
                    continue;
                };
                let start_index = segment
                    .get("startIndex")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                let end_index = segment
                    .get("endIndex")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as u32;
                let chunk_index = support
                    .get("groundingChunkIndices")
                    .and_then(|v| v.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0) as usize;
                let chunk = chunks.get(chunk_index);
                let (url, title) = chunk
                    .and_then(|c| c.get("web"))
                    .map(|web| {
                        (
                            web.get("uri")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                            web.get("title")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string(),
                        )
                    })
                    .unwrap_or_default();

                if url.is_empty() {
                    continue;
                }

                events.push(ProviderEvent::Citation {
                    request_id: request_id.to_string(),
                    block_id: self.block_id.clone(),
                    index: *index,
                    annotation: ContentAnnotation::UrlCitation {
                        url,
                        title,
                        start_index,
                        end_index,
                    },
                });
                *index += 1;
            }
        }

        events
    }
}

impl StreamParser for GeminiParser {
    fn parse_chunk(
        &mut self,
        request_id: &str,
        data: &str,
        index: &mut usize,
    ) -> Vec<ProviderEvent> {
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            return vec![];
        };
        self.parse_generate_content_response(request_id, &value, index)
    }

    fn finish_reason(&self) -> Option<&str> {
        self.finish_reason
    }
}

fn normalize_model_id(model_id: &str) -> String {
    model_id
        .trim()
        .strip_prefix("models/")
        .unwrap_or(model_id.trim())
        .to_string()
}

fn build_payload(normalized: &NormalizedRequest) -> Value {
    let request = &normalized.request;
    let mut contents = Vec::new();

    for message in &request.messages {
        match message.role {
            MessageRole::Assistant => {
                let tool_calls_meta = message
                    .parts
                    .iter()
                    .find_map(|p| p.metadata.as_ref()?.get("tool_calls"))
                    .and_then(|v| v.as_array());

                let text_content = message_text(message);
                let mut parts: Vec<Value> = Vec::new();

                if !text_content.is_empty() {
                    parts.push(json!({ "text": text_content }));
                }

                if let Some(tc_array) = tool_calls_meta {
                    for tc in tc_array {
                        let name = tc
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("tool")
                            .to_string();
                        let args = tc.get("arguments").cloned().unwrap_or_else(|| json!({}));
                        let mut call = json!({
                            "name": name,
                            "args": args,
                        });
                        if let Some(id) = tc.get("tool_call_id").and_then(|v| v.as_str()) {
                            call["id"] = json!(id);
                        }
                        parts.push(json!({ "functionCall": call }));
                    }
                }

                if !parts.is_empty() {
                    contents.push(json!({
                        "role": "model",
                        "parts": parts,
                    }));
                }
            }
            MessageRole::Tool => {
                let responses: Vec<Value> = message
                    .parts
                    .iter()
                    .filter(|p| p.kind == MessagePartKind::ToolResult)
                    .map(|p| {
                        let name = p
                            .metadata
                            .as_ref()
                            .and_then(|m| m.get("name"))
                            .and_then(|v| v.as_str())
                            .or(p.tool_call_id.as_deref())
                            .unwrap_or("tool");
                        let response_body = if let Ok(parsed) =
                            serde_json::from_str::<Value>(p.content.as_deref().unwrap_or("{}"))
                        {
                            parsed
                        } else {
                            json!({ "output": p.content.as_deref().unwrap_or("") })
                        };
                        // Gemini correlates by name today, but include id when we
                        // have one so it matches the functionCall id we synthesized.
                        let mut function_response = json!({
                            "name": name,
                            "response": response_body,
                        });
                        if let Some(id) = p.tool_call_id.as_deref().filter(|s| !s.is_empty()) {
                            function_response["id"] = json!(id);
                        }
                        json!({ "functionResponse": function_response })
                    })
                    .collect();

                if !responses.is_empty() {
                    contents.push(json!({
                        "role": "user",
                        "parts": responses,
                    }));
                }
            }
            MessageRole::User => {
                contents.push(json!({
                    "role": "user",
                    "parts": crate::adapters::gemini_user_parts(message),
                }));
            }
            MessageRole::System | MessageRole::Developer => {}
        }
    }

    // Gemini has no developer role — fold system + developer into systemInstruction
    // (system first, then developer) when both are set.
    let mut system_parts = Vec::new();
    if let Some(system) = &request.system_prompt {
        system_parts.push(system.as_str());
    }
    if let Some(developer) = &request.developer_prompt {
        system_parts.push(developer.as_str());
    }

    let web_search_intent = request
        .web_search
        .as_ref()
        .map(|w| w.enabled)
        .unwrap_or(false);

    let mut body = json!({ "contents": contents });

    if !system_parts.is_empty() {
        body["systemInstruction"] = json!({
            "parts": [{ "text": system_parts.join("\n\n") }],
        });
    }

    let mut generation_config = serde_json::Map::new();
    if let Some(controls) = &request.generation_controls {
        if let Some(max_tokens) = controls.max_tokens {
            generation_config.insert("maxOutputTokens".to_string(), json!(max_tokens));
        }
        if let Some(temp) = controls.temperature {
            generation_config.insert("temperature".to_string(), json!(temp));
        }
        if let Some(top_p) = controls.top_p {
            generation_config.insert("topP".to_string(), json!(top_p));
        }
        if let Some(stops) = &controls.stop_sequences {
            generation_config.insert("stopSequences".to_string(), json!(stops));
        }
    }
    // No `maxOutputTokens` unless the user set one: the API then allows the
    // model's full output. A fixed fallback here used to cap every response at
    // 8,192 tokens — thinking included — which cut long documents off, and
    // only applied when no other control was set.
    if !generation_config.is_empty() {
        body["generationConfig"] = Value::Object(generation_config);
    }

    let mut tools: Vec<Value> = Vec::new();
    let mut function_declarations: Vec<Value> = Vec::new();

    for tool in &request.tool_definitions {
        if matches!(tool.kind, Some(ToolKind::Hosted)) {
            if tool.name == "google_search" || tool.name == "web_search" {
                tools.push(json!({ "google_search": {} }));
            }
            continue;
        }
        function_declarations.push(json!({
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.input_schema,
        }));
    }

    if web_search_intent && !tools.iter().any(|t| t.get("google_search").is_some()) {
        tools.push(json!({ "google_search": {} }));
    }

    if !function_declarations.is_empty() {
        tools.push(json!({ "functionDeclarations": function_declarations }));
    }

    if !tools.is_empty() {
        body["tools"] = Value::Array(tools);
    }

    if let Some(controls) = &request.generation_controls {
        if let Some(choice) = &controls.tool_choice {
            let mode = match choice {
                ToolChoice::Auto => "AUTO",
                ToolChoice::None => "NONE",
                ToolChoice::Required => "ANY",
                ToolChoice::Specific { .. } => "ANY",
            };
            body["toolConfig"] = json!({
                "functionCallingConfig": { "mode": mode },
            });
        }
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

/// OpenCode Zen proxies Gemini at `/v1/models/{id}?alt=sse` instead of the
/// native `:streamGenerateContent` path.
pub(crate) fn is_zen_gemini_base(base: &str) -> bool {
    base.contains("opencode.ai/zen")
}

fn stream_generate_url(base: &str, model: &str) -> String {
    if is_zen_gemini_base(base) {
        format!("{base}/models/{model}?alt=sse")
    } else {
        format!("{base}/models/{model}:streamGenerateContent?alt=sse")
    }
}

fn stream_auth_headers(base: &str, key: &str) -> Result<reqwest::header::HeaderMap, ProviderError> {
    if is_zen_gemini_base(base) {
        crate::transport::bearer_header(key)
    } else {
        gemini_api_key_header(key)
    }
}

fn parse_model_list(response: &Value) -> Result<Vec<ModelInfo>, ProviderError> {
    let items = response
        .get("models")
        .and_then(|d| d.as_array())
        .ok_or_else(|| {
            crate::error::fatal("gemini /models response did not contain a models array")
        })?;

    let models = items
        .iter()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?;
            let methods = item
                .get("supportedGenerationMethods")
                .and_then(|v| v.as_array());
            if let Some(methods) = methods {
                let supports_generate = methods.iter().any(|m| {
                    m.as_str()
                        .is_some_and(|s| s == "generateContent" || s == "streamGenerateContent")
                });
                if !supports_generate {
                    return None;
                }
            }
            Some(ModelInfo {
                id: normalize_model_id(name),
                display_name: item
                    .get("displayName")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
            })
        })
        .collect();

    Ok(models)
}

#[async_trait]
impl ProviderAdapter for GeminiAdapter {
    fn id(&self) -> &'static str {
        "gemini"
    }

    fn display_name(&self) -> &'static str {
        "Google Gemini"
    }

    async fn validate_credentials(&self, ctx: &AdapterContext) -> Result<(), ProviderError> {
        let key = ctx.api_key.as_deref().ok_or_else(missing_key)?;
        let cancel = CancellationToken::new();
        let _ = get_json(
            &ctx.http,
            &format!("{}/models", base_url(ctx)),
            gemini_api_key_header(key)?,
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
            &format!("{}/models", base_url(ctx)),
            gemini_api_key_header(key)?,
            cancel,
        )
        .await?;
        parse_model_list(&response)
    }

    /// t0-8 M2: `POST {base}/models/{model}:predict`. The response shape is
    /// not officially documented (see the adapter's `parse_image_response`
    /// doc comment), so decoding is defensive: a missing
    /// `bytesBase64Encoded` field names the response's actual top-level keys
    /// rather than silently returning empty bytes.
    async fn generate_image(
        &self,
        request: ImageGenerationRequest,
        ctx: &AdapterContext,
    ) -> Result<ImageGenerationResult, ProviderError> {
        let key = ctx.api_key.as_deref().ok_or_else(missing_key)?;
        let model = normalize_model_id(&request.model_id);
        let body = json!({
            "instances": [{ "prompt": request.prompt }],
            "parameters": { "sampleCount": 1 },
        });

        let cancel = CancellationToken::new();
        let response = post_json(
            &ctx.http,
            &format!("{}/models/{model}:predict", base_url(ctx)),
            gemini_api_key_header(key)?,
            body,
            cancel,
        )
        .await?;

        parse_image_response(&response)
    }

    async fn stream_chat(
        &self,
        request: ProviderRequest,
        ctx: AdapterContext,
        cancel: CancellationToken,
    ) -> Result<Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>, ProviderError> {
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

        let key = ctx.api_key.as_deref().ok_or_else(missing_key)?;
        let normalized = normalized_or_err(request)?;
        let request_id = normalized.request.request_id.clone();
        let model = normalize_model_id(&normalized.request.model_id);
        let body = build_payload(&normalized);

        let base = base_url(&ctx);
        let sse = post_sse(
            &ctx.http,
            SseRequest {
                url: stream_generate_url(&base, &model),
                headers: stream_auth_headers(&base, key)?,
                body,
            },
            cancel,
        )
        .await?;

        Ok(wrap_sse_stream(request_id, GeminiParser::new(), sse))
    }
}

pub fn parse_fixture(request_id: &str, fixture: &str) -> Vec<ProviderEvent> {
    parse_fixture_stream(&mut GeminiParser::new(), request_id, fixture, |line| {
        line.strip_prefix("data:").map(str::trim)
    })
}

/// t0-8 M2: decode a `:predict` response. **The response shape below is
/// triangulated from three non-official sources, not Google's official
/// reference** (which omits the response schema for this endpoint):
/// `{"predictions": [{"bytesBase64Encoded": "...", "mimeType": "image/png"}]}`.
/// Because it is unconfirmed, this decodes defensively: any missing/renamed
/// field produces an error that quotes the actual top-level keys present, so
/// a real-world shape change is diagnosable from the error text instead of
/// silently producing empty bytes.
pub(crate) fn parse_image_response(value: &Value) -> Result<ImageGenerationResult, ProviderError> {
    let entry = value.pointer("/predictions/0").ok_or_else(|| {
        fatal(format!(
            "gemini image-generation response had no predictions[0] entry (top-level keys: {})",
            top_level_keys(value)
        ))
    })?;

    let Some(b64) = entry.get("bytesBase64Encoded").and_then(|v| v.as_str()) else {
        return Err(fatal(format!(
            "gemini image-generation response predictions[0] had no bytesBase64Encoded field \
             (keys: {})",
            top_level_keys(entry)
        )));
    };
    let claimed_mime = entry.get("mimeType").and_then(|v| v.as_str());

    decode_generated_image("gemini", b64, claimed_mime.or(Some("image/png")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_text_fixture() {
        let fixture = include_str!("../../tests/fixtures/gemini/plain_text.sse");
        let events = parse_fixture("req-1", fixture);
        assert!(events.iter().any(
            |e| matches!(e, ProviderEvent::ContentDelta { content, .. } if content == "Hello")
        ));
    }

    #[test]
    fn max_tokens_finish_is_reported_as_length() {
        let fixture = include_str!("../../tests/fixtures/gemini/max_tokens.sse");
        let events = parse_fixture("req-1", fixture);
        assert!(
            matches!(
                events.last(),
                Some(ProviderEvent::MessageComplete { finish_reason, .. }) if finish_reason == "length"
            ),
            "{events:?}"
        );

        let fixture = include_str!("../../tests/fixtures/gemini/plain_text.sse");
        let events = parse_fixture("req-2", fixture);
        assert!(matches!(
            events.last(),
            Some(ProviderEvent::MessageComplete { finish_reason, .. }) if finish_reason == "stop"
        ));
    }

    #[test]
    fn parses_tool_call_fixture() {
        let fixture = include_str!("../../tests/fixtures/gemini/tool_call_single.sse");
        let events = parse_fixture("req-1", fixture);
        assert!(events
            .iter()
            .any(|e| matches!(e, ProviderEvent::ToolCallStart { .. })));
        assert!(events
            .iter()
            .any(|e| matches!(e, ProviderEvent::ToolCallComplete { .. })));
    }

    #[test]
    fn parallel_same_name_tool_calls_get_unique_ids() {
        let fixture = include_str!("../../tests/fixtures/gemini/tool_call_parallel.sse");
        let events = parse_fixture("req-1", fixture);

        let starts: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                ProviderEvent::ToolCallStart { tool_call_id, .. } => Some(tool_call_id.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(starts.len(), 2);
        assert_ne!(starts[0], starts[1]);
        assert!(starts
            .iter()
            .all(|id| id.starts_with("gemini-fc-get_weather-")));

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
        assert_eq!(completes.len(), 2);
        assert_eq!(
            completes[0].1.get("city").and_then(|v| v.as_str()),
            Some("NYC")
        );
        assert_eq!(
            completes[1].1.get("city").and_then(|v| v.as_str()),
            Some("LA")
        );
    }

    #[test]
    fn parses_grounding_fixture() {
        let fixture = include_str!("../../tests/fixtures/gemini/grounding.sse");
        let events = parse_fixture("req-1", fixture);
        assert!(events
            .iter()
            .any(|e| matches!(e, ProviderEvent::SearchSources { .. })));
        assert!(events
            .iter()
            .any(|e| matches!(e, ProviderEvent::Citation { .. })));
        assert!(events.iter().any(
            |e| matches!(e, ProviderEvent::ToolCallStart { name, .. } if name == "web_search")
        ));
    }

    #[test]
    fn build_payload_emits_function_response_with_tool_call_id() {
        use crate::schema::{Message, MessagePart, ProviderRequest};

        let request = ProviderRequest {
            request_id: "r1".to_string(),
            conversation_id: "c1".to_string(),
            model_id: "gemini-2.5-flash".to_string(),
            messages: vec![
                Message {
                    id: "m-assistant".to_string(),
                    conversation_id: "c1".to_string(),
                    role: MessageRole::Assistant,
                    author_label: None,
                    provider_message_id: None,
                    request_id: None,
                    interrupted_at: None,
                    metadata: None,
                    parts: vec![MessagePart {
                        id: "p1".to_string(),
                        message_id: "m-assistant".to_string(),
                        index: 0,
                        kind: MessagePartKind::Text,
                        content: None,
                        mime_type: None,
                        tool_call_id: None,
                        artifact_id: None,
                        attachment_id: None,
                        blob_ref: None,
                        metadata: Some(serde_json::json!({
                            "tool_calls": [{
                                "name": "get_weather",
                                "tool_call_id": "gemini-fc-get_weather-0",
                                "arguments": { "city": "NYC" }
                            }]
                        })),
                        created_at: "now".to_string(),
                    }],
                    created_at: "now".to_string(),
                },
                Message {
                    id: "m-tool".to_string(),
                    conversation_id: "c1".to_string(),
                    role: MessageRole::Tool,
                    author_label: None,
                    provider_message_id: None,
                    request_id: None,
                    interrupted_at: None,
                    metadata: None,
                    parts: vec![MessagePart {
                        id: "p2".to_string(),
                        message_id: "m-tool".to_string(),
                        index: 0,
                        kind: MessagePartKind::ToolResult,
                        content: Some(r#"{"temp_f": 72}"#.to_string()),
                        mime_type: None,
                        tool_call_id: Some("gemini-fc-get_weather-0".to_string()),
                        artifact_id: None,
                        attachment_id: None,
                        blob_ref: None,
                        metadata: Some(serde_json::json!({ "name": "get_weather" })),
                        created_at: "now".to_string(),
                    }],
                    created_at: "now".to_string(),
                },
            ],
            system_prompt: None,
            developer_prompt: None,
            tool_definitions: vec![],
            generation_controls: None,
            attachments: None,
            response_format: None,
            web_search: None,
        };

        let body = build_payload(&NormalizedRequest { request });
        assert!(
            body.get("generationConfig").is_none(),
            "no output cap may be sent when the user set none: {body}"
        );
        let contents = body
            .get("contents")
            .and_then(|v| v.as_array())
            .expect("contents");
        let tool_turn = contents
            .iter()
            .find(|c| c.get("role").and_then(|v| v.as_str()) == Some("user"))
            .expect("tool result turn");
        let fr = tool_turn
            .pointer("/parts/0/functionResponse")
            .expect("functionResponse");
        assert_eq!(fr.get("name").and_then(|v| v.as_str()), Some("get_weather"));
        assert_eq!(
            fr.get("id").and_then(|v| v.as_str()),
            Some("gemini-fc-get_weather-0")
        );
        assert_eq!(
            fr.pointer("/response/temp_f").and_then(|v| v.as_u64()),
            Some(72)
        );
    }

    #[test]
    fn list_models_parses_models_array() {
        let response = serde_json::json!({
            "models": [
                {
                    "name": "models/gemini-2.5-flash",
                    "displayName": "Gemini 2.5 Flash",
                    "supportedGenerationMethods": ["generateContent", "streamGenerateContent"]
                },
                {
                    "name": "models/embedding-001",
                    "supportedGenerationMethods": ["embedContent"]
                }
            ]
        });
        let models = parse_model_list(&response).expect("valid response parses");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gemini-2.5-flash");
        assert_eq!(models[0].display_name.as_deref(), Some("Gemini 2.5 Flash"));
    }

    #[test]
    fn normalize_model_id_strips_models_prefix() {
        assert_eq!(
            normalize_model_id("models/gemini-2.5-flash"),
            "gemini-2.5-flash"
        );
        assert_eq!(normalize_model_id("gemini-2.5-flash"), "gemini-2.5-flash");
    }

    #[test]
    fn build_payload_includes_google_search_when_enabled() {
        use crate::schema::{ProviderRequest, WebSearchRequest};

        let request = ProviderRequest {
            request_id: "r1".to_string(),
            conversation_id: "c1".to_string(),
            model_id: "gemini-2.5-flash".to_string(),
            messages: vec![crate::schema::Message {
                id: "m1".to_string(),
                conversation_id: "c1".to_string(),
                role: MessageRole::User,
                author_label: None,
                provider_message_id: None,
                request_id: None,
                interrupted_at: None,
                metadata: None,
                parts: vec![crate::schema::MessagePart {
                    id: "p1".to_string(),
                    message_id: "m1".to_string(),
                    index: 0,
                    kind: MessagePartKind::Text,
                    content: Some("hi".to_string()),
                    mime_type: None,
                    tool_call_id: None,
                    artifact_id: None,
                    attachment_id: None,
                    blob_ref: None,
                    metadata: None,
                    created_at: "now".to_string(),
                }],
                created_at: "now".to_string(),
            }],
            system_prompt: None,
            developer_prompt: None,
            tool_definitions: vec![],
            generation_controls: None,
            attachments: None,
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

        let body = build_payload(&NormalizedRequest { request });
        let tools = body.get("tools").and_then(|v| v.as_array()).expect("tools");
        assert!(tools.iter().any(|t| t.get("google_search").is_some()));
    }

    #[test]
    fn zen_stream_url_uses_proxy_path() {
        assert!(is_zen_gemini_base("https://opencode.ai/zen/v1"));
        assert_eq!(
            stream_generate_url("https://opencode.ai/zen/v1", "gemini-3.5-flash"),
            "https://opencode.ai/zen/v1/models/gemini-3.5-flash?alt=sse"
        );
        assert_eq!(
            stream_generate_url(
                "https://generativelanguage.googleapis.com/v1beta",
                "gemini-3.5-flash"
            ),
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse"
        );
    }

    #[test]
    fn payload_includes_inline_data_image() {
        use crate::schema::Message;
        let request = ProviderRequest {
            request_id: "req-vision".into(),
            conversation_id: "conv-1".into(),
            model_id: "gemini-2.0-flash".into(),
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
                    crate::schema::MessagePart {
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
                    crate::schema::MessagePart {
                        id: "p2".into(),
                        message_id: "m1".into(),
                        index: 1,
                        kind: MessagePartKind::Image,
                        content: Some("QUJD".into()),
                        mime_type: Some("image/webp".into()),
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
        let parts = body
            .pointer("/contents/0/parts")
            .and_then(|v| v.as_array())
            .expect("parts");
        assert!(parts[0].get("text").is_some());
        assert_eq!(
            parts[1]
                .pointer("/inlineData/mimeType")
                .and_then(|v| v.as_str()),
            Some("image/webp")
        );
        assert_eq!(
            parts[1]
                .pointer("/inlineData/data")
                .and_then(|v| v.as_str()),
            Some("QUJD")
        );
    }

    /// 1x1 PNG, base64-encoded (same bytes the desktop crate's `vision.rs`
    /// sniff test uses).
    const ONE_PIXEL_PNG_B64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAADAAEABf7U7wAAAABJRU5ErkJggg==";

    #[test]
    fn parse_image_response_decodes_bytes_base64_encoded_and_sniffs_png() {
        let value = json!({
            "predictions": [{ "bytesBase64Encoded": ONE_PIXEL_PNG_B64, "mimeType": "image/png" }]
        });
        let result = parse_image_response(&value).expect("decode should succeed");
        assert_eq!(result.mime_type, "image/png");
        assert_eq!(result.bytes.len(), 70);
    }

    #[test]
    fn parse_image_response_reports_unexpected_shape() {
        // Simulates the documented risk: the real API renames or omits the
        // field this adapter expects.
        let value = json!({
            "predictions": [{ "someOtherField": "unexpected" }]
        });
        let err = parse_image_response(&value).expect_err("missing field should error");
        assert!(
            err.message.contains("someOtherField"),
            "expected the error to name the actual keys present: {}",
            err.message
        );
    }

    #[test]
    fn parse_image_response_reports_missing_predictions() {
        let value = json!({ "error": { "message": "invalid argument" } });
        let err = parse_image_response(&value).expect_err("missing predictions should error");
        assert!(
            err.message.contains("error"),
            "expected the error to name the actual top-level keys: {}",
            err.message
        );
    }

    #[test]
    fn parse_image_response_rejects_oversized_payload() {
        use base64::Engine;
        let oversized = vec![0u8; crate::image_generation::IMAGE_GENERATION_MAX_BYTES + 1];
        let b64 = base64::engine::general_purpose::STANDARD.encode(&oversized);
        let value = json!({ "predictions": [{ "bytesBase64Encoded": b64 }] });
        let err = parse_image_response(&value).expect_err("oversized payload should be rejected");
        assert!(
            err.message.contains("exceeds"),
            "expected a size-cap error: {}",
            err.message
        );
    }

    /// Manual QA helper (t0-8 M3 follow-up): a real, non-mocked call to
    /// Gemini's Imagen endpoint. Mirrors `openai::tests::openai_live_generate_image`
    /// and `opencode_zen::tests::zen_live_validate_and_list_models` — `#[ignore]`d
    /// so `cargo test` never spends real money or needs network by default.
    ///
    /// Run with: `GEMINI_API_KEY=... cargo test -p provider-core gemini_live_generate_image -- --ignored`
    #[tokio::test]
    #[ignore = "requires GEMINI_API_KEY and network"]
    async fn gemini_live_generate_image() {
        let key = std::env::var("GEMINI_API_KEY").expect("GEMINI_API_KEY must be set");
        let model_id = std::env::var("GEMINI_IMAGE_MODEL").unwrap_or_else(|_| {
            crate::image_generation::default_image_model("gemini")
                .expect("gemini has a default image model")
                .to_string()
        });

        let adapter = GeminiAdapter;
        let ctx = AdapterContext {
            api_key: Some(key),
            base_url: None,
            http: crate::transport::HttpClient::new(),
            local_only: false,
        };
        let request = crate::schema::ImageGenerationRequest {
            prompt: "a small red circle on a plain white background".to_string(),
            size: None,
            model_id,
        };

        let result = adapter
            .generate_image(request, &ctx)
            .await
            .expect("generate_image should succeed against the real API");
        assert!(
            !result.bytes.is_empty(),
            "expected a non-empty image payload"
        );
        assert!(
            result.mime_type.starts_with("image/"),
            "expected an image MIME type, got {}",
            result.mime_type
        );
    }
}
