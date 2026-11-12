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

/// The sites with saved cookies in the browser's own profile (sign-ins and
/// anything else the sites remember), sorted, without a leading dot or
/// `www.`. Empty when there is no profile or it can't be read.
#[tauri::command]
pub async fn browser_remembered_sites(state: State<'_, AppState>) -> Result<Vec<String>, AppError> {
    let profile = browser::launch::profile_dir(&state.paths.root);
    Ok(remembered_sites(&profile).await.unwrap_or_default())
}

/// Read the cookie hosts from a copy of the profile's cookie database (the
/// browser may hold the original open). Only `host_key` is read; cookie
/// values are encrypted and never touched.
async fn remembered_sites(profile: &std::path::Path) -> Option<Vec<String>> {
    use sqlx::sqlite::SqliteConnectOptions;
    use sqlx::ConnectOptions;

    let source = profile.join("Default").join("Network").join("Cookies");
    if !source.is_file() {
        return Some(Vec::new());
    }
    let dir = tempfile::tempdir().ok()?;
    let copy = dir.path().join("Cookies");
    std::fs::copy(&source, &copy).ok()?;
    let mut conn = SqliteConnectOptions::new()
        .filename(&copy)
        .read_only(true)
        .connect()
        .await
        .ok()?;
    let hosts: Vec<(String,)> = sqlx::query_as("SELECT DISTINCT host_key FROM cookies")
        .fetch_all(&mut conn)
        .await
        .ok()?;
    Some(tidy_hosts(hosts.into_iter().map(|(h,)| h)))
}

fn tidy_hosts(hosts: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = hosts
        .into_iter()
        .map(|h| {
            let h = h.trim_start_matches('.').to_lowercase();
            h.strip_prefix("www.").map(str::to_string).unwrap_or(h)
        })
        .filter(|h| !h.is_empty())
        .collect();
    out.sort();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn hosts_are_tidied() {
        let hosts = [
            ".github.com",
            "github.com",
            "www.example.com",
            ".Example.com",
            "",
        ]
        .map(String::from);
        assert_eq!(super::tidy_hosts(hosts), vec!["example.com", "github.com"]);
    }
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
