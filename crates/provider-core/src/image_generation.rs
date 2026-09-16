//! Outbound image-generation capability helpers for t0-8.
//!
//! Decides whether a model can be asked to *produce* an image, the mirror
//! image of `vision.rs`'s inbound "can this model *accept* one" question.
//! Kept as a separate module rather than appended to `vision.rs`, which is
//! documented as inbound-only (hydration lives in the desktop crate; adapters
//! only ever see already-hydrated `MessagePartKind::Image` parts there).

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
}
