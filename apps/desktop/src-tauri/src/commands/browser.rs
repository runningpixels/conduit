// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Settings → Computer → Browser: which browsers are installed, and the
//! button that deletes the browser's own profile.

use provider_core::schema::AppError;
use tauri::State;

use crate::browser::{self, BrowserError, BrowserInfo};
use crate::state::AppState;

/// The installed browsers agents can use, in the order they are preferred.
#[tauri::command]
pub fn list_browsers() -> Vec<BrowserInfo> {
    browser::detect::installed_now()
        .into_iter()
        .map(|(b, _)| b.into())
        .collect()
}

/// Delete the browser's profile folder (its sign-ins and cookies). Fails with
/// `error.browser.inUse` while the browser is running.
#[tauri::command]
pub async fn reset_browser_profile(state: State<'_, AppState>) -> Result<(), AppError> {
    let profile = browser::launch::profile_dir(&state.paths.root);
    browser::launch::host()
        .reset_profile(&profile)
        .await
        .map_err(|e| match e {
            browser::launch::LaunchError::InUse => BrowserError::InUse.to_app_error(),
            other => BrowserError::LaunchFailed(other.to_string()).to_app_error(),
        })
}
