//! OpenCode Zen multi-protocol router.
//!
//! Zen exposes one API key and routes each model to a different upstream protocol
//! (OpenAI Responses, Anthropic Messages, Gemini, or Chat Completions). This
//! adapter discovers models from `GET /v1/models` and delegates streaming to the
//! appropriate inner adapter with protocol-specific base URLs.

use crate::adapter::{AdapterContext, ModelInfo, ProviderAdapter};
use crate::adapters::anthropic::AnthropicAdapter;
use crate::adapters::gemini::GeminiAdapter;
use crate::adapters::missing_key;
use crate::adapters::openai::OpenAiAdapter;
use crate::schema::{ProviderError, ProviderEvent, ProviderRequest, ToolKind};
use crate::transport::{bearer_header, get_json};
use async_trait::async_trait;
use futures::stream::{Stream, StreamExt};
use serde_json::Value;
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Mutex;
use tokio_util::sync::CancellationToken;

pub const ZEN_V1_BASE: &str = "https://opencode.ai/zen/v1";
pub const ZEN_ROOT: &str = "https://opencode.ai/zen";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ZenProtocol {
    Responses,
    Messages,
    Gemini,
    ChatCompletions,
}

#[derive(Debug, Clone)]
pub struct ZenModelMeta {
    pub id: String,
    pub display_name: Option<String>,
    pub protocol: ZenProtocol,
}

pub struct OpenCodeZenAdapter {
    protocol_cache: Mutex<HashMap<String, ZenProtocol>>,
}

impl OpenCodeZenAdapter {
    pub fn new() -> Self {
        Self {
            protocol_cache: Mutex::new(HashMap::new()),
        }
    }

    fn zen_chat_adapter() -> OpenAiAdapter {
        OpenAiAdapter::preset(
            "opencode_zen_inner",
            "OpenCode Zen",
            ZEN_V1_BASE,
            false,
            false,
            &[],
            true,
            false,
        )
    }

    fn zen_responses_adapter() -> OpenAiAdapter {
        OpenAiAdapter::preset(
            "opencode_zen_inner",
            "OpenCode Zen",
            ZEN_V1_BASE,
            false,
            false,
            &[],
            false,
            true,
        )
    }

    fn delegate_ctx(base: &str, ctx: &AdapterContext) -> AdapterContext {
        AdapterContext {
            base_url: Some(base.to_string()),
            ..ctx.clone()
        }
    }

    fn resolve_protocol(&self, model_id: &str) -> ZenProtocol {
        if let Ok(cache) = self.protocol_cache.lock() {
            if let Some(protocol) = cache.get(model_id) {
                return *protocol;
            }
        }
        protocol_from_model_id(model_id)
    }

    fn refresh_cache(&self, models: &[ZenModelMeta]) {
        if let Ok(mut cache) = self.protocol_cache.lock() {
            cache.clear();
            for model in models {
                cache.insert(model.id.clone(), model.protocol);
            }
        }
    }
}

impl Default for OpenCodeZenAdapter {
    fn default() -> Self {
        Self::new()
    }
}

pub fn parse_zen_models(response: &Value) -> Vec<ZenModelMeta> {
    let items = response.pointer("/data").and_then(|d| d.as_array());

    let Some(items) = items else {
        return Vec::new();
    };

    items
        .iter()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.to_string();
            let display_name = item
                .get("display_name")
                .or_else(|| item.get("name"))
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let protocol = protocol_from_model_object(item).unwrap_or_else(|| protocol_from_model_id(&id));
            Some(ZenModelMeta {
                id,
                display_name,
                protocol,
            })
        })
        .collect()
}

fn protocol_from_model_object(item: &Value) -> Option<ZenProtocol> {
    for key in ["endpoint", "api", "inference_endpoint"] {
        if let Some(endpoint) = item.get(key).and_then(|v| v.as_str()) {
            if let Some(protocol) = protocol_from_endpoint_hint(endpoint) {
                return Some(protocol);
            }
        }
    }
    if let Some(provider) = item.get("provider").and_then(|v| v.as_str()) {
        if let Some(protocol) = protocol_from_provider_hint(provider) {
            return Some(protocol);
        }
    }
    if let Some(owned_by) = item.get("owned_by").and_then(|v| v.as_str()) {
        if let Some(protocol) = protocol_from_provider_hint(owned_by) {
            return Some(protocol);
        }
    }
    None
}

fn protocol_from_endpoint_hint(endpoint: &str) -> Option<ZenProtocol> {
    let lower = endpoint.to_ascii_lowercase();
    if lower.contains("/responses") {
        return Some(ZenProtocol::Responses);
    }
    if lower.contains("/messages") {
        return Some(ZenProtocol::Messages);
    }
    if lower.contains("/chat/completions") {
        return Some(ZenProtocol::ChatCompletions);
    }
    if lower.contains("/models/") && !lower.contains("chat") {
        return Some(ZenProtocol::Gemini);
    }
    None
}

fn protocol_from_provider_hint(provider: &str) -> Option<ZenProtocol> {
    let lower = provider.to_ascii_lowercase();
    if lower.contains("anthropic") {
        return Some(ZenProtocol::Messages);
    }
    if lower.contains("google") || lower.contains("gemini") {
        return Some(ZenProtocol::Gemini);
    }
    if lower.contains("openai") {
        return Some(ZenProtocol::Responses);
    }
    None
}

pub fn protocol_from_model_id(model_id: &str) -> ZenProtocol {
    let id = model_id.to_ascii_lowercase();
    if id.starts_with("claude-") || id.starts_with("qwen") {
        return ZenProtocol::Messages;
    }
    if id.starts_with("gemini-") {
        return ZenProtocol::Gemini;
    }
    if id.starts_with("gpt-") || id.contains("codex") {
        return ZenProtocol::Responses;
    }
    ZenProtocol::ChatCompletions
}

#[async_trait]
impl ProviderAdapter for OpenCodeZenAdapter {
    fn id(&self) -> &'static str {
        "opencode_zen"
    }

    fn display_name(&self) -> &'static str {
        "OpenCode Zen"
    }

    async fn validate_credentials(&self, ctx: &AdapterContext) -> Result<(), ProviderError> {
        let key = ctx.api_key.as_deref().ok_or_else(missing_key)?;
        let cancel = CancellationToken::new();
        let _ = get_json(
            &ctx.http,
            &format!("{ZEN_V1_BASE}/models"),
            bearer_header(key)?,
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
            &format!("{ZEN_V1_BASE}/models"),
            bearer_header(key)?,
            cancel,
        )
        .await?;

        let zen_models = parse_zen_models(&response);
        self.refresh_cache(&zen_models);

        Ok(zen_models
            .into_iter()
            .map(|model| ModelInfo {
                id: model.id,
                display_name: model.display_name,
            })
            .collect())
    }

    async fn stream_chat(
        &self,
        mut request: ProviderRequest,
        ctx: AdapterContext,
        cancel: CancellationToken,
    ) -> Result<Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>, ProviderError> {
        let protocol = self.resolve_protocol(&request.model_id);
        let request_id = request.request_id.clone();

        let mut search_unavailable: Option<ProviderEvent> = None;
        if request.web_search.as_ref().is_some_and(|w| w.enabled) {
            search_unavailable = Some(ProviderEvent::SearchUnavailable {
                request_id: request_id.clone(),
                index: 0,
                code: "zen_no_hosted_search".to_string(),
                message: "Hosted web search is not available through OpenCode Zen. Falling back to a no-search response.".to_string(),
            });
            request.web_search = None;
            request.tool_definitions = request
                .tool_definitions
                .into_iter()
                .filter(|tool| !matches!(tool.kind, Some(ToolKind::Hosted)))
                .collect();
        }

        let inner = match protocol {
            ZenProtocol::Responses => {
                Self::zen_responses_adapter()
                    .stream_chat(request, Self::delegate_ctx(ZEN_V1_BASE, &ctx), cancel)
                    .await?
            }
            ZenProtocol::Messages => {
                AnthropicAdapter
                    .stream_chat(request, Self::delegate_ctx(ZEN_ROOT, &ctx), cancel)
                    .await?
            }
            ZenProtocol::Gemini => {
                GeminiAdapter
                    .stream_chat(request, Self::delegate_ctx(ZEN_V1_BASE, &ctx), cancel)
                    .await?
            }
            ZenProtocol::ChatCompletions => {
                Self::zen_chat_adapter()
                    .stream_chat(request, Self::delegate_ctx(ZEN_V1_BASE, &ctx), cancel)
                    .await?
            }
        };

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_zen_models_from_fixture() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/zen/models.json"))
                .expect("zen models fixture");
        let models = parse_zen_models(&fixture);
        assert!(models.len() >= 40, "expected full zen catalog, got {}", models.len());

        let claude = models
            .iter()
            .find(|m| m.id == "claude-sonnet-4-5")
            .expect("claude-sonnet-4-5");
        assert_eq!(claude.protocol, ZenProtocol::Messages);

        let gpt = models.iter().find(|m| m.id == "gpt-5.4").expect("gpt-5.4");
        assert_eq!(gpt.protocol, ZenProtocol::Responses);

        let gemini = models
            .iter()
            .find(|m| m.id == "gemini-3.5-flash")
            .expect("gemini-3.5-flash");
        assert_eq!(gemini.protocol, ZenProtocol::Gemini);

        let deepseek = models
            .iter()
            .find(|m| m.id == "deepseek-v4-flash")
            .expect("deepseek-v4-flash");
        assert_eq!(deepseek.protocol, ZenProtocol::ChatCompletions);
    }

    #[test]
    fn route_model_to_protocol_heuristics() {
        assert_eq!(
            protocol_from_model_id("claude-sonnet-4-5"),
            ZenProtocol::Messages
        );
        assert_eq!(protocol_from_model_id("qwen3.5-plus"), ZenProtocol::Messages);
        assert_eq!(protocol_from_model_id("gpt-5.4"), ZenProtocol::Responses);
        assert_eq!(
            protocol_from_model_id("gpt-5.3-codex"),
            ZenProtocol::Responses
        );
        assert_eq!(
            protocol_from_model_id("gemini-3.5-flash"),
            ZenProtocol::Gemini
        );
        assert_eq!(
            protocol_from_model_id("deepseek-v4-flash"),
            ZenProtocol::ChatCompletions
        );
        assert_eq!(protocol_from_model_id("glm-5"), ZenProtocol::ChatCompletions);
        assert_eq!(
            protocol_from_model_id("kimi-k2.5"),
            ZenProtocol::ChatCompletions
        );
    }

    #[test]
    fn protocol_from_endpoint_metadata() {
        assert_eq!(
            protocol_from_endpoint_hint("https://opencode.ai/zen/v1/responses"),
            Some(ZenProtocol::Responses)
        );
        assert_eq!(
            protocol_from_endpoint_hint("https://opencode.ai/zen/v1/messages"),
            Some(ZenProtocol::Messages)
        );
        assert_eq!(
            protocol_from_endpoint_hint("https://opencode.ai/zen/v1/chat/completions"),
            Some(ZenProtocol::ChatCompletions)
        );
        assert_eq!(
            protocol_from_endpoint_hint("https://opencode.ai/zen/v1/models/gemini-3.5-flash"),
            Some(ZenProtocol::Gemini)
        );
    }

    /// Manual QA helper: `ZEN_API_KEY=... cargo test -p provider-core zen_live -- --ignored`
    #[tokio::test]
    #[ignore = "requires ZEN_API_KEY and network"]
    async fn zen_live_validate_and_list_models() {
        let key = std::env::var("ZEN_API_KEY").expect("ZEN_API_KEY must be set");
        let adapter = OpenCodeZenAdapter::new();
        let ctx = crate::adapter::AdapterContext {
            api_key: Some(key),
            base_url: None,
            http: crate::transport::HttpClient::new(),
            local_only: false,
        };
        adapter.validate_credentials(&ctx).await.expect("validate");
        let models = adapter.list_models(&ctx).await.expect("list_models");
        assert!(!models.is_empty(), "zen catalog must not be empty");
    }
}
