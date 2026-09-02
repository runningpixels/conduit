//! Vision / multimodal helpers for t0-1.
//!
//! Decides whether a model should receive image parts. Hydration (byte load +
//! base64) lives in the desktop crate — adapters only see already-hydrated
//! `MessagePartKind::Image` parts with base64 in `content`.

/// True when the active provider/model is expected to accept image inputs.
///
/// This is a coarse heuristic — `ModelInfo` has no vision flag yet. Prefer
/// skipping images over failing the whole turn when unsure for local models.
pub fn model_accepts_images(provider_id: &str, model_id: &str) -> bool {
    let provider = provider_id.trim().to_ascii_lowercase();
    let model = model_id.trim().to_ascii_lowercase();

    match provider.as_str() {
        "anthropic" | "openai" | "gemini" | "openrouter" | "opencode_zen" | "groq" | "mistral"
        | "lmstudio" | "openai_compat" => true,
        "deepseek" => false,
        "ollama" => ollama_model_accepts_images(&model),
        _ => {
            // Unknown providers: only forward when the model id looks multimodal.
            model_id_suggests_vision(&model)
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
    fn deepseek_rejects() {
        assert!(!model_accepts_images("deepseek", "deepseek-chat"));
    }

    #[test]
    fn ollama_requires_visionish_id() {
        assert!(model_accepts_images("ollama", "llava"));
        assert!(model_accepts_images("ollama", "qwen2.5-vl"));
        assert!(!model_accepts_images("ollama", "llama3.2"));
    }
}
