use crate::adapter::ProviderAdapter;
use crate::adapters::openai::OpenAiAdapter;
use async_trait::async_trait;

/// Default base URL for OpenAI-compatible local servers (e.g. llama.cpp, vLLM).
const COMPAT_DEFAULT_BASE: &str = "http://localhost:8080/v1";

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
    ) -> Result<(), crate::schema::ProviderError> {
        self.0.validate_credentials(ctx).await
    }

    async fn list_models(
        &self,
        ctx: &crate::adapter::AdapterContext,
    ) -> Result<Vec<crate::adapter::ModelInfo>, crate::schema::ProviderError> {
        self.0.list_models(ctx).await
    }

    async fn stream_chat(
        &self,
        request: crate::schema::ProviderRequest,
        ctx: crate::adapter::AdapterContext,
        cancel: tokio_util::sync::CancellationToken,
    ) -> Result<
        std::pin::Pin<Box<dyn futures::stream::Stream<Item = crate::schema::ProviderEvent> + Send>>,
        crate::schema::ProviderError,
    > {
        self.0.stream_chat(request, ctx, cancel).await
    }
}
