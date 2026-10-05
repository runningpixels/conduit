//! Vision / multimodal helpers for t0-1.
//!
//! Decides whether a model should receive image parts. Hydration (byte load +
//! base64) lives in the desktop crate — adapters only see already-hydrated
//! `MessagePartKind::Image` parts with base64 in `content`.

use crate::schema::{MessagePartKind, MessageRole, ProviderRequest};

/// True when the active provider/model is expected to accept image inputs.
///
/// This is a coarse heuristic — `ModelInfo` has no vision flag yet. Prefer
/// skipping images over failing the whole turn when unsure for local models.
pub fn model_accepts_images(provider_id: &str, model_id: &str) -> bool {
    let provider = provider_id.trim().to_ascii_lowercase();
    let model = model_id.trim().to_ascii_lowercase();

    match provider.as_str() {
        "anthropic" | "openai" | "gemini" | "openrouter" | "opencode_zen" | "groq" | "mistral"
        | "lmstudio" | "openai_compat" | "xai" => true,
        // DeepSeek's API mixes vision and text-only models (`deepseek-v4-flash`
        // takes images, `deepseek-v4-pro` does not), so ask the bundled
        // models.dev snapshot. A model it does not know stays text-only.
        "deepseek" => {
            crate::pricing::snapshot_accepts_images(&provider, model_id.trim()).unwrap_or(false)
        }
        // Gateway presets (zai, moonshot, qwen, together, fireworks) deliberately
        // have no arm: their vision support is per-model, so they take the
        // heuristic below (provider-expansion plan, D8).
        "ollama" => ollama_model_accepts_images(&model),
        _ => {
            // Unknown providers: only forward when the model id looks multimodal.
            model_id_suggests_vision(&model)
        }
    }
}

/// Drop attachment, image and file parts from every user message, re-indexing
/// what remains. The desktop crate calls this for a model that
/// [`model_accepts_images`] calls text-only, so the provider never sees them.
pub fn strip_user_attachment_parts(request: &mut ProviderRequest) {
    for message in &mut request.messages {
        if message.role != MessageRole::User {
            continue;
        }
        message.parts.retain(|p| {
            !matches!(
                p.kind,
                MessagePartKind::AttachmentReference
                    | MessagePartKind::Image
                    | MessagePartKind::File
            )
        });
        // Re-index after retain.
        for (i, part) in message.parts.iter_mut().enumerate() {
            part.index = i as u32;
        }
    }
}

fn ollama_model_accepts_images(model: &str) -> bool {
    model_id_suggests_vision(model)
}

fn model_id_suggests_vision(model: &str) -> bool {
    const NEEDLES: &[&str] = &[
        "vision",
        "llava",
        "minicpm",
        "pixtral",
        "gpt-4o",
        "gpt-4.1",
        "claude-3",
        "claude-sonnet",
        "claude-opus",
        "claude-haiku",
        "gemini",
        "qwen2-vl",
        "qwen2.5-vl",
        "qwen3-vl",
        "qwen-vl",
    ];
    NEEDLES.iter().any(|n| model.contains(n))
        || model.contains("vl-")
        || model.ends_with("-vl")
        || model.contains("vl.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_and_openai_accept() {
        assert!(model_accepts_images("anthropic", "claude-sonnet-4"));
        assert!(model_accepts_images("openai", "gpt-4o-mini"));
        assert!(model_accepts_images("gemini", "gemini-2.0-flash"));
    }

    #[test]
    fn deepseek_follows_the_snapshot() {
        // models.dev: image input on the flash models, text only on pro.
        assert!(model_accepts_images("deepseek", "deepseek-v4-flash"));
        assert!(model_accepts_images("deepseek", "deepseek-flash"));
        assert!(model_accepts_images(
            "deepseek",
            "deepseek-v4-flash-vision-exp"
        ));
        assert!(!model_accepts_images("deepseek", "deepseek-v4-pro"));
        // Not in the snapshot: stays text-only rather than risking a 400.
        assert!(!model_accepts_images("deepseek", "deepseek-chat"));
        assert!(!model_accepts_images("deepseek", "deepseek-reasoner"));
    }

    #[test]
    fn xai_accepts() {
        assert!(model_accepts_images("xai", "grok-4"));
    }

    #[test]
    fn gateway_presets_use_the_model_heuristic() {
        for provider in ["zai", "moonshot", "qwen", "together", "fireworks"] {
            assert!(
                model_accepts_images(provider, "qwen2.5-vl-72b-instruct"),
                "{provider}"
            );
            assert!(
                !model_accepts_images(provider, "kimi-k2-instruct"),
                "{provider}"
            );
        }
    }

    #[test]
    fn ollama_requires_visionish_id() {
        assert!(model_accepts_images("ollama", "llava"));
        assert!(model_accepts_images("ollama", "qwen2.5-vl"));
        assert!(!model_accepts_images("ollama", "llama3.2"));
    }
}
