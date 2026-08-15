//! Settings, credentials, diagnostics, and app-path commands.

use crate::{
    credentials::CredentialSummary,
    diagnostics::{self, DiagnosticsExport},
    state::{AppSettings, AppState, SettingsPatch},
};
use provider_core::schema::CredentialRequest;
use serde::{Deserialize, Serialize};
use tauri::State;

// ---------------------------------------------------------------------------
// App paths
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPathsPayload {
    pub root: String,
    pub settings_file: String,
    pub database: String,
    pub attachments: String,
    pub artifacts: String,
    pub logs: String,
    pub diagnostics: String,
    pub updates: String,
    pub streams: String,
}

#[tauri::command]
pub fn get_app_paths(state: State<'_, AppState>) -> Result<AppPathsPayload, String> {
    let paths = &state.paths;
    Ok(AppPathsPayload {
        root: paths.root.to_string_lossy().to_string(),
        settings_file: paths.settings_file.to_string_lossy().to_string(),
        database: paths.database.to_string_lossy().to_string(),
        attachments: paths.attachments.to_string_lossy().to_string(),
        artifacts: paths.artifacts.to_string_lossy().to_string(),
        logs: paths.logs.to_string_lossy().to_string(),
        diagnostics: paths.diagnostics.to_string_lossy().to_string(),
        updates: paths.updates.to_string_lossy().to_string(),
        streams: paths.streams.to_string_lossy().to_string(),
    })
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    state.settings()
}

#[tauri::command]
pub fn update_settings(
    state: State<'_, AppState>,
    patch: SettingsPatch,
) -> Result<AppSettings, String> {
    state.update_settings(patch)
}

// ---------------------------------------------------------------------------
// Onboarding state
// ---------------------------------------------------------------------------

/// Phase 6 M6.4: serializable view of the migration-recovery info.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationRecoveryInfo {
    pub backup_path: String,
    pub error: String,
}

/// Phase 6 M6.4: first-run onboarding state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingState {
    pub onboarding_completed: bool,
    pub has_provider_credential: bool,
    pub migration_recovery: Option<MigrationRecoveryInfo>,
}

#[tauri::command]
pub fn get_onboarding_state(state: State<'_, AppState>) -> Result<OnboardingState, String> {
    let settings = state.settings()?;
    Ok(OnboardingState {
        onboarding_completed: settings.onboarding_completed,
        has_provider_credential: state.has_any_provider_credential(),
        migration_recovery: state
            .migration_recovery
            .as_ref()
            .map(|r| MigrationRecoveryInfo {
                backup_path: r.backup_path.display().to_string(),
                error: r.error.clone(),
            }),
    })
}

// ---------------------------------------------------------------------------
// Provider credentials
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn save_provider_credential(
    state: State<'_, AppState>,
    request: CredentialRequest,
) -> Result<CredentialSummary, String> {
    let store = state.credential_store();
    let summary = store.save_provider_secret(&request.provider_id, &request.secret)?;
    Ok(summary)
}

#[tauri::command]
pub fn load_provider_credential_reference(
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<CredentialSummary, String> {
    let store = state.credential_store();
    Ok(CredentialSummary {
        provider_id: provider_id.clone(),
        credential_ref: store.reference(&provider_id),
        // Reports whether a secret is *available*, not which backend holds it;
        // the reference above is what names the backend.
        stored_in_keychain: store.has_provider_secret(&provider_id),
    })
}

// ---------------------------------------------------------------------------
// Provider descriptors
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDescriptorPayload {
    pub id: String,
    pub display_name: String,
    pub default_base_url: Option<String>,
    pub credential_mode: String,
    pub is_local: bool,
    pub show_base_url_field: bool,
    pub tier: u8,
    pub description: Option<String>,
}

fn credential_mode_label(mode: provider_core::CredentialMode) -> &'static str {
    match mode {
        provider_core::CredentialMode::None => "none",
        provider_core::CredentialMode::Optional => "optional",
        provider_core::CredentialMode::Required => "required",
    }
}

#[tauri::command]
pub fn list_provider_descriptors() -> Vec<ProviderDescriptorPayload> {
    provider_core::list_descriptors()
        .iter()
        .map(|d| ProviderDescriptorPayload {
            id: d.id.to_string(),
            display_name: d.display_name.to_string(),
            default_base_url: d.default_base_url.map(str::to_string),
            credential_mode: credential_mode_label(d.credential_mode).to_string(),
            is_local: d.is_local,
            show_base_url_field: d.show_base_url_field,
            tier: d.tier,
            description: d.description.map(str::to_string),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn export_diagnostics(state: State<'_, AppState>) -> Result<DiagnosticsExport, String> {
    let settings = state.settings()?;
    diagnostics::export(&state.paths, &settings)
}

/// Phase 6 M6.5: read the one-time diagnostics-export disclosure flag.
#[tauri::command]
pub fn get_diagnostics_disclosure_acknowledged(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.diagnostics_disclosure_acknowledged())
}

/// Phase 6 M6.5: persist the one-time diagnostics-export disclosure acknowledgement.
#[tauri::command]
pub fn acknowledge_diagnostics_disclosure(state: State<'_, AppState>) -> Result<(), String> {
    state.acknowledge_diagnostics_disclosure()
}

// ---------------------------------------------------------------------------
// Reveal in file manager
// ---------------------------------------------------------------------------

/// Reveal the app's **exports** directory in the OS file manager.
#[tauri::command]
#[allow(deprecated)]
pub fn reveal_path(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    app.shell()
        .open(state.paths.exports.to_string_lossy(), None)
        .map_err(|e| e.to_string())
}

/// Reveal the artifacts workspace directory in the OS file manager.
#[tauri::command]
#[allow(deprecated)]
pub fn reveal_artifacts_dir(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let dir = &state.paths.artifacts;
    if !dir.exists() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    app.shell()
        .open(dir.to_string_lossy(), None)
        .map_err(|e| e.to_string())
}

/// Open a validated http(s) URL in the system browser.
///
/// ADR-008 exception: this is the only command that accepts a renderer-supplied
/// string for `shell().open`, and only after `validate_external_open_url`. The
/// capability still omits `shell:allow-open` — the renderer cannot call
/// `plugin:shell|open` directly.
#[tauri::command]
#[allow(deprecated)]
pub fn open_external_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;
    let validated = crate::validation::validate_external_open_url(&url)
        .ok_or_else(|| "Invalid or unsupported external URL".to_string())?;
    app.shell()
        .open(validated, None)
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Database reset
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetDatabaseResult {
    pub backup_path: String,
}

/// Phase 7 / M-WebSearch: reset the local database.
#[tauri::command]
pub fn reset_local_database(state: State<'_, AppState>) -> Result<ResetDatabaseResult, String> {
    let db_path = &state.paths.database;
    if !db_path.exists() {
        return Err("No local database found to reset.".to_string());
    }
    let unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let backup_path = std::path::PathBuf::from(format!("{}.reset-{unix}.bak", db_path.display()));
    std::fs::copy(db_path, &backup_path).map_err(|e| format!("Failed to back up database: {e}"))?;
    // Delete the live DB and WAL/SHM sidecars so the next startup creates a
    // clean store. Silently ignore missing sidecars.
    let _ = std::fs::remove_file(db_path);
    let _ = std::fs::remove_file(format!("{}-wal", db_path.display()));
    let _ = std::fs::remove_file(format!("{}-shm", db_path.display()));
    Ok(ResetDatabaseResult {
        backup_path: backup_path.to_string_lossy().to_string(),
    })
}
