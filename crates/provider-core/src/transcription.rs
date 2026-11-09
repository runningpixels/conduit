//! Speech to text: which providers can turn a recording into text, with which
//! model, and how their answer is read.
//!
//! Dictation in the composer sends the user's recording to one of these with
//! the user's own key. The three providers here share OpenAI's
//! `POST {base}/audio/transcriptions` multipart shape (OpenRouter accepts it as
//! an OpenAI-compatible alternative to its base64 JSON form), so one adapter
//! method serves all of them.
//!
//! The model ids were checked on 2026-11-09: OpenAI's pricing page lists
//! `gpt-4o-mini-transcribe` at $0.003 a minute, OpenRouter's
//! `/models?output_modalities=transcription` lists
//! `openai/gpt-4o-mini-transcribe`, and Groq serves `whisper-large-v3-turbo`.
//! Like the embedding defaults, these need revisiting when a provider retires
//! one.

use crate::error::fatal;
use crate::image_generation::top_level_keys;
use crate::schema::ProviderError;
use serde_json::Value;

/// Providers that can transcribe, in the order dictation falls back through
/// them when the active provider can't.
pub const TRANSCRIPTION_PROVIDERS: &[&str] = &["openai", "openrouter", "groq"];

/// The model dictation uses on `provider_id`, or None when the provider has no
/// transcription endpoint.
pub fn default_transcription_model(provider_id: &str) -> Option<&'static str> {
    match provider_id.trim().to_ascii_lowercase().as_str() {
        "openai" => Some("gpt-4o-mini-transcribe"),
        "openrouter" => Some("openai/gpt-4o-mini-transcribe"),
        "groq" => Some("whisper-large-v3-turbo"),
        _ => None,
    }
}

/// The provider dictation should use: the active one when it can transcribe,
/// otherwise the first transcribing provider the user has a key for.
pub fn pick_transcription_provider(
    active_provider: &str,
    has_key: impl Fn(&str) -> bool,
) -> Option<&'static str> {
    let active = TRANSCRIPTION_PROVIDERS
        .iter()
        .copied()
        .find(|id| *id == active_provider && has_key(id));
    active.or_else(|| {
        TRANSCRIPTION_PROVIDERS
            .iter()
            .copied()
            .find(|id| has_key(id))
    })
}

/// A recording to turn into text.
#[derive(Debug, Clone)]
pub struct TranscriptionRequest {
    pub model_id: String,
    /// The audio file's bytes.
    pub audio: Vec<u8>,
    /// File extension of `audio`, such as `wav`.
    pub format: &'static str,
    /// ISO-639-1 hint; None lets the model detect the language.
    pub language: Option<String>,
}

/// Reads `{"text": "..."}`, the answer every OpenAI-style transcription
/// endpoint gives for the default `json` response format.
pub(crate) fn parse_transcription_response(
    provider: &str,
    value: &Value,
) -> Result<String, ProviderError> {
    value
        .get("text")
        .and_then(Value::as_str)
        .map(|text| text.trim().to_string())
        .ok_or_else(|| {
            fatal(format!(
                "{provider} transcription response had no text (top-level keys: {})",
                top_level_keys(value)
            ))
        })
}

/// The MIME type sent for an audio file extension.
pub(crate) fn audio_mime(format: &str) -> &'static str {
    match format {
        "wav" => "audio/wav",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "webm" => "audio/webm",
        "flac" => "audio/flac",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_listed_provider_has_a_model() {
        for id in TRANSCRIPTION_PROVIDERS {
            assert!(default_transcription_model(id).is_some(), "{id}");
        }
        assert_eq!(default_transcription_model("anthropic"), None);
        assert_eq!(
            default_transcription_model(" OpenAI "),
            Some("gpt-4o-mini-transcribe")
        );
    }

    #[test]
    fn picks_the_active_provider_then_the_first_with_a_key() {
        let keys = |list: &'static [&'static str]| move |id: &str| list.contains(&id);
        assert_eq!(
            pick_transcription_provider("groq", keys(&["openai", "groq"])),
            Some("groq")
        );
        assert_eq!(
            pick_transcription_provider("anthropic", keys(&["anthropic", "openrouter", "groq"])),
            Some("openrouter")
        );
        // Active but without a key: fall back.
        assert_eq!(
            pick_transcription_provider("openai", keys(&["groq"])),
            Some("groq")
        );
        assert_eq!(
            pick_transcription_provider("anthropic", keys(&["anthropic"])),
            None
        );
    }

    #[test]
    fn reads_the_text_and_names_a_bad_answer() {
        assert_eq!(
            parse_transcription_response("openai", &json!({"text": " Hello there. "})).unwrap(),
            "Hello there."
        );
        let err = parse_transcription_response("groq", &json!({"error": "x"})).unwrap_err();
        assert!(err.message.contains("groq") && err.message.contains("error"));
    }
}
