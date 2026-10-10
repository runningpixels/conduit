//! IPC for serving HTML artifacts from their own origin (see
//! `crate::artifact_frames`), and for the real origins of pages with full web
//! access (see `crate::page_server`).

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::{
    artifact_frames::{ArtifactFrames, PageDoc},
    artifact_network::{self, FULL_WEB_ACCESS},
    commands::artifact_network::{full_web_access_for_every_page, principal_exists},
    db::repository::artifact_network::{self as grants, Principal},
    page_server::{self, PageServer, CLEAR_SEGMENT},
    state::AppState,
};

/// Where a frame loads its document from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServedFrame {
    /// Released with `drop_artifact_frame` when the frame goes away.
    pub token: String,
    /// For a page with full web access: its URL on the page server, at the
    /// page's own origin. `None`: the frame loads `token` from the scheme.
    pub url: Option<String>,
}

/// Store an assembled artifact document; returns the token its iframe loads.
/// `full_access` marks a document rendered with full web access (ADR-007): the
/// guard proxy lets loads through only while one is stored. With `principal`
/// too, the document is served from that page's own origin on the page server
/// (when it runs), and the renderer adds `allow-same-origin` for that URL only.
#[tauri::command]
pub fn put_artifact_frame(
    app: AppHandle,
    frames: State<'_, ArtifactFrames>,
    state: State<'_, AppState>,
    html: String,
    full_access: Option<bool>,
    principal: Option<String>,
) -> Result<ServedFrame, String> {
    let full_access = full_access == Some(true);
    let server = app.try_state::<PageServer>();
    let (Some(principal), Some(server), true) = (principal, server, full_access) else {
        return Ok(ServedFrame {
            token: frames.put_with(html, full_access)?,
            url: None,
        });
    };
    let key = Principal::parse(&principal)?.key();
    let page_id = server.page_id(&key);
    let allowlist = state
        .settings()
        .map(|s| s.artifact_remote_allowlist)
        .unwrap_or_default();
    let csp = page_server::full_access_csp(&allowlist, &server.config.app_origins);
    let token = frames.put_page(
        html,
        PageDoc {
            page_id: page_id.clone(),
            csp,
        },
    )?;
    server.remember(&key);
    Ok(ServedFrame {
        url: Some(format!("{}/{token}", server.origin(&page_id))),
        token,
    })
}

/// Release a document once its iframe no longer shows it.
#[tauri::command]
pub fn drop_artifact_frame(frames: State<'_, ArtifactFrames>, token: String) {
    frames.drop_token(&token);
}

/// The one-shot URL that clears a page's origin when loaded in a frame.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageClear {
    /// Released with `drop_artifact_frame` (it is also used up on load).
    pub token: String,
    pub url: String,
    /// The page's origin: the clear page's messages come from it.
    pub origin: String,
}

/// Mint the "clear site data" URL for `principal`'s origin. `None` when the
/// page server isn't running (no page has an origin then).
#[tauri::command]
pub fn mint_page_clear(
    app: AppHandle,
    frames: State<'_, ArtifactFrames>,
    principal: String,
) -> Result<Option<PageClear>, String> {
    let Some(server) = app.try_state::<PageServer>() else {
        return Ok(None);
    };
    let key = Principal::parse(&principal)?.key();
    let page_id = server.page_id(&key);
    let token = frames.mint_clear(&page_id)?;
    let origin = server.origin(&page_id);
    Ok(Some(PageClear {
        url: format!("{origin}/{token}/{CLEAR_SEGMENT}"),
        token,
        origin,
    }))
}

/// A page that has, or had, its own origin.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageOrigin {
    pub principal: String,
    /// Whether its artifact or app still exists.
    pub exists: bool,
    /// Whether it holds a full-web-access grant (remembered or for this
    /// session).
    pub granted: bool,
    /// Whether it has full web access now (`granted`, or the Settings switch
    /// for every page), whether or not pages can connect.
    pub full_access: bool,
}

/// Every page that was given an origin and not cleared since, plus every page
/// holding a remembered full-web-access grant.
#[tauri::command]
pub async fn list_page_origins(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<PageOrigin>, String> {
    let mut keys: std::collections::BTreeSet<String> = app
        .try_state::<PageServer>()
        .map(|server| server.principals())
        .unwrap_or_default()
        .into_iter()
        .collect();
    let all = grants::list(&state.db, None)
        .await
        .map_err(|e| e.to_string())?;
    keys.extend(
        all.iter()
            .filter(|g| g.host == FULL_WEB_ACCESS)
            .map(|g| g.principal.clone()),
    );
    let every_page = full_web_access_for_every_page(&state)?;
    let mut out = Vec::with_capacity(keys.len());
    for key in keys {
        let Ok(principal) = Principal::parse(&key) else {
            continue;
        };
        let granted = all
            .iter()
            .any(|g| g.principal == key && g.host == FULL_WEB_ACCESS)
            || artifact_network::session_hosts(&key)
                .iter()
                .any(|h| h == FULL_WEB_ACCESS);
        out.push(PageOrigin {
            exists: principal_exists(&state, &principal).await?,
            full_access: every_page || granted,
            granted,
            principal: key,
        });
    }
    Ok(out)
}

/// Stop listing `principal` among the pages with an origin (its data was
/// cleared). It is listed again the next time it is shown with full access.
#[tauri::command]
pub fn forget_page_origin(app: AppHandle, principal: String) -> Result<(), String> {
    let key = Principal::parse(&principal)?.key();
    if let Some(server) = app.try_state::<PageServer>() {
        server.forget(&key);
    }
    Ok(())
}

/// Whether a cookie belongs to the app itself rather than to a page or an
/// embed. The app sets none today; this keeps it that way if it ever does.
fn is_app_cookie(domain: Option<&str>) -> bool {
    let domain = domain.unwrap_or("").trim_start_matches('.');
    domain == "localhost" || domain == "tauri.localhost"
}

/// Delete every cookie in the webview's store except the app's own: those of
/// pages and of what they embed (a video player's site, say). Returns how
/// many were deleted.
#[tauri::command]
pub async fn clear_page_cookies(app: AppHandle) -> Result<usize, String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(0);
    };
    // Reading cookies from a synchronous context deadlocks on Windows
    // (wry#583), so off the async runtime's threads.
    tauri::async_runtime::spawn_blocking(move || {
        let cookies = window.cookies().map_err(|e| e.to_string())?;
        let mut deleted = 0;
        for cookie in cookies {
            if is_app_cookie(cookie.domain()) {
                continue;
            }
            if window.delete_cookie(cookie).is_ok() {
                deleted += 1;
            }
        }
        Ok(deleted)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::is_app_cookie;

    #[test]
    fn only_the_apps_own_hosts_count_as_app_cookies() {
        assert!(is_app_cookie(Some("tauri.localhost")));
        assert!(is_app_cookie(Some(".localhost")));
        assert!(!is_app_cookie(Some("youtube.com")));
        assert!(!is_app_cookie(Some("0123.page.localhost")));
        assert!(!is_app_cookie(None));
    }
}
