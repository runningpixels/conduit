//! Tray + start-at-sign-in IPC. Close-to-tray itself is an ordinary setting
//! (`update_settings` with `close_to_tray`), which adds or removes the icon.

use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

use crate::tray::{self, TrayState};
use provider_core::schema::AppError;

/// Translated tray menu labels from the renderer (Rust has no locale).
#[tauri::command]
pub fn set_tray_labels(
    app: AppHandle,
    tray_state: State<'_, TrayState>,
    open: String,
    quit: String,
    tooltip: String,
) -> Result<(), AppError> {
    {
        let mut labels = tray_state
            .labels
            .lock()
            .map_err(|_| AppError::from("tray labels lock poisoned".to_string()))?;
        *labels = labels.merged(&open, &quit, &tooltip);
    }
    tray::refresh_labels(&app)
        .map_err(|e| AppError::from(format!("failed to update the tray: {e}")))
}

#[tauri::command]
pub fn get_start_at_login(app: AppHandle) -> Result<bool, AppError> {
    app.autolaunch()
        .is_enabled()
        .map_err(|e| AppError::from(format!("couldn't read the start-at-sign-in setting: {e}")))
}

/// Start at sign-in, hidden in the tray. Only offered with close-to-tray on:
/// a sign-in start with no tray would just open a window every morning.
#[tauri::command]
pub fn set_start_at_login(app: AppHandle, enabled: bool) -> Result<bool, AppError> {
    let launcher = app.autolaunch();
    let result = if enabled {
        launcher.enable()
    } else {
        launcher.disable()
    };
    result.map_err(|e| {
        AppError::from(format!("couldn't change the start-at-sign-in setting: {e}"))
    })?;
    launcher
        .is_enabled()
        .map_err(|e| AppError::from(format!("couldn't read the start-at-sign-in setting: {e}")))
}
