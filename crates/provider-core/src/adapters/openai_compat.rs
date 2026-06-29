use crate::adapter::ProviderAdapter;
use crate::adapters::openai::OpenAiAdapter;
use crate::schema::{ProviderError, ProviderEvent, ProviderRequest};
use async_trait::async_trait;
use futures::stream::Stream;
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

/// Default base URL for OpenAI-compatible local servers (e.g. llama.cpp, vLLM).
const COMPAT_DEFAULT_BASE: &str = "http://localhost:8080/v1";

/// Thin wrapper so `openai_compat` keeps a distinct registry id while delegating
/// to `OpenAiAdapter::compat`. Web-search endpoint handling lives in `openai.rs`.
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
        request: ProviderRequest,
        ctx: crate::adapter::AdapterContext,
        cancel: CancellationToken,
    ) -> Result<Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>, ProviderError> {
        self.0.stream_chat(request, ctx, cancel).await
    }
}

#[cfg(test)]
mod tests {
    use crate::adapters::openai::endpoint_supports_hosted_search;

    #[test]
    fn endpoint_detection_accepts_openai_host() {
        assert!(endpoint_supports_hosted_search(Some(
            "https://api.openai.com/v1"
        )));
        assert!(endpoint_supports_hosted_search(Some(
            "https://api.openai.com/"
        )));
    }

    #[test]
    fn endpoint_detection_rejects_local_and_unknown_hosts() {
        assert!(!endpoint_supports_hosted_search(Some(
            "http://localhost:8080/v1"
        )));
        assert!(!endpoint_supports_hosted_search(Some(
            "http://127.0.0.1:11434/v1"
        )));
        assert!(!endpoint_supports_hosted_search(Some(
            "https://api.together.xyz/v1"
        )));
        assert!(!endpoint_supports_hosted_search(Some(
            "https://my-openai-proxy.example.com/v1"
        )));
        assert!(!endpoint_supports_hosted_search(Some(
            "https://openrouter.ai/api/v1"
        )));
        assert!(!endpoint_supports_hosted_search(Some(
            "https://opencode.ai/zen/v1"
        )));
        assert!(!endpoint_supports_hosted_search(Some(
            "https://attacker.com/api.openai.com"
        )));
        assert!(!endpoint_supports_hosted_search(None));
        assert!(!endpoint_supports_hosted_search(Some("")));
        assert!(!endpoint_supports_hosted_search(Some("not a url")));
    }
}
