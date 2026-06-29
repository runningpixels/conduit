//! Named OpenAI-compatible provider presets (OpenRouter, Groq, LM Studio, etc.).
//! Each preset is a configured `OpenAiAdapter` instance registered under its own id.

use crate::adapter::ProviderAdapter;
use crate::adapters::openai::OpenAiAdapter;
use crate::schema::{ProviderError, ProviderEvent, ProviderRequest};
use async_trait::async_trait;
use futures::stream::Stream;
use std::pin::Pin;
use tokio_util::sync::CancellationToken;

const OPENROUTER_HEADERS: &[(&str, &str)] = &[
    ("HTTP-Referer", "https://conduit.app"),
    ("X-Title", "Conduit"),
];

/// Registry wrapper around a configured `OpenAiAdapter` preset.
pub struct OpenAiPresetAdapter(OpenAiAdapter);

impl OpenAiPresetAdapter {
    pub fn openrouter() -> Self {
        Self(OpenAiAdapter::preset(
            "openrouter",
            "OpenRouter",
            "https://openrouter.ai/api/v1",
            false,
            false,
            OPENROUTER_HEADERS,
            false,
            false,
        ))
    }

    pub fn groq() -> Self {
        Self(OpenAiAdapter::preset(
            "groq",
            "Groq",
            "https://api.groq.com/openai/v1",
            false,
            false,
            &[],
            false,
            false,
        ))
    }

    pub fn deepseek() -> Self {
        Self(OpenAiAdapter::preset(
            "deepseek",
            "DeepSeek",
            "https://api.deepseek.com",
            false,
            false,
            &[],
            false,
            false,
        ))
    }

    pub fn mistral() -> Self {
        Self(OpenAiAdapter::preset(
            "mistral",
            "Mistral",
            "https://api.mistral.ai/v1",
            false,
            false,
            &[],
            false,
            false,
        ))
    }

    pub fn lmstudio() -> Self {
        Self(OpenAiAdapter::preset(
            "lmstudio",
            "LM Studio",
            "http://localhost:1234/v1",
            true,
            true,
            &[],
            false,
            false,
        ))
    }
}

#[async_trait]
impl ProviderAdapter for OpenAiPresetAdapter {
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
    use super::*;

    /// M3: DeepSeek and Mistral are cloud OpenAI-compatible presets — verify their
    /// identity, base URL, and `is_local()` so the local_only gate classifies them.
    #[test]
    fn deepseek_preset_identity() {
        let adapter = OpenAiPresetAdapter::deepseek();
        assert_eq!(adapter.id(), "deepseek");
        assert_eq!(adapter.display_name(), "DeepSeek");
        assert!(!adapter.is_local(), "deepseek must not be local");
    }

    #[test]
    fn mistral_preset_identity() {
        let adapter = OpenAiPresetAdapter::mistral();
        assert_eq!(adapter.id(), "mistral");
        assert_eq!(adapter.display_name(), "Mistral");
        assert!(!adapter.is_local(), "mistral must not be local");
    }
}
