//! Named OpenAI-compatible provider presets (OpenRouter, Groq, LM Studio, etc.).
//! Each preset is a configured `OpenAiAdapter` instance registered under its own id.

use crate::adapter::ProviderAdapter;
use crate::adapters::openai::OpenAiAdapter;
use crate::error::fatal;
use crate::image_generation::{decode_generated_image, top_level_keys};
use crate::schema::{
    ImageGenerationRequest, ImageGenerationResult, ProviderError, ProviderEvent, ProviderRequest,
};
use crate::transport::post_json;
use async_trait::async_trait;
use futures::stream::Stream;
use serde_json::{json, Value};
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

    /// t0-8: only `openrouter` actually has an image-generation endpoint —
    /// verified live against `GET /api/v1/images/models` (2026-09), which
    /// lists per-vendor models like `openai/gpt-image-2.5-sunburst` and
    /// `google/gemini-3.1-flash-image` behind OpenRouter's own dedicated
    /// `POST /api/v1/images` router. This is a *different* endpoint from
    /// OpenAI's `/images/generations` (which `OpenAiAdapter::generate_image`
    /// calls) — different path, and the response carries an optional
    /// `media_type` per image instead of always being PNG — so this can't
    /// just delegate to `self.0.generate_image`. Every other preset (Groq,
    /// DeepSeek, Mistral, ...) has no such endpoint and keeps the trait's
    /// default "unsupported" error.
    async fn generate_image(
        &self,
        request: ImageGenerationRequest,
        ctx: &crate::adapter::AdapterContext,
    ) -> Result<ImageGenerationResult, ProviderError> {
        if self.id() != "openrouter" {
            return Err(fatal(format!(
                "{} does not support image generation",
                self.id()
            )));
        }

        // Reuses the inner `OpenAiAdapter`'s auth/base-url resolution
        // (`request_headers`/`base_url`, bumped to `pub(crate)` for this)
        // rather than duplicating it, so OpenRouter's image requests carry
        // the exact same Bearer token + `HTTP-Referer`/`X-Title` headers its
        // chat requests already do.
        let headers = self.0.request_headers(ctx)?;
        let mut body = json!({
            "model": request.model_id,
            "prompt": request.prompt,
        });
        if let Some(size) = request.size.as_deref().filter(|s| !s.trim().is_empty()) {
            // OpenRouter's `size` is documented as a convenience shorthand
            // accepting either a tier ("2K") or explicit pixels
            // ("2048x2048") — the same free-form string this tool already
            // accepts, so it's passed straight through.
            body["size"] = json!(size);
        }

        let url = format!("{}/images", crate::adapters::openai::base_url(&self.0, ctx));
        let response = post_json(&ctx.http, &url, headers, body, CancellationToken::new()).await?;
        parse_openrouter_image_response(&response)
    }
}

/// Parses `POST /api/v1/images`'s response: `{ data: [{ b64_json,
/// media_type? }], ... }`. Mirrors `openai::parse_image_response` and
/// `gemini::parse_image_response`'s shape (an explicit-keys check with a
/// diagnostic error naming what *was* present, not a silent empty result),
/// but reads OpenRouter's own field names — `media_type` is optional per the
/// spec ("may be omitted if the format could not be determined"), so a
/// missing one falls through to `decode_generated_image`'s own byte-sniffing
/// rather than assuming PNG the way OpenAI's parser does (OpenRouter fans
/// out to many vendors with different default output formats).
fn parse_openrouter_image_response(value: &Value) -> Result<ImageGenerationResult, ProviderError> {
    let entry = value.pointer("/data/0").ok_or_else(|| {
        fatal(format!(
            "openrouter image-generation response had no data[0] entry (top-level keys: {})",
            top_level_keys(value)
        ))
    })?;

    let Some(b64) = entry.get("b64_json").and_then(|v| v.as_str()) else {
        return Err(fatal(format!(
            "openrouter image-generation response data[0] had no b64_json field (keys: {})",
            top_level_keys(entry)
        )));
    };
    let claimed_mime = entry.get("media_type").and_then(|v| v.as_str());

    decode_generated_image("openrouter", b64, claimed_mime)
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

    /// 1x1 PNG, base64-encoded (same fixture the other adapters' image tests use).
    const ONE_PIXEL_PNG_B64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAADAAEABf7U7wAAAABJRU5ErkJggg==";

    #[test]
    fn parse_openrouter_image_response_decodes_b64_json_and_sniffs_png() {
        let value = serde_json::json!({
            "created": 1_748_372_400_i64,
            "data": [{ "b64_json": ONE_PIXEL_PNG_B64 }],
        });
        let result = parse_openrouter_image_response(&value).expect("decode should succeed");
        assert_eq!(result.mime_type, "image/png");
        assert_eq!(result.bytes.len(), 70);
    }

    #[test]
    fn parse_openrouter_image_response_prefers_the_claimed_media_type() {
        // `media_type` is explicit in OpenRouter's response (unlike OpenAI's,
        // which never says) — a wrong claim should still lose to sniffing,
        // same as every other provider's decode path.
        let value = serde_json::json!({
            "data": [{ "b64_json": ONE_PIXEL_PNG_B64, "media_type": "application/octet-stream" }],
        });
        let result = parse_openrouter_image_response(&value).expect("decode should succeed");
        assert_eq!(result.mime_type, "image/png");
    }

    #[test]
    fn parse_openrouter_image_response_reports_unexpected_shape() {
        let value = serde_json::json!({ "error": { "message": "invalid_request" } });
        let err =
            parse_openrouter_image_response(&value).expect_err("missing data[0] should error");
        assert!(
            err.message.contains("error"),
            "expected the error to name the actual top-level keys: {}",
            err.message
        );
    }

    #[test]
    fn parse_openrouter_image_response_reports_missing_b64_json() {
        let value = serde_json::json!({ "data": [{ "media_type": "image/png" }] });
        let err =
            parse_openrouter_image_response(&value).expect_err("missing b64_json should error");
        assert!(
            err.message.contains("media_type"),
            "expected the error to name the actual keys present: {}",
            err.message
        );
    }

    #[tokio::test]
    async fn generate_image_is_unsupported_on_every_preset_except_openrouter() {
        let ctx = crate::adapter::AdapterContext {
            api_key: Some("test-key".to_string()),
            base_url: None,
            http: crate::transport::HttpClient::new(),
            local_only: false,
        };
        let request = ImageGenerationRequest {
            prompt: "a red circle".to_string(),
            size: None,
            model_id: "some/model".to_string(),
        };
        for preset in all_presets() {
            if preset.id() == "openrouter" {
                continue;
            }
            let err = preset
                .generate_image(request.clone(), &ctx)
                .await
                .expect_err("only openrouter supports generate_image");
            assert!(
                err.message.contains("does not support image generation"),
                "{}: {}",
                preset.id(),
                err.message
            );
        }
    }

    /// Manual QA helper (t0-8 M3 follow-up): a real, non-mocked call to
    /// OpenRouter's dedicated `/images` router. Mirrors
    /// `openai::tests::openai_live_generate_image`,
    /// `gemini::tests::gemini_live_generate_image` and
    /// `opencode_zen::tests::zen_live_validate_and_list_models` — `#[ignore]`d
    /// so `cargo test` never spends real money or needs network by default.
    ///
    /// Run with: `OPENROUTER_API_KEY=... cargo test -p provider-core openrouter_live_generate_image -- --ignored`
    #[tokio::test]
    #[ignore = "requires OPENROUTER_API_KEY and network"]
    async fn openrouter_live_generate_image() {
        let key = std::env::var("OPENROUTER_API_KEY").expect("OPENROUTER_API_KEY must be set");
        let model_id = std::env::var("OPENROUTER_IMAGE_MODEL").unwrap_or_else(|_| {
            crate::image_generation::default_image_model("openrouter")
                .expect("openrouter has a default image model")
                .to_string()
        });

        let adapter = OpenAiPresetAdapter::openrouter();
        let ctx = crate::adapter::AdapterContext {
            api_key: Some(key),
            base_url: None,
            http: crate::transport::HttpClient::new(),
            local_only: false,
        };
        let request = ImageGenerationRequest {
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
