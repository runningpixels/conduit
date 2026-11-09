// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Dictation commands: record the microphone, then send the recording to a
//! transcription provider with the user's own key and return the text for the
//! composer.
//!
//! The provider is the active one when it can transcribe, otherwise the first
//! of OpenAI, OpenRouter and Groq with a saved key. Local-only mode refuses,
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

/// Whether dictation can be used now, and through whom.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DictationStatus {
    /// The provider id the recording would go to.
    pub provider: Option<String>,
    /// Its display name, for "Your voice is sent to …".
    pub provider_name: Option<String>,
    /// Why dictation is unavailable: `localOnly` or `noProvider`.
    pub blocked: Option<String>,
    /// The longest recording kept, in seconds.
    pub max_seconds: u32,
}

fn status_for(local_only: bool, provider: Option<&'static str>) -> DictationStatus {
    let max_seconds = dictation::MAX_SECONDS;
    if local_only {
        return DictationStatus {
            provider: None,
            provider_name: None,
            blocked: Some("localOnly".into()),
            max_seconds,
        };
    }
    match provider {
        Some(id) => DictationStatus {
            provider: Some(id.to_string()),
            provider_name: provider_core::descriptor(id).map(|d| d.display_name.to_string()),
            blocked: None,
            max_seconds,
        },
        None => DictationStatus {
            provider: None,
            provider_name: None,
            blocked: Some("noProvider".into()),
            max_seconds,
        },
    }
}

fn current_status(state: &AppState) -> Result<DictationStatus, AppError> {
    let settings = state
        .settings()
        .map_err(|e| err("error.dictation.failed", e))?;
    let store = state.credential_store();
    let provider = provider_core::pick_transcription_provider(&settings.active_provider, |id| {
        store.has_provider_secret(id)
    });
    Ok(status_for(settings.local_only, provider))
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
    if status.blocked.as_deref() == Some("localOnly") {
        err(
            "error.dictation.localOnly",
            "Local-only mode is on, so your voice can’t be sent to be turned into text.",
        )
    } else {
        err(
            "error.dictation.noProvider",
            "Dictation needs an OpenAI, OpenRouter or Groq API key.",
        )
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

    #[test]
    fn local_only_blocks_even_with_a_provider() {
        let s = status_for(true, Some("openai"));
        assert_eq!(s.blocked.as_deref(), Some("localOnly"));
        assert_eq!(s.provider, None);
    }

    #[test]
    fn names_the_provider_or_says_none_can() {
        let s = status_for(false, Some("openrouter"));
        assert_eq!(s.provider.as_deref(), Some("openrouter"));
        assert_eq!(s.provider_name.as_deref(), Some("OpenRouter"));
        assert_eq!(s.blocked, None);
        assert_eq!(
            status_for(false, None).blocked.as_deref(),
            Some("noProvider")
        );
        assert_eq!(
            blocked_err(&status_for(false, None)).code,
            "error.dictation.noProvider"
        );
        assert_eq!(
            blocked_err(&status_for(true, None)).code,
            "error.dictation.localOnly"
        );
    }
}
