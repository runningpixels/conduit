//! IPC for an app's Settings page: model slots, the daily cloud-token limit,
//! activity, the stored-data viewer and the data export. Every error is
//! `Err(String)` starting with a bridge error code and a colon (`invalid:`,
//! `unavailable:`), matching `page_storage` and `page_llm`.
//!
//! The bodies live in `*_impl` functions taking plain references, so tests can
//! drive them without a running Tauri app (`tauri::State` has no public
//! constructor) — the same split `commands::branding` uses.

use std::path::PathBuf;

use provider_core::schema::{
    AppActivityEntry, AppLlmSlot, AppModelChoice, AppSettingsView, PageStorageEntry,
};
use serde_json::{json, Map, Value};
use tauri::State;

use crate::{
    db::repository::{
        app_activity, app_inputs,
        app_settings::{
            self, DEFAULT_DAILY_TOKEN_CAP, MAX_DAILY_TOKEN_CAP, MAX_MODEL_CHARS,
            MIN_DAILY_TOKEN_CAP,
        },
        apps,
        artifact_network::Principal,
        page_storage,
    },
    page_llm::provider_configured,
    state::AppState,
    stream_manager::StreamManager,
    time::now_iso8601,
};

fn unavailable(err: impl std::fmt::Display) -> String {
    tracing::warn!(error = %err, "app settings: unavailable");
    "unavailable: Something went wrong.".to_string()
}

async fn require_app(state: &AppState, id: &str) -> Result<(), String> {
    if app_settings::app_exists(&state.db, id)
        .await
        .map_err(unavailable)?
    {
        Ok(())
    } else {
        Err("invalid: That app no longer exists.".to_string())
    }
}

// ── Settings view ────────────────────────────────────────────────────────────

#[doc(hidden)]
pub async fn get_app_settings_impl(state: &AppState, id: &str) -> Result<AppSettingsView, String> {
    require_app(state, id).await?;
    let stored = app_settings::get(&state.db, id)
        .await
        .map_err(unavailable)?;
    let usage = app_activity::usage_at(&state.db, id, chrono::Local::now())
        .await
        .map_err(unavailable)?;
    let cloud_tokens_today = app_activity::cloud_tokens_today(&state.db, id)
        .await
        .map_err(unavailable)?;
    Ok(AppSettingsView {
        slots: stored.slots,
        daily_token_cap: stored.daily_token_cap,
        default_daily_token_cap: DEFAULT_DAILY_TOKEN_CAP,
        cloud_tokens_today,
        usage,
    })
}

#[tauri::command]
pub async fn get_app_settings(
    state: State<'_, AppState>,
    id: String,
) -> Result<AppSettingsView, String> {
    get_app_settings_impl(&state, &id).await
}

/// Map a slot to a provider and model the user picked, or (`choice: None`)
/// back to following the fallback. The provider must be configured (see
/// [`provider_configured`]); the model must be 1–200 characters but need not
/// be one the provider lists.
#[doc(hidden)]
pub async fn set_app_model_slot_impl(
    state: &AppState,
    streams: &StreamManager,
    id: &str,
    slot: AppLlmSlot,
    choice: Option<AppModelChoice>,
) -> Result<AppSettingsView, String> {
    require_app(state, id).await?;
    let choice = match choice {
        None => None,
        Some(choice) => {
            let model = choice.model.trim().to_string();
            if model.is_empty() || model.chars().count() > MAX_MODEL_CHARS {
                return Err(format!(
                    "invalid: A model name must be 1 to {MAX_MODEL_CHARS} characters."
                ));
            }
            if !provider_configured(state, streams, &choice.provider_id) {
                return Err("invalid: That model provider isn't set up.".to_string());
            }
            Some(AppModelChoice {
                provider_id: choice.provider_id,
                model,
            })
        }
    };
    app_settings::set_slot(&state.db, id, slot, choice.as_ref())
        .await
        .map_err(unavailable)?;
    get_app_settings_impl(state, id).await
}

/// Ids of the providers a slot can be mapped to right now: the same check
/// `set_app_model_slot` applies, so the picker never offers one it would
/// refuse.
#[tauri::command]
pub fn list_configured_providers(
    state: State<'_, AppState>,
    stream_manager: State<'_, StreamManager>,
) -> Vec<String> {
    provider_core::list_descriptors()
        .iter()
        .map(|d| d.id.to_string())
        .filter(|id| provider_configured(&state, &stream_manager, id))
        .collect()
}

#[tauri::command]
pub async fn set_app_model_slot(
    state: State<'_, AppState>,
    stream_manager: State<'_, StreamManager>,
    id: String,
    slot: AppLlmSlot,
    choice: Option<AppModelChoice>,
) -> Result<AppSettingsView, String> {
    set_app_model_slot_impl(&state, &stream_manager, &id, slot, choice).await
}

/// Set the daily cloud-token limit (1,000–10,000,000), or `None` for the
/// default.
#[doc(hidden)]
pub async fn set_app_daily_token_cap_impl(
    state: &AppState,
    id: &str,
    cap: Option<u64>,
) -> Result<AppSettingsView, String> {
    require_app(state, id).await?;
    if let Some(cap) = cap {
        if !(MIN_DAILY_TOKEN_CAP..=MAX_DAILY_TOKEN_CAP).contains(&cap) {
            return Err(format!(
                "invalid: The daily limit must be between {MIN_DAILY_TOKEN_CAP} and {MAX_DAILY_TOKEN_CAP} tokens."
            ));
        }
    }
    app_settings::set_cap(&state.db, id, cap)
        .await
        .map_err(unavailable)?;
    get_app_settings_impl(state, id).await
}

#[tauri::command]
pub async fn set_app_daily_token_cap(
    state: State<'_, AppState>,
    id: String,
    cap: Option<u64>,
) -> Result<AppSettingsView, String> {
    set_app_daily_token_cap_impl(&state, &id, cap).await
}

// ── Activity ─────────────────────────────────────────────────────────────────

/// The app's last 7 days of activity, newest first; `limit` defaults to 200
/// and is capped at 1,000.
#[tauri::command]
pub async fn list_app_activity(
    state: State<'_, AppState>,
    id: String,
    limit: Option<u32>,
) -> Result<Vec<AppActivityEntry>, String> {
    app_activity::list(&state.db, &id, limit)
        .await
        .map_err(unavailable)
}

// ── Stored data ──────────────────────────────────────────────────────────────

/// Keys with their sizes and last change, sorted by key. Never values.
#[tauri::command]
pub async fn page_storage_entries(
    state: State<'_, AppState>,
    principal: String,
) -> Result<Vec<PageStorageEntry>, String> {
    let principal = Principal::parse(&principal).map_err(|e| format!("invalid: {e}"))?;
    page_storage::entries(&state.db, &principal)
        .await
        .map_err(|e| e.to_string())
}

/// `<app name>-data.json` with anything a file name can't hold replaced.
fn export_file_name(app_name: &str) -> String {
    let cleaned: String = app_name
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '-'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    let base = if cleaned.is_empty() { "app" } else { cleaned };
    format!("{base}-data.json")
}

/// The export document: the app's identity, when it was exported, its launch
/// inputs and every stored key's decrypted value.
async fn export_document(state: &AppState, id: &str) -> Result<(String, Value), String> {
    let manifest = apps::stored_manifest(&state.db, &state.encryption, id)
        .await
        .map_err(|_| "invalid: That app no longer exists.".to_string())?;
    let inputs = app_inputs::get_values(&state.db, &state.encryption, id, &manifest.inputs)
        .await
        .map_err(|e| e.to_string())?;
    let storage = page_storage::all_values(&state.db, &state.encryption, &Principal::app(id))
        .await
        .map_err(|e| e.to_string())?;
    let storage: Map<String, Value> = storage.into_iter().collect();
    let doc = json!({
        "app": { "id": id, "name": manifest.name, "version": manifest.version },
        "exportedAt": now_iso8601(),
        "inputs": inputs,
        "storage": storage,
    });
    Ok((manifest.name, doc))
}

/// Write the app's data to `picked`; `None` (the user cancelled) is success
/// with nothing written.
#[doc(hidden)]
pub async fn export_app_data_impl(
    state: &AppState,
    id: &str,
    picked: Option<PathBuf>,
) -> Result<Option<String>, String> {
    let Some(path) = picked else {
        return Ok(None);
    };
    let (_, doc) = export_document(state, id).await?;
    let text = serde_json::to_string_pretty(&doc).map_err(unavailable)?;
    std::fs::write(&path, text).map_err(|e| {
        tracing::warn!(error = %e, "app export: could not write file");
        "unavailable: The file couldn't be saved.".to_string()
    })?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

/// Show the native "save as" dialog, pre-filled `<app name>-data.json`, and
/// write the export there. `Ok(None)` means the user cancelled. The dialog is
/// opened from Rust, like the branding export, so the renderer needs no
/// dialog-plugin permission. `dialog_title` and `filter_name` are the
/// renderer's translated dialog chrome (optional; English defaults).
#[tauri::command]
pub async fn export_app_data_dialog(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
    dialog_title: Option<String>,
    filter_name: Option<String>,
) -> Result<Option<String>, String> {
    // Fail before showing a dialog for an app that is gone.
    let (name, _) = export_document(&state, &id).await?;
    let picked = pick_save_path(
        &app,
        dialog_title.as_deref().unwrap_or("Export app data"),
        filter_name.as_deref().unwrap_or("JSON"),
        &export_file_name(&name),
    )
    .await?;
    export_app_data_impl(&state, &id, picked).await
}

async fn pick_save_path(
    app: &tauri::AppHandle,
    title: &str,
    filter_name: &str,
    file_name: &str,
) -> Result<Option<PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter(filter_name, &["json"])
        .set_file_name(file_name)
        .set_title(title)
        .save_file(move |file_path| {
            let _ = tx.send(file_path);
        });
    let picked = rx
        .await
        .map_err(|_| "unavailable: The file dialog closed without a response.".to_string())?;
    picked
        .map(|file_path| {
            file_path
                .into_path()
                .map_err(|err| format!("unavailable: Couldn't use that file location: {err}"))
        })
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_file_names_are_safe() {
        assert_eq!(export_file_name("Weather"), "Weather-data.json");
        assert_eq!(export_file_name("a/b:c"), "a-b-c-data.json");
        assert_eq!(export_file_name("  .. "), "app-data.json");
    }
}
