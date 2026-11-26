//! Apps in their own window, and installed on this computer (see
//! `app_windows` and `app_install`).

use provider_core::schema::{AppIconImage, AppInstallPlace, AppInstallStatus};
use tauri::{AppHandle, Emitter, State};

use crate::{
    app_install,
    app_windows::{self, AppChangeKind, OPEN_APP_IN_MAIN_EVENT},
    db::repository::apps,
    state::AppState,
    tray,
};

fn installer(app: &AppHandle) -> Result<app_install::Installer, String> {
    app_windows::installer(app)
        .ok_or_else(|| "Installing apps isn't supported on this system.".to_string())
}

/// Open the app in its own window (or bring that window forward).
#[tauri::command]
pub async fn open_app_window(app: AppHandle, id: String) -> Result<(), String> {
    app_windows::open_app_window(&app, &id).await
}

/// From an app window: show the main window and open the app there.
#[tauri::command]
pub async fn show_app_in_main(app: AppHandle, id: String) -> Result<(), String> {
    if !app_windows::is_valid_app_id(&id) {
        return Err("invalid app id".into());
    }
    tray::show_main_window(&app);
    app.emit_to("main", OPEN_APP_IN_MAIN_EVENT, id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_install_place() -> AppInstallPlace {
    app_install::place()
}

/// Install the app on this computer, or refresh an installed one (name,
/// icon, desktop shortcut). The name comes from the database, not the page.
#[tauri::command]
pub async fn install_app(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    icons: Vec<AppIconImage>,
    desktop_shortcut: bool,
) -> Result<AppInstallStatus, String> {
    let summary = apps::get_summary(&state.db, &state.encryption, &id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That app no longer exists.".to_string())?;
    let installer = installer(&app)?;
    let status = tauri::async_runtime::spawn_blocking(move || {
        installer
            .install(&summary.id, &summary.name, &icons, desktop_shortcut)
            .map(|_| installer.status(&summary.id))
    })
    .await
    .map_err(|e| e.to_string())??;
    app_windows::emit_app_changed(&app, &id, AppChangeKind::Installed);
    Ok(status)
}

/// Remove the app's launchers. The app itself stays.
#[tauri::command]
pub async fn uninstall_app(app: AppHandle, id: String) -> Result<AppInstallStatus, String> {
    let installer = installer(&app)?;
    let status = tauri::async_runtime::spawn_blocking(move || {
        installer.uninstall(&id).map(|_| installer.status(&id))
    })
    .await
    .map_err(|e| e.to_string())??;
    app_windows::emit_app_changed(&app, &status.app_id, AppChangeKind::Installed);
    Ok(status)
}

#[tauri::command]
pub fn app_install_status(app: AppHandle, id: String) -> AppInstallStatus {
    match app_windows::installer(&app) {
        Some(installer) => installer.status(&id),
        None => AppInstallStatus {
            app_id: id,
            installed: false,
            desktop_shortcut: false,
            place: AppInstallPlace::Unsupported,
        },
    }
}

/// The installed apps.
#[tauri::command]
pub fn list_app_installs(app: AppHandle) -> Vec<AppInstallStatus> {
    app_windows::installer(&app)
        .map(|i| i.list())
        .unwrap_or_default()
}

/// At start, off the main thread: repoint launchers at a moved executable
/// and forget installs of deleted apps or with every launcher removed.
pub fn verify_installs_at_boot(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let Some(installer) = app_windows::installer(&app) else {
            return;
        };
        let Some(state) = tauri::Manager::try_state::<AppState>(&app) else {
            return;
        };
        let ids = match apps::list(&state.db, &state.encryption).await {
            Ok(list) => list
                .into_iter()
                .map(|a| a.id)
                .collect::<std::collections::HashSet<_>>(),
            Err(error) => {
                tracing::warn!(%error, "could not list apps to check their launchers");
                return;
            }
        };
        let touched = tauri::async_runtime::spawn_blocking(move || {
            installer.verify_all(|id| ids.contains(id))
        })
        .await
        .unwrap_or_default();
        if !touched.is_empty() {
            tracing::info!(count = touched.len(), "repaired or removed app launchers");
        }
    });
}
