//! Vision / multimodal helpers for t0-1.
//!
//! Decides whether a model should receive image parts. Hydration (byte load +
//! base64) lives in the desktop crate — adapters only see already-hydrated
//! `MessagePartKind::Image` parts with base64 in `content`.
//!
//! The same goes for PDFs: [`model_accepts_pdf`] decides whether a PDF
//! attachment goes to the model as a document (`MessagePartKind::File`, base64
//! in `content`) or as text the desktop crate extracted locally.

use crate::schema::{MessagePartKind, MessageRole, ProviderRequest};

/// True when the provider/model reads a PDF sent as a document, so scanned
/// pages and charts reach it as the pages themselves rather than as whatever
/// text a local extractor could pull out.
///
/// Deliberately narrower than [`model_accepts_images`]: a wrong `true` here
/// fails the whole turn with a 400 (the provider rejects the document block),
/// while a wrong `false` only costs the model the page layout, because the
/// desktop crate then sends the extracted text instead. So only the providers
/// whose adapters encode a `File` part (Anthropic, OpenAI, Gemini, OpenRouter)
/// and only the model families documented to take PDFs are listed.
///
/// OpenRouter is always `false` here: whether one of its hundreds of models
/// takes files is only knowable from its own catalogue (see
/// [`listed_file_input`]), which the desktop crate keeps from the last model
/// listing and consults before falling back to this table.
pub fn model_accepts_pdf(provider_id: &str, model_id: &str) -> bool {
    let provider = provider_id.trim().to_ascii_lowercase();
    let model = model_id.trim().to_ascii_lowercase();
    // Gemini ids sometimes arrive as `models/gemini-…`.
    let model = model.strip_prefix("models/").unwrap_or(&model);

    match provider.as_str() {
        "anthropic" => anthropic_model_accepts_pdf(model),
        "openai" => openai_model_accepts_pdf(model),
        "gemini" => gemini_model_accepts_pdf(model),
        _ => false,
    }
}

/// Claude 3.5 onwards reads PDFs; Claude 3 (opus/sonnet/haiku), 2 and
/// instant do not. Every current family name (`claude-sonnet-4…`,
/// `claude-opus-4…`, `claude-haiku-4…`, and whatever comes next) does.
fn anthropic_model_accepts_pdf(model: &str) -> bool {
    let Some(rest) = model.strip_prefix("claude-") else {
        return false;
    };
    if rest.starts_with("instant") || rest.starts_with('2') || rest.starts_with('1') {
        return false;
    }
    if let Some(after_three) = rest.strip_prefix('3') {
        // `claude-3-5-sonnet`, `claude-3.5-sonnet`, `claude-3-7-sonnet`: yes.
        // `claude-3-opus`, `claude-3-haiku`: no.
        let minor = after_three.trim_start_matches(['-', '.']);
        return minor
            .chars()
            .next()
            .and_then(|c| c.to_digit(10))
            .is_some_and(|d| d >= 5);
    }
    true
}

/// GPT-4o, GPT-4.1, GPT-5 and the o3/o4 reasoning models take `file` input.
/// Their audio, realtime and speech variants do not.
fn openai_model_accepts_pdf(model: &str) -> bool {
    const NOT_DOCUMENT_MODELS: &[&str] = &["audio", "realtime", "transcribe", "tts"];
    if NOT_DOCUMENT_MODELS.iter().any(|n| model.contains(n)) {
        return false;
    }
    ["gpt-4o", "gpt-4.1", "gpt-5", "o3", "o4"]
        .iter()
        .any(|prefix| model.starts_with(prefix))
}

/// Gemini 1.5 onwards reads PDFs inline (`inlineData`); 1.0 and the
/// embedding models do not.
fn gemini_model_accepts_pdf(model: &str) -> bool {
    if model.contains("embedding") {
        return false;
    }
    let Some(rest) = model.strip_prefix("gemini-") else {
        return false;
    };
    if rest.starts_with("1.5") {
        return true;
    }
    rest.chars()
        .next()
        .and_then(|c| c.to_digit(10))
        .is_some_and(|major| major >= 2)
}

/// What an OpenRouter catalogue entry says about file input: `Some(true)` when
/// `architecture.input_modalities` lists `file`, `Some(false)` when the entry
/// lists its modalities without it, `None` when it says nothing (another
/// provider's listing, or an old OpenRouter shape).
pub fn listed_file_input(item: &serde_json::Value) -> Option<bool> {
    let modalities = item.pointer("/architecture/input_modalities")?.as_array()?;
    Some(modalities.iter().any(|m| m.as_str() == Some("file")))
}

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
    fn pdf_input_table() {
        let yes = [
            ("anthropic", "claude-3-5-sonnet-20241022"),
            ("anthropic", "claude-3.5-haiku"),
            ("anthropic", "claude-3-7-sonnet-latest"),
            ("anthropic", "claude-sonnet-4-20250514"),
            ("anthropic", "claude-opus-4-1"),
            ("anthropic", "claude-haiku-4-5"),
            ("Anthropic", " Claude-Sonnet-4-5 "),
            ("openai", "gpt-4o"),
            ("openai", "gpt-4o-mini"),
            ("openai", "gpt-4.1-nano"),
            ("openai", "gpt-5"),
            ("openai", "gpt-5-mini"),
            ("openai", "o3"),
            ("openai", "o4-mini"),
            ("gemini", "gemini-1.5-pro"),
            ("gemini", "gemini-2.0-flash"),
            ("gemini", "gemini-2.5-pro"),
            ("gemini", "gemini-3-pro-preview"),
            ("gemini", "models/gemini-2.5-flash"),
        ];
        for (provider, model) in yes {
            assert!(model_accepts_pdf(provider, model), "{provider}/{model}");
        }
        let no = [
            ("anthropic", "claude-3-opus-20240229"),
            ("anthropic", "claude-3-haiku-20240307"),
            ("anthropic", "claude-2.1"),
            ("anthropic", "claude-instant-1.2"),
            ("openai", "gpt-4-turbo"),
            ("openai", "gpt-3.5-turbo"),
            ("openai", "gpt-4o-audio-preview"),
            ("openai", "gpt-4o-realtime-preview"),
            ("openai", "o1-mini"),
            ("gemini", "gemini-1.0-pro"),
            ("gemini", "gemini-embedding-001"),
            // OpenRouter is decided by its catalogue, never by this table.
            ("openrouter", "anthropic/claude-sonnet-4"),
            ("openrouter", "openai/gpt-4o"),
            // Every other adapter never encodes a File part.
            ("openai_compat", "gpt-4o"),
            ("lmstudio", "qwen2.5-vl"),
            ("ollama", "llava"),
            ("deepseek", "deepseek-v4-flash"),
            ("xai", "grok-4"),
            ("mistral", "mistral-large"),
        ];
        for (provider, model) in no {
            assert!(!model_accepts_pdf(provider, model), "{provider}/{model}");
        }
    }

    #[test]
    fn listed_file_input_reads_openrouter_modalities() {
        let with_file = serde_json::json!({
            "id": "anthropic/claude-sonnet-4",
            "architecture": { "input_modalities": ["text", "image", "file"] }
        });
        let without_file = serde_json::json!({
            "id": "meta-llama/llama-3.3-70b-instruct",
            "architecture": { "input_modalities": ["text"] }
        });
        let silent = serde_json::json!({ "id": "gpt-4o" });
        assert_eq!(listed_file_input(&with_file), Some(true));
        assert_eq!(listed_file_input(&without_file), Some(false));
        assert_eq!(listed_file_input(&silent), None);
    }

    #[test]
    fn ollama_requires_visionish_id() {
        assert!(model_accepts_images("ollama", "llava"));
        assert!(model_accepts_images("ollama", "qwen2.5-vl"));
        assert!(!model_accepts_images("ollama", "llama3.2"));
    }
}
