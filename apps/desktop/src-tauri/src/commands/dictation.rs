// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Dictation commands: record the microphone, then send the recording to a
//! transcription provider with the user's own key and return the text for the
//! composer.
//!
//! The provider is the one chosen in Settings → Voice. Left on automatic, it
//! is the active provider when that can transcribe, otherwise the first of
//! OpenAI, OpenRouter and Groq with a saved key. Local-only mode refuses,
//! since the recording would leave the machine.

use std::sync::Mutex;

use provider_core::schema::AppError;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::dictation::{self, RecordError, Recorder};
use crate::state::AppState;
use crate::stream_manager::StreamManager;

/// Event carrying the input level, 0..1, while recording.
pub const LEVEL_EVENT: &str = "dictation-level";
/// Event sent once when a recording reaches its length limit.
pub const FULL_EVENT: &str = "dictation-full";

/// The one recording in progress. One microphone, one composer.
static RECORDING: Mutex<Option<Recorder>> = Mutex::new(None);

fn err(code: &str, fallback: impl Into<String>) -> AppError {
    AppError::new(code, fallback)
}

/// A provider dictation can use, for the choice in Settings → Voice.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DictationProviderOption {
    pub id: String,
    pub name: String,
    /// Whether a key for it is saved.
    pub has_key: bool,
    /// The transcription model it is sent to.
    pub model: String,
}

/// Whether dictation can be used now, and through whom.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    /// The provider id the recording would go to.
    pub provider: Option<String>,
    /// Its display name, for "Your voice is sent to …".
    pub provider_name: Option<String>,
    /// Why dictation is unavailable: `localOnly`, `noProvider` (automatic,
    /// and no provider that can transcribe has a key) or `noKey` (the chosen
    /// provider has no key).
    pub blocked: Option<String>,
    /// The longest recording kept, in seconds.
    pub max_seconds: u32,
    /// The provider chosen in Settings; None is automatic.
    pub chosen: Option<String>,
    /// Every provider that can transcribe, in fallback order.
    pub options: Vec<DictationProviderOption>,
}

fn display_name(id: &str) -> String {
    provider_core::descriptor(id)
        .map(|d| d.display_name.to_string())
        .unwrap_or_else(|| id.to_string())
}

fn status_for(
    local_only: bool,
    chosen: Option<&str>,
    active_provider: &str,
    has_key: impl Fn(&str) -> bool,
) -> DictationStatus {
    let options = provider_core::transcription::TRANSCRIPTION_PROVIDERS
        .iter()
        .map(|id| DictationProviderOption {
            id: id.to_string(),
            name: display_name(id),
            has_key: has_key(id),
            model: provider_core::default_transcription_model(id)
                .unwrap_or_default()
                .to_string(),
        })
        .collect();
    // A choice that is no longer a transcribing provider reads as automatic.
    let chosen = chosen.and_then(|id| {
        provider_core::transcription::TRANSCRIPTION_PROVIDERS
            .iter()
            .copied()
            .find(|p| *p == id)
    });
    let (provider, blocked) = if local_only {
        (None, Some("localOnly"))
    } else if let Some(id) = chosen {
        if has_key(id) {
            (Some(id), None)
        } else {
            (None, Some("noKey"))
        }
    } else {
        match provider_core::pick_transcription_provider(active_provider, &has_key) {
            Some(id) => (Some(id), None),
            None => (None, Some("noProvider")),
        }
    };
    DictationStatus {
        provider: provider.map(str::to_string),
        provider_name: provider.map(display_name),
        blocked: blocked.map(str::to_string),
        max_seconds: dictation::MAX_SECONDS,
        chosen: chosen.map(str::to_string),
        options,
    }
}

fn current_status(state: &AppState) -> Result<DictationStatus, AppError> {
    let settings = state
        .settings()
        .map_err(|e| err("error.dictation.failed", e))?;
    let store = state.credential_store();
    Ok(status_for(
        settings.local_only,
        settings.dictation_provider.as_deref(),
        &settings.active_provider,
        |id| store.has_provider_secret(id),
    ))
}

#[tauri::command]
pub async fn dictation_status(state: State<'_, AppState>) -> Result<DictationStatus, AppError> {
    current_status(&state)
}

fn record_err(e: RecordError) -> AppError {
    match e {
        RecordError::NoMicrophone => err(
            "error.dictation.noMicrophone",
            "No microphone was found. Connect one, or check that it’s turned on.",
        ),
        RecordError::Device(message) => err(
            "error.dictation.microphone",
            format!("The microphone couldn’t be opened: {message}"),
        )
        .with("message", message),
        RecordError::NothingHeard => err(
            "error.dictation.nothingHeard",
            "Nothing was heard. Check the microphone, and that this app is allowed to use it, then try again.",
        ),
    }
}

/// Starts recording. A recording already running is discarded first.
#[tauri::command]
pub async fn dictation_start(app: AppHandle, state: State<'_, AppState>) -> Result<(), AppError> {
    let status = current_status(&state)?;
    if status.blocked.is_some() {
        return Err(blocked_err(&status));
    }
    if let Ok(mut current) = RECORDING.lock() {
        current.take();
    }
    let level_app = app.clone();
    let full_app = app.clone();
    let recorder = tauri::async_runtime::spawn_blocking(move || {
        Recorder::start(
            move |level| {
                let _ = level_app.emit(LEVEL_EVENT, level);
            },
            move || {
                let _ = full_app.emit(FULL_EVENT, ());
            },
        )
    })
    .await
    .map_err(|e| err("error.dictation.microphone", e.to_string()))?
    .map_err(record_err)?;
    if let Ok(mut current) = RECORDING.lock() {
        *current = Some(recorder);
    }
    Ok(())
}

fn blocked_err(status: &DictationStatus) -> AppError {
    match status.blocked.as_deref() {
        Some("localOnly") => err(
            "error.dictation.localOnly",
            "Local-only mode is on, so your voice can’t be sent to be turned into text.",
        ),
        Some("noKey") => {
            let provider = status
                .chosen
                .as_deref()
                .map(display_name)
                .unwrap_or_default();
            err(
                "error.dictation.noKey",
                format!("Dictation is set to use {provider}, which has no saved API key."),
            )
            .with("provider", provider)
        }
        _ => err(
            "error.dictation.noProvider",
            "Dictation needs an OpenAI, OpenRouter or Groq API key.",
        ),
    }
}

/// Discards the recording in progress, if any.
#[tauri::command]
pub async fn dictation_cancel() -> Result<(), AppError> {
    let taken = RECORDING.lock().ok().and_then(|mut r| r.take());
    if let Some(recorder) = taken {
        let _ = tauri::async_runtime::spawn_blocking(move || drop(recorder)).await;
    }
    Ok(())
}

/// Stops recording and returns what was said, as text.
#[tauri::command]
pub async fn dictation_stop(state: State<'_, AppState>) -> Result<String, AppError> {
    let recorder = RECORDING
        .lock()
        .ok()
        .and_then(|mut r| r.take())
        .ok_or_else(|| err("error.dictation.notRecording", "Nothing is being recorded."))?;
    let samples = tauri::async_runtime::spawn_blocking(move || recorder.finish())
        .await
        .map_err(|e| err("error.dictation.microphone", e.to_string()))?;
    if !dictation::worth_sending(&samples) {
        return Err(record_err(RecordError::NothingHeard));
    }

    // Checked again here, not just at start: settings can change while the
    // user is talking, and this is the point the audio would leave.
    let status = current_status(&state)?;
    let Some(provider_id) = status.provider.clone() else {
        return Err(blocked_err(&status));
    };
    let model_id = provider_core::default_transcription_model(&provider_id)
        .ok_or_else(|| blocked_err(&status))?;
    let adapter = provider_core::get_adapter(&provider_id).ok_or_else(|| blocked_err(&status))?;
    let ctx = StreamManager::build_adapter_context(&state, &provider_id)
        .map_err(|e| err("error.dictation.failed", e).with("provider", provider_name(&status)))?;

    let request = provider_core::TranscriptionRequest {
        model_id: model_id.to_string(),
        audio: dictation::wav_bytes(&samples, dictation::TARGET_RATE),
        format: "wav",
        language: None,
    };
    adapter.transcribe_audio(request, &ctx).await.map_err(|e| {
        tracing::warn!(provider = %provider_id, "dictation transcription failed: {}", e.message);
        let message = readable(&e.message);
        err(
            "error.dictation.failed",
            format!(
                "{} couldn’t turn the recording into text: {message}",
                provider_name(&status)
            ),
        )
        .with("provider", provider_name(&status))
        .with("message", message)
    })
}

/// The provider's own sentence out of an error body, which is usually JSON
/// such as `{"error": {"message": "You have no credits remaining…"}}`.
fn readable(raw: &str) -> String {
    let from_json = serde_json::from_str::<serde_json::Value>(raw.trim())
        .ok()
        .and_then(|v| {
            let message = v
                .pointer("/error/message")
                .or_else(|| v.get("error"))
                .or_else(|| v.get("message"))
                .or_else(|| v.get("detail"))?;
            message.as_str().map(str::to_string)
        });
    let text = from_json.unwrap_or_else(|| raw.trim().to_string());
    let mut short: String = text.chars().take(300).collect();
    if short.len() < text.len() {
        short.push('…');
    }
    short
}

fn provider_name(status: &DictationStatus) -> String {
    status
        .provider_name
        .clone()
        .or_else(|| status.provider.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Live check, billed (a fraction of a cent per provider): sends the WAV at
    /// `DICTATION_LAB_WAV` to every transcribing provider with a saved key.
    /// `cargo test -p conduit-desktop --lib live_transcription -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "billed network call with the user's saved keys"]
    async fn live_transcription() {
        let path = std::env::var("DICTATION_LAB_WAV").expect("DICTATION_LAB_WAV");
        let audio = std::fs::read(path).expect("read wav");
        let store = crate::credentials::CredentialStore::default_service();
        let mut tried = 0;
        for id in provider_core::transcription::TRANSCRIPTION_PROVIDERS {
            if !store.has_provider_secret(id) {
                println!("{id}: no key");
                continue;
            }
            tried += 1;
            let ctx = provider_core::AdapterContext {
                api_key: Some(store.get_secret(id).expect("key")),
                base_url: None,
                http: provider_core::transport::HttpClient::new(),
                local_only: false,
            };
            let adapter = provider_core::get_adapter(id).expect("adapter");
            let request = provider_core::TranscriptionRequest {
                model_id: provider_core::default_transcription_model(id)
                    .unwrap()
                    .to_string(),
                audio: audio.clone(),
                format: "wav",
                language: None,
            };
            let started = std::time::Instant::now();
            match adapter.transcribe_audio(request, &ctx).await {
                Ok(text) => println!("{id} ({:?}): {text}", started.elapsed()),
                Err(e) => println!("{id} FAILED: {}", e.message),
            }
        }
        assert!(tried > 0, "no transcribing provider has a saved key");
    }

    #[test]
    fn provider_errors_read_as_a_sentence() {
        assert_eq!(
            readable(r#"{"error":{"message":"You have no credits remaining.","type":"x"}}"#),
            "You have no credits remaining."
        );
        assert_eq!(
            readable(r#"{"error":"model not found"}"#),
            "model not found"
        );
        assert_eq!(readable("HTTP 502"), "HTTP 502");
        assert!(readable(&"x".repeat(400)).ends_with('…'));
    }

    fn keys(ids: &'static [&'static str]) -> impl Fn(&str) -> bool {
        move |id| ids.contains(&id)
    }

    #[test]
    fn local_only_blocks_even_with_a_provider() {
        let s = status_for(true, Some("openai"), "openai", keys(&["openai"]));
        assert_eq!(s.blocked.as_deref(), Some("localOnly"));
        assert_eq!(s.provider, None);
        assert_eq!(blocked_err(&s).code, "error.dictation.localOnly");
    }

    #[test]
    fn automatic_names_the_provider_or_says_none_can() {
        let s = status_for(false, None, "anthropic", keys(&["openrouter"]));
        assert_eq!(s.provider.as_deref(), Some("openrouter"));
        assert_eq!(s.provider_name.as_deref(), Some("OpenRouter"));
        assert_eq!(s.blocked, None);
        assert_eq!(s.chosen, None);
        let none = status_for(false, None, "anthropic", keys(&[]));
        assert_eq!(none.blocked.as_deref(), Some("noProvider"));
        assert_eq!(blocked_err(&none).code, "error.dictation.noProvider");
    }

    #[test]
    fn a_chosen_provider_is_used_and_never_swapped_for_another() {
        let s = status_for(false, Some("groq"), "openai", keys(&["openai", "groq"]));
        assert_eq!(s.provider.as_deref(), Some("groq"));
        assert_eq!(s.chosen.as_deref(), Some("groq"));
        // Chosen without a key: blocked, not quietly sent to OpenAI instead.
        let s = status_for(false, Some("groq"), "openai", keys(&["openai"]));
        assert_eq!(s.provider, None);
        assert_eq!(s.blocked.as_deref(), Some("noKey"));
        let e = blocked_err(&s);
        assert_eq!(e.code, "error.dictation.noKey");
        assert!(e.fallback.contains("Groq"), "{}", e.fallback);
    }

    #[test]
    fn lists_every_option_with_its_key_and_model() {
        let s = status_for(false, None, "anthropic", keys(&["groq"]));
        let ids: Vec<_> = s.options.iter().map(|o| o.id.as_str()).collect();
        assert_eq!(ids, ["openai", "openrouter", "groq"]);
        assert!(s.options[2].has_key);
        assert_eq!(s.options[2].model, "whisper-large-v3-turbo");
        assert!(!s.options[0].has_key);
    }
}
