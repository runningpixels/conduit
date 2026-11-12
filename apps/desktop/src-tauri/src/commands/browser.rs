// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Emilio Olivares

//! Settings → Computer → Browser: which browsers are installed, and the
//! button that deletes the browser's own profile.

use provider_core::schema::AppError;
use tauri::State;

use crate::browser::{self, BrowserError, BrowserInfo};
use crate::db::repository::conversations::{self, ChatBrowser};
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

// ---------------------------------------------------------------------------
// The browser in chat
// ---------------------------------------------------------------------------

/// The browser tools a chat turn declares: reading, or with `act` also
/// clicking and typing. The renderer adds them when the chat's browser is on.
#[tauri::command]
pub fn browser_tool_definitions(act: bool) -> Vec<provider_core::schema::ToolDefinition> {
    chat_tool_definitions(act)
}

fn chat_tool_definitions(act: bool) -> Vec<provider_core::schema::ToolDefinition> {
    let mut markers = vec![browser::BROWSER_TOOL.to_string()];
    if act {
        markers.push(browser::BROWSER_ACT_TOOL.to_string());
    }
    browser::tools::offered(&markers, true).unwrap_or_default()
}

/// A chat's browser switches and site list (all off and empty when never set).
#[tauri::command]
pub async fn get_conversation_browser(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<ChatBrowser, AppError> {
    load_chat_browser(&state.db, &conversation_id).await
}

async fn load_chat_browser(
    pool: &sqlx::SqlitePool,
    conversation_id: &str,
) -> Result<ChatBrowser, AppError> {
    Ok(conversations::get(pool, conversation_id)
        .await
        .map_err(|e| AppError::from(e.to_string()))?
        .map(|c| conversations::chat_browser(&c))
        .unwrap_or_default())
}

/// Turn a chat's browser on or off, and its clicking and typing (only with
/// the browser on). The site list is kept. Turning the browser off closes
/// the chat's tab.
#[tauri::command]
pub async fn set_conversation_browser(
    state: State<'_, AppState>,
    stream_manager: State<'_, crate::stream_manager::StreamManager>,
    conversation_id: String,
    r#use: bool,
    act: bool,
) -> Result<ChatBrowser, AppError> {
    conversations::set_chat_browser(&state.db, &conversation_id, r#use, act)
        .await
        .map_err(|e| AppError::from(e.to_string()))?;
    if !r#use {
        stream_manager.chat_browsers().close(&conversation_id);
    }
    load_chat_browser(&state.db, &conversation_id).await
}

/// Replace a chat's browser site list. Each entry is a host (`example.com`),
/// `*.host`, or `*` for every site; anything else is refused with
/// `error.browser.badSite` and nothing is saved.
#[tauri::command]
pub async fn set_conversation_browser_sites(
    state: State<'_, AppState>,
    conversation_id: String,
    sites: Vec<String>,
) -> Result<ChatBrowser, AppError> {
    let sites = normalize_sites(&sites)?;
    conversations::set_chat_browser_sites(&state.db, &conversation_id, &sites)
        .await
        .map_err(|e| AppError::from(e.to_string()))?;
    load_chat_browser(&state.db, &conversation_id).await
}

/// The site list, cleaned and without repeats; the first bad entry refuses
/// the lot.
fn normalize_sites(sites: &[String]) -> Result<Vec<String>, AppError> {
    let mut out: Vec<String> = Vec::new();
    for site in sites {
        let clean = browser::rules::normalize_site(site)
            .map_err(|why| AppError::new("error.browser.badSite", why).with("site", site.trim()))?;
        if !out.contains(&clean) {
            out.push(clean);
        }
    }
    Ok(out)
}

/// Answer the browser card waiting on `tool_call_id`: Do it (`send`) or
/// Don't, and with Do it optionally `remember` = `"site"` (Always on this
/// site) or `"all"` (Allow on all sites), saved to the chat's site list.
/// `false` when no card waits there.
#[tauri::command]
pub fn answer_browser_action(
    stream_manager: State<'_, crate::stream_manager::StreamManager>,
    tool_call_id: String,
    send: bool,
    remember: Option<String>,
) -> bool {
    stream_manager.answer_browser_action(&tool_call_id, send, remember)
}

/// Answer the browser question waiting on `tool_call_id`: Continue
/// (`go_on`) or its declining choice. `false` when no question waits there.
#[tauri::command]
pub fn answer_browser_question(
    stream_manager: State<'_, crate::stream_manager::StreamManager>,
    tool_call_id: String,
    go_on: bool,
) -> bool {
    stream_manager.answer_browser_question(&tool_call_id, go_on)
}

#[cfg(test)]
mod chat_tests {
    use super::*;

    #[test]
    fn chat_tools_read_or_also_act() {
        let names = |act| -> Vec<String> {
            chat_tool_definitions(act)
                .into_iter()
                .map(|d| d.name)
                .collect()
        };
        let read = names(false);
        assert_eq!(read, vec!["open_page", "read_page"]);
        let act = names(true);
        assert!(act.contains(&"click".to_string()));
        assert!(act.contains(&"ask_to_sign_in".to_string()));
        assert!(act.iter().all(|n| browser::tools::is_browser_tool(n)));
    }

    #[test]
    fn sites_are_cleaned_and_bad_ones_refused() {
        let sites = ["GitHub.com", "*.example.org", "*", "github.com"].map(String::from);
        assert_eq!(
            normalize_sites(&sites).unwrap(),
            vec!["github.com", "*.example.org", "*"]
        );
        let bad = normalize_sites(&["github.com".into(), "https://evil.com/x".into()]).unwrap_err();
        assert_eq!(bad.code, "error.browser.badSite");
        assert_eq!(bad.params["site"], "https://evil.com/x");
        assert!(normalize_sites(&[]).unwrap().is_empty());
    }

    #[tokio::test]
    async fn chat_browser_reads_defaults_for_an_unknown_chat() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::MIGRATOR.run(&pool).await.unwrap();
        assert_eq!(
            load_chat_browser(&pool, "nope").await.unwrap(),
            ChatBrowser::default()
        );
        let conv = conversations::create(&pool, None).await.unwrap();
        conversations::set_chat_browser(&pool, &conv.id, true, false)
            .await
            .unwrap();
        let got = load_chat_browser(&pool, &conv.id).await.unwrap();
        assert!(got.use_browser && !got.act);
        assert_eq!(
            serde_json::to_value(&got).unwrap(),
            serde_json::json!({ "use": true, "act": false, "sites": [] })
        );
    }
}
