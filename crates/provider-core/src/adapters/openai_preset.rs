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

    pub fn xai() -> Self {
        Self(OpenAiAdapter::preset(
            "xai",
            "xAI",
            "https://api.x.ai/v1",
            false,
            false,
            &[],
            false,
            false,
        ))
    }

    pub fn zai() -> Self {
        Self(OpenAiAdapter::preset(
            "zai",
            "Z.ai",
            "https://api.z.ai/api/paas/v4",
            false,
            false,
            &[],
            false,
            false,
        ))
    }

    pub fn moonshot() -> Self {
        Self(OpenAiAdapter::preset(
            "moonshot",
            "Moonshot AI",
            "https://api.moonshot.ai/v1",
            false,
            false,
            &[],
            false,
            false,
        ))
    }

    pub fn qwen() -> Self {
        Self(OpenAiAdapter::preset(
            "qwen",
            "Qwen",
            "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            false,
            false,
            &[],
            false,
            false,
        ))
    }

    pub fn together() -> Self {
        Self(OpenAiAdapter::preset(
            "together",
            "Together AI",
            "https://api.together.xyz/v1",
            false,
            false,
            &[],
            false,
            false,
        ))
    }

    pub fn fireworks() -> Self {
        Self(OpenAiAdapter::preset(
            "fireworks",
            "Fireworks AI",
            "https://api.fireworks.ai/inference/v1",
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

    fn all_presets() -> Vec<OpenAiPresetAdapter> {
        vec![
            OpenAiPresetAdapter::openrouter(),
            OpenAiPresetAdapter::groq(),
            OpenAiPresetAdapter::deepseek(),
            OpenAiPresetAdapter::mistral(),
            OpenAiPresetAdapter::lmstudio(),
            OpenAiPresetAdapter::xai(),
            OpenAiPresetAdapter::zai(),
            OpenAiPresetAdapter::moonshot(),
            OpenAiPresetAdapter::qwen(),
            OpenAiPresetAdapter::together(),
            OpenAiPresetAdapter::fireworks(),
        ]
    }

    /// The base URL, locality and credential requirement are written twice —
    /// once in the constructor, once in the catalog descriptor the settings UI
    /// reads. The catalog parity tests only compare ids, so pin the rest here.
    #[test]
    fn every_preset_agrees_with_its_descriptor() {
        use crate::catalog::{descriptor, CredentialMode};

        for preset in all_presets() {
            let id = preset.id();
            let desc = descriptor(id).unwrap_or_else(|| panic!("no descriptor for {id}"));
            assert_eq!(
                desc.display_name,
                preset.display_name(),
                "{id}: display name"
            );
            assert_eq!(
                desc.default_base_url,
                Some(preset.0.default_base()),
                "{id}: default base URL"
            );
            assert_eq!(desc.is_local, preset.is_local(), "{id}: is_local");
            let optional = !matches!(desc.credential_mode, CredentialMode::Required);
            assert_eq!(
                optional,
                preset.0.optional_api_key(),
                "{id}: credential mode"
            );
        }
    }

    #[test]
    fn every_preset_is_registered() {
        let registered: Vec<&str> = crate::adapter::registry().iter().map(|a| a.id()).collect();
        for preset in all_presets() {
            assert!(
                registered.contains(&preset.id()),
                "{} is not in registry()",
                preset.id()
            );
        }
    }

    /// Tier A cloud presets: base URL field shown (D6), tier 2 (D3), key required.
    #[test]
    fn tier_a_presets_follow_the_expansion_plan() {
        use crate::catalog::{descriptor, CredentialMode};

        for id in ["xai", "zai", "moonshot", "qwen", "together", "fireworks"] {
            let desc = descriptor(id).unwrap_or_else(|| panic!("no descriptor for {id}"));
            assert_eq!(desc.tier, 2, "{id}: tier");
            assert!(
                desc.show_base_url_field,
                "{id}: base URL field must be shown"
            );
            assert!(!desc.is_local, "{id}: must not be local");
            assert!(
                matches!(desc.credential_mode, CredentialMode::Required),
                "{id}: key required"
            );
            let base = desc.default_base_url.expect("default base URL");
            assert!(base.starts_with("https://"), "{id}: base URL must be https");
            assert!(!base.ends_with('/'), "{id}: no trailing slash");
        }
    }
}
