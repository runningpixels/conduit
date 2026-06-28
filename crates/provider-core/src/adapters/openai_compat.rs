use crate::adapter::ProviderAdapter;
use crate::adapters::openai::OpenAiAdapter;
use crate::schema::{ProviderError, ProviderEvent, ProviderRequest};
use async_stream::stream;
use async_trait::async_trait;
use futures::stream::{Stream, StreamExt};
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

/// Default base URL for OpenAI-compatible local servers (e.g. llama.cpp, vLLM).
const COMPAT_DEFAULT_BASE: &str = "http://localhost:8080/v1";

/// Phase 7 / M-WebSearch: hosts we trust to implement OpenAI's hosted
/// `web_search` tool. A tenant may point `openai_compat` at one of these by
/// setting `provider_endpoints[openai_compat].base_url`; otherwise the adapter
/// silently strips the hosted tool and surfaces a `SearchUnavailable` event so
/// the UI can render an explicit "not supported by this endpoint" state instead
/// of silently dropping the user's intent.
const OPENAI_HOSTED_SEARCH_HOSTS: &[&str] = &["api.openai.com"];

/// Returns true if the configured base URL targets a host known to ship
/// OpenAI's hosted-search tool. `localhost` / private IPs / unknown hosts
/// cannot honor the tool and must surface `SearchUnavailable`.
fn endpoint_supports_hosted_search(base_url: Option<&str>) -> bool {
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

/// Thin wrapper around `OpenAiAdapter::compat` so the registry can register the
/// OpenAI-compatible provider as its own id (`"openai_compat"`) without
/// duplicating the OpenAI transport/parser. The inner adapter carries the
/// default base URL; `base_url()` in `openai.rs` falls back to it when the
/// caller has not set `ctx.base_url`.
pub struct OpenAiCompatAdapter(OpenAiAdapter);

impl OpenAiCompatAdapter {
    pub fn new() -> Self {
        Self(OpenAiAdapter::compat(COMPAT_DEFAULT_BASE))
    }
}

impl Default for OpenAiCompatAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ProviderAdapter for OpenAiCompatAdapter {
    fn id(&self) -> &'static str {
        self.0.id()
    }

    fn display_name(&self) -> &'static str {
        self.0.display_name()
    }

    fn is_local(&self) -> bool {
        self.0.is_local()
    }

    async fn validate_credentials(
        &self,
        ctx: &crate::adapter::AdapterContext,
    ) -> Result<(), ProviderError> {
        self.0.validate_credentials(ctx).await
    }

    async fn list_models(
        &self,
        ctx: &crate::adapter::AdapterContext,
    ) -> Result<Vec<crate::adapter::ModelInfo>, ProviderError> {
        self.0.list_models(ctx).await
    }

    async fn stream_chat(
        &self,
        mut request: ProviderRequest,
        ctx: crate::adapter::AdapterContext,
        cancel: CancellationToken,
    ) -> Result<Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>, ProviderError> {
        // Phase 7 / M-WebSearch: refuse hosted tools on local-only mode and on
        // endpoints that cannot honor them. Local-only is enforced up-front;
        // endpoint mismatch is surfaced as a `SearchUnavailable` event so the
        // user sees "this endpoint can't host web search" instead of having
        // their intent silently dropped.
        let web_search_intent = request
            .web_search
            .as_ref()
            .map(|w| w.enabled)
            .unwrap_or(false);

        if web_search_intent {
            if ctx.local_only {
                return Err(ProviderError {
                    provider_code: Some("local_only_block".to_string()),
                    retryable: false,
                    message: "Web search is disabled while local-only mode is on."
                        .to_string(),
                });
            }
            if !endpoint_supports_hosted_search(ctx.base_url.as_deref()) {
                // Emit a `SearchUnavailable` event so the UI can show an
                // explicit state, then continue without the hosted tool. The
                // strip happens here rather than at the inner adapter so the
                // event ordering is deterministic.
                let request_id = request.request_id.clone();
                request.web_search = None;
                request.tool_definitions = std::mem::take(&mut request.tool_definitions)
                    .into_iter()
                    .filter(|t| !matches!(t.kind, Some(crate::schema::ToolKind::Hosted)))
                    .collect();

                let endpoint_msg = ctx.base_url.clone().unwrap_or_else(|| {
                    "<unset — falling back to local OpenAI-compatible default>".to_string()
                });
                let inner = self.0.clone();
                let inner_stream = inner.stream_chat(request, ctx, cancel).await?;
                let unavailable_event = ProviderEvent::SearchUnavailable {
                    request_id: request_id.clone(),
                    index: 0,
                    code: "endpoint_mismatch".to_string(),
                    message: format!(
                        "The configured OpenAI-compatible endpoint ({endpoint_msg}) does not host web search. Falling back to a no-search response."
                    ),
                };
                let prefix = stream! {
                    yield unavailable_event;
                };
                let chained = prefix.chain(inner_stream);
                return Ok(Box::pin(chained));
            }
        }

        self.0.stream_chat(request, ctx, cancel).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_detection_accepts_openai_host() {
        // Official OpenAI host — must allow hosted search.
        assert!(endpoint_supports_hosted_search(Some(
            "https://api.openai.com/v1"
        )));
        // Sub-paths don't matter; only the host is checked.
        assert!(endpoint_supports_hosted_search(Some(
            "https://api.openai.com/"
        )));
    }

    #[test]
    fn endpoint_detection_rejects_local_and_unknown_hosts() {
        // Local servers: cannot honor hosted-search.
        assert!(!endpoint_supports_hosted_search(Some(
            "http://localhost:8080/v1"
        )));
        assert!(!endpoint_supports_hosted_search(Some(
            "http://127.0.0.1:11434/v1"
        )));
        // Unknown hosts: cannot assume they honor hosted-search.
        assert!(!endpoint_supports_hosted_search(Some(
            "https://api.together.xyz/v1"
        )));
        assert!(!endpoint_supports_hosted_search(Some(
            "https://my-openai-proxy.example.com/v1"
        )));
        // Spoofing the host via userinfo or a different suffix is rejected.
        assert!(!endpoint_supports_hosted_search(Some(
            "https://attacker.com/api.openai.com"
        )));
        // Empty / unset / malformed URLs are rejected.
        assert!(!endpoint_supports_hosted_search(None));
        assert!(!endpoint_supports_hosted_search(Some("")));
        assert!(!endpoint_supports_hosted_search(Some("not a url")));
    }
}
