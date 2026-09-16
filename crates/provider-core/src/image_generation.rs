//! Outbound image-generation capability helpers for t0-8.
//!
//! Decides whether a model can be asked to *produce* an image, the mirror
//! image of `vision.rs`'s inbound "can this model *accept* one" question.
//! Kept as a separate module rather than appended to `vision.rs`, which is
//! documented as inbound-only (hydration lives in the desktop crate; adapters
//! only ever see already-hydrated `MessagePartKind::Image` parts there).

use base64::Engine;

use crate::error::fatal;
use crate::schema::{ImageGenerationResult, ProviderError};

/// Decoded image size accepted back from a provider (mirrors the desktop
/// crate's inbound `vision::VISION_FORWARD_MAX_BYTES` cap, applied here to
/// the outbound direction: a generated image the adapter decodes before it
/// is ever handed to a caller). An oversized response is rejected with a
/// clear error rather than stored.
pub const IMAGE_GENERATION_MAX_BYTES: usize = 20 * 1024 * 1024;

/// Decode a base64 image payload returned by a provider into raw bytes,
/// sniffing the real MIME type from the decoded bytes rather than trusting
/// the provider's claimed type (same approach as the desktop crate's
/// `vision::resolve_image_mime`, via the `infer` crate) — falling back to
/// `claimed_mime` only when sniffing can't identify the bytes. Enforces
/// [`IMAGE_GENERATION_MAX_BYTES`] and never returns `Ok` with empty bytes.
pub(crate) fn decode_generated_image(
    provider: &str,
    b64: &str,
    claimed_mime: Option<&str>,
) -> Result<ImageGenerationResult, ProviderError> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| {
            fatal(format!(
                "{provider} returned an unparsable base64 image: {e}"
            ))
        })?;

    if bytes.is_empty() {
        return Err(fatal(format!("{provider} returned an empty image payload")));
    }

    if bytes.len() > IMAGE_GENERATION_MAX_BYTES {
        return Err(fatal(format!(
            "{provider} image ({} bytes) exceeds the {} byte outbound size cap",
            bytes.len(),
            IMAGE_GENERATION_MAX_BYTES
        )));
    }

    let mime_type = infer::get(&bytes)
        .map(|kind| kind.mime_type().to_string())
        .or_else(|| claimed_mime.map(str::to_string))
        .unwrap_or_else(|| "application/octet-stream".to_string());

    Ok(ImageGenerationResult { bytes, mime_type })
}

/// Renders the top-level keys of a JSON value for a diagnostic error
/// message. Used when a provider's image-generation response is missing an
/// expected field, so a future shape change is diagnosable from the error
/// text alone rather than producing empty bytes silently.
pub(crate) fn top_level_keys(value: &serde_json::Value) -> String {
    match value.as_object() {
        Some(map) if !map.is_empty() => map.keys().cloned().collect::<Vec<_>>().join(", "),
        Some(_) => "(empty object)".to_string(),
        None => format!("(not a JSON object: {})", value_kind(value)),
    }
}

fn value_kind(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "bool",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// True when `model_id` on `provider_id` is expected to generate images.
///
/// This is a hand-written allowlist, not a `ModelInfo` field, for the same
/// reason `vision.rs` uses one (see `model_accepts_images`): `ModelInfo` has
/// no capability field yet, and adding one to solve this single case would be
/// a larger change than the MVP needs. Deliberately narrow — only the two
/// providers with a real image-generation endpoint (M2: OpenAI, Gemini), and
/// only model ids that look like an image model, since most models those
/// providers list are chat-only.
pub fn model_generates_images(provider_id: &str, model_id: &str) -> bool {
    let provider = provider_id.trim().to_ascii_lowercase();
    let model = model_id.trim().to_ascii_lowercase();

    match provider.as_str() {
        "openai" => model.contains("dall-e") || model.contains("gpt-image"),
        "gemini" => model.contains("imagen"),
        _ => false,
    }
}

/// The per-provider default image model to use when a caller wants to
/// generate an image but has no image-specific model selected (t0-8 M3).
///
/// This exists because the turn's active *chat* model
/// (`AppSettings.active_model`) is never an image model — `gpt-image-2.5-*`
/// and `imagen-4.0-*` don't share an id namespace with `gpt-4o`/`gemini-2.0-*`
/// — so gating image generation on `model_generates_images(provider,
/// active_model)` would be false for every real user and the feature would
/// never fire. Gating on the provider and picking a hardcoded default model
/// is the deliberate M3 tradeoff instead.
///
/// The ids below are verified-current as of 2026-09. Providers rename and
/// retire image models without much notice (this crate already tracks that
/// churn loosely via [`model_generates_images`]'s substring allowlist); this
/// function's ids will need revisiting when that happens. That periodic
/// upkeep cost is accepted as the known price of the "pick a default"
/// approach — the alternative (a user-facing image-model picker) is out of
/// scope for the MVP.
pub fn default_image_model(provider_id: &str) -> Option<&'static str> {
    match provider_id.trim().to_ascii_lowercase().as_str() {
        "openai" => Some("gpt-image-2.5-sunburst"),
        "gemini" => Some("imagen-4.0-generate-001"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_image_models_are_generative() {
        assert!(model_generates_images("openai", "dall-e-3"));
        assert!(model_generates_images("openai", "gpt-image-1"));
    }

    #[test]
    fn gemini_imagen_models_are_generative() {
        assert!(model_generates_images("gemini", "imagen-3.0-generate-002"));
    }

    #[test]
    fn chat_models_on_the_same_providers_are_not_generative() {
        assert!(!model_generates_images("openai", "gpt-4o-mini"));
        assert!(!model_generates_images("gemini", "gemini-2.0-flash"));
    }

    #[test]
    fn unknown_providers_never_generate() {
        assert!(!model_generates_images("anthropic", "claude-sonnet-4"));
        assert!(!model_generates_images("ollama", "dall-e-3"));
        assert!(!model_generates_images("made-up-provider", "imagen-3"));
    }

    #[test]
    fn matching_is_case_insensitive() {
        assert!(model_generates_images("OpenAI", "DALL-E-3"));
        assert!(model_generates_images("GEMINI", "IMAGEN-3.0-GENERATE-002"));
        assert!(model_generates_images("openai", "GPT-IMAGE-1"));
    }

    /// 1x1 PNG, base64-encoded (same bytes the desktop crate's `vision.rs`
    /// sniff test uses).
    const ONE_PIXEL_PNG_B64: &str =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQI12P4z8AAAAADAAEABf7U7wAAAABJRU5ErkJggg==";

    #[test]
    fn decode_generated_image_sniffs_png_over_a_wrong_claim() {
        let result = decode_generated_image(
            "openai",
            ONE_PIXEL_PNG_B64,
            Some("application/octet-stream"),
        )
        .expect("decode should succeed");
        assert_eq!(result.mime_type, "image/png");
        assert_eq!(result.bytes.len(), 70);
    }

    #[test]
    fn decode_generated_image_falls_back_to_claimed_mime_when_sniff_fails() {
        // Not a real image, so `infer` cannot classify it — the claimed MIME
        // should be used instead.
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"not an image");
        let result = decode_generated_image("gemini", &b64, Some("image/png"))
            .expect("decode should succeed via fallback");
        assert_eq!(result.mime_type, "image/png");
    }

    #[test]
    fn decode_generated_image_rejects_malformed_base64() {
        let err = decode_generated_image("openai", "not-valid-base64!!!", Some("image/png"))
            .expect_err("malformed base64 should error");
        assert!(!err.retryable);
    }

    #[test]
    fn decode_generated_image_rejects_empty_payload() {
        let err = decode_generated_image("openai", "", Some("image/png"))
            .expect_err("empty payload should error");
        assert!(err.message.contains("empty"));
    }

    #[test]
    fn decode_generated_image_enforces_size_cap() {
        use base64::Engine;
        let oversized = vec![0u8; IMAGE_GENERATION_MAX_BYTES + 1];
        let b64 = base64::engine::general_purpose::STANDARD.encode(&oversized);
        let err = decode_generated_image("gemini", &b64, Some("image/png"))
            .expect_err("oversized payload should be rejected");
        assert!(err.message.contains("exceeds"));
    }

    #[test]
    fn top_level_keys_lists_object_fields() {
        let value = serde_json::json!({ "predictions": [], "error": "x" });
        let keys = top_level_keys(&value);
        assert!(keys.contains("predictions"));
        assert!(keys.contains("error"));
    }

    #[test]
    fn top_level_keys_describes_non_object_values() {
        let value = serde_json::json!([1, 2, 3]);
        assert!(top_level_keys(&value).contains("array"));
    }

    #[test]
    fn default_image_model_covers_the_two_generative_providers() {
        assert_eq!(
            default_image_model("openai"),
            Some("gpt-image-2.5-sunburst")
        );
        assert_eq!(
            default_image_model("gemini"),
            Some("imagen-4.0-generate-001")
        );
    }

    #[test]
    fn default_image_model_is_none_elsewhere() {
        assert_eq!(default_image_model("anthropic"), None);
        assert_eq!(default_image_model("ollama"), None);
        assert_eq!(default_image_model("made-up-provider"), None);
    }

    #[test]
    fn default_image_model_matching_is_case_insensitive() {
        assert_eq!(
            default_image_model("OpenAI"),
            Some("gpt-image-2.5-sunburst")
        );
        assert_eq!(
            default_image_model("GEMINI"),
            Some("imagen-4.0-generate-001")
        );
    }

    /// The two tables must not contradict each other: whatever
    /// `default_image_model` would actually send as `model_id`,
    /// `model_generates_images` must agree is a real image model for that
    /// provider. If a future edit renames one default without updating the
    /// other, this is the test that catches it.
    #[test]
    fn default_image_model_is_always_recognized_by_model_generates_images() {
        for provider in [
            "openai",
            "gemini",
            "anthropic",
            "ollama",
            "made-up-provider",
        ] {
            if let Some(model) = default_image_model(provider) {
                assert!(
                    model_generates_images(provider, model),
                    "default_image_model({provider}) = {model:?} but \
                     model_generates_images({provider}, {model:?}) is false"
                );
            }
        }
    }
}
