use crate::schema::{ProviderError, ProviderEvent, ProviderRequest};
use async_trait::async_trait;
use futures::stream::Stream;
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

pub use crate::schema::{ModelInfo, ProviderUsage};

#[derive(Debug, Clone)]
pub struct AdapterContext {
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    /// Shared HTTP client with connection pooling + timeouts (H3/H5).
    pub http: crate::transport::HttpClient,
    /// Phase 7 / M-WebSearch: whether `AppSettings.local_only` is on. Adapters
    /// must refuse to send hosted-search tools (and any other network-bearing
    /// hosted tool) when this is `true`. The desktop shell layers a
    /// provider-level check on top of this in `stream_manager.rs`.
    pub local_only: bool,
}

#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    /// Whether this adapter targets a locally-served endpoint (no cloud egress).
    /// Honored by `local_only` mode in the desktop shell to block cloud providers.
    /// Defaults to `false`; local servers (ollama, the openai_compat variant)
    /// override to `true`.
    fn is_local(&self) -> bool {
        false
    }
    async fn validate_credentials(&self, ctx: &AdapterContext) -> Result<(), ProviderError>;
    async fn list_models(&self, ctx: &AdapterContext) -> Result<Vec<ModelInfo>, ProviderError>;
    async fn stream_chat(
        &self,
        request: ProviderRequest,
        ctx: AdapterContext,
        cancel: CancellationToken,
    ) -> Result<Pin<Box<dyn Stream<Item = ProviderEvent> + Send>>, ProviderError>;
}

pub fn registry() -> Vec<Box<dyn ProviderAdapter>> {
    vec![
        Box::new(crate::adapters::anthropic::AnthropicAdapter),
        Box::new(crate::adapters::openai::OpenAiAdapter::official()),
        Box::new(crate::adapters::openai_compat::OpenAiCompatAdapter::default()),
        Box::new(crate::adapters::ollama::OllamaAdapter),
    ]
}

pub fn get_adapter(id: &str) -> Option<Box<dyn ProviderAdapter>> {
    registry().into_iter().find(|a| a.id() == id)
}

pub trait StreamParser: Send {
    fn parse_chunk(
        &mut self,
        request_id: &str,
        data: &str,
        index: &mut usize,
    ) -> Vec<ProviderEvent>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_only_classification_matches_provider_kind() {
        // M4: only locally-served adapters report is_local(). The desktop shell's
        // local_only gate relies on this to distinguish cloud from local providers.
        let registry = registry();
        let local_ids: Vec<&str> = registry
            .iter()
            .filter(|a| a.is_local())
            .map(|a| a.id())
            .collect();
        let cloud_ids: Vec<&str> = registry
            .iter()
            .filter(|a| !a.is_local())
            .map(|a| a.id())
            .collect();

        assert!(
            local_ids.contains(&"ollama"),
            "ollama must be local: {local_ids:?}"
        );
        assert!(
            local_ids.contains(&"openai_compat"),
            "openai_compat must be local: {local_ids:?}"
        );
        assert!(
            cloud_ids.contains(&"anthropic"),
            "anthropic must be cloud: {cloud_ids:?}"
        );
        assert!(
            cloud_ids.contains(&"openai"),
            "openai must be cloud: {cloud_ids:?}"
        );
    }
}
