//! Network access for HTML pages (ADR-010) — an artifact in a chat or a saved
//! mini-app: the request itself, and the user's grants. The renderer's consent
//! state only decides whether to *ask*; every check that matters is repeated
//! here.
//!
//! Every command names its page by principal: `artifact:<id>` or `app:<id>`.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    artifact_network::{self, AddressPolicy, ArtifactFetchRequest, ArtifactFetchResponse},
    db::repository::{
        app_activity::{self, FetchCall},
        artifact_network::{self as grants, NetworkGrant, Principal},
    },
    state::AppState,
};

/// Why a page cannot connect at all right now, if it cannot.
fn network_blocked_reason(state: &AppState) -> Result<Option<String>, String> {
    let settings = state.settings()?;
    if settings.local_only {
        return Ok(Some(
            "Local-only mode is on, so pages can't connect to the internet.".to_string(),
        ));
    }
    if !settings.artifact_network_enabled {
        return Ok(Some(
            "Pages connecting to the internet is turned off in Settings → Artifact security."
                .to_string(),
        ));
    }
    Ok(None)
}

/// The Settings switch "Give every page full web access".
fn full_web_access_for_every_page(state: &AppState) -> Result<bool, String> {
    Ok(state.settings()?.artifact_full_web_access == Some(true))
}

/// Whether a page loads with full web access: pages can connect at all, and
/// either the page holds the grant (remembered or for this session) or the
/// Settings switch gives it to every page.
pub fn has_full_web_access(
    blocked: bool,
    every_page: bool,
    always: &[String],
    session: &[String],
) -> bool {
    !blocked
        && (every_page
            || always
                .iter()
                .chain(session)
                .any(|g| g == artifact_network::FULL_WEB_ACCESS))
}

/// Whether the artifact or app behind `principal` exists — so a remembered
/// grant is never written for nothing.
async fn principal_exists(state: &AppState, principal: &Principal) -> Result<bool, String> {
    let (sql, id) = match principal {
        Principal::Artifact(id) => ("SELECT 1 FROM artifacts WHERE id = ?", id),
        Principal::App(id) => ("SELECT 1 FROM apps WHERE id = ?", id),
    };
    let row: Option<(i64,)> = sqlx::query_as(sql)
        .bind(id)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(row.is_some())
}

/// Why a page's request failed: a bridge-style code, kept for an app's
/// activity log, and the message the page sees.
struct FetchFailure {
    code: &'static str,
    message: String,
}

impl FetchFailure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

/// Make a request for a page, to a host the user granted it. For a saved app
/// the request is logged (origin, method, status or error code — never the
/// path, headers or body) to its activity.
#[tauri::command]
pub async fn artifact_fetch(
    state: State<'_, AppState>,
    request: ArtifactFetchRequest,
) -> Result<ArtifactFetchResponse, String> {
    let principal = Principal::parse(&request.principal)?;
    let host = artifact_network::grant_host(&request.url)?;
    let result = fetch_for(&state, &request, &principal, &host).await;
    let (status, error) = match &result {
        Ok(response) => (Some(response.status), None),
        Err(failure) => (None, Some(failure.code)),
    };
    app_activity::record_fetch(
        &state.db,
        &principal,
        &FetchCall {
            host: &host,
            method: &request
                .method
                .to_ascii_uppercase()
                .chars()
                .take(16)
                .collect::<String>(),
            status,
            error,
            ok: status.is_some_and(|s| (200..400).contains(&s)),
        },
    )
    .await;
    result.map_err(|failure| failure.message)
}

async fn fetch_for(
    state: &AppState,
    request: &ArtifactFetchRequest,
    principal: &Principal,
    host: &str,
) -> Result<ArtifactFetchResponse, FetchFailure> {
    if let Some(reason) =
        network_blocked_reason(state).map_err(|e| FetchFailure::new("blocked", e))?
    {
        return Err(FetchFailure::new("blocked", reason));
    }
    let key = principal.key();
    let host = host.to_string();
    // Everything this page may reach: its remembered and session grants, where
    // ANY_SITE stands for every public https site.
    let mut reachable: std::collections::HashSet<String> = grants::list(&state.db, Some(principal))
        .await
        .map_err(|e| FetchFailure::new("unavailable", e.to_string()))?
        .into_iter()
        .map(|g| g.host)
        .collect();
    let remembered = reachable.clone();
    reachable.extend(artifact_network::session_hosts(&key));
    let every_page_full =
        full_web_access_for_every_page(state).map_err(|e| FetchFailure::new("unavailable", e))?;
    let any_site = every_page_full
        || reachable
            .iter()
            .any(|g| artifact_network::reaches_any_site(g));
    if !any_site && !reachable.contains(&host) {
        return Err(FetchFailure::new(
            "not_granted",
            format!("This page has not been allowed to contact {host}."),
        ));
    }
    let _slot = artifact_network::reserve_slot(&key)
        .await
        .map_err(|e| FetchFailure::new("rate_limited", e))?;
    let allowed = move |origin: &str| any_site || reachable.contains(origin);
    let response = artifact_network::perform(request, AddressPolicy::APP, &allowed)
        .await
        .map_err(|e| {
            let code = if e.starts_with(artifact_network::REDIRECT_ERROR_PREFIX) {
                "redirect"
            } else {
                "network"
            };
            FetchFailure::new(code, e)
        })?;
    let grant = if remembered.contains(&host) {
        Some(host.as_str())
    } else if remembered.contains(artifact_network::ANY_SITE) {
        Some(artifact_network::ANY_SITE)
    } else if remembered.contains(artifact_network::FULL_WEB_ACCESS) {
        Some(artifact_network::FULL_WEB_ACCESS)
    } else {
        None
    };
    if let Some(grant) = grant {
        let _ = grants::touch(&state.db, principal, grant).await;
    }
    Ok(response)
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum GrantScope {
    /// Until Conduit quits.
    Session,
    /// Remembered for this page.
    Page,
}

/// Allow `host` (an https origin) for `principal`.
#[tauri::command]
pub async fn grant_artifact_network(
    state: State<'_, AppState>,
    principal: String,
    host: String,
    scope: GrantScope,
) -> Result<(), String> {
    let principal = Principal::parse(&principal)?;
    let host = artifact_network::grant_host(&host)?;
    match scope {
        GrantScope::Session => artifact_network::grant_for_session(&principal.key(), &host),
        GrantScope::Page => {
            if !principal_exists(&state, &principal).await? {
                return Err("This page no longer exists.".to_string());
            }
            grants::grant(&state.db, &principal, &host)
                .await
                .map_err(|e| e.to_string())?
        }
    }
    Ok(())
}

/// What one page may reach, and whether it can connect at all.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactNetworkState {
    /// `None` when pages may connect; otherwise why not.
    pub blocked_reason: Option<String>,
    pub always: Vec<String>,
    pub session: Vec<String>,
    /// Whether the page loads with full web access (its frame's CSP opens to
    /// https; see ADR-007): its own grant or the Settings switch, and only
    /// while pages can connect at all.
    pub full_access: bool,
}

#[tauri::command]
pub async fn get_artifact_network_state(
    state: State<'_, AppState>,
    principal: String,
) -> Result<ArtifactNetworkState, String> {
    let principal = Principal::parse(&principal)?;
    let always: Vec<String> = grants::list(&state.db, Some(&principal))
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|g| g.host)
        .collect();
    let session = artifact_network::session_hosts(&principal.key());
    let blocked_reason = network_blocked_reason(&state)?;
    let full_access = has_full_web_access(
        blocked_reason.is_some(),
        full_web_access_for_every_page(&state)?,
        &always,
        &session,
    );
    Ok(ArtifactNetworkState {
        blocked_reason,
        always,
        session,
        full_access,
    })
}

/// Every remembered grant, for Settings.
#[tauri::command]
pub async fn list_artifact_network_grants(
    state: State<'_, AppState>,
) -> Result<Vec<NetworkGrant>, String> {
    grants::list(&state.db, None)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn revoke_artifact_network_grant(
    state: State<'_, AppState>,
    principal: String,
    host: String,
) -> Result<(), String> {
    let principal = Principal::parse(&principal)?;
    artifact_network::revoke_session_grant(&principal.key(), &host);
    grants::revoke(&state.db, &principal, &host)
        .await
        .map_err(|e| e.to_string())
}

/// Forget every grant — remembered and session — or those of one page.
#[tauri::command]
pub async fn clear_artifact_network_grants(
    state: State<'_, AppState>,
    principal: Option<String>,
) -> Result<(), String> {
    let principal = principal.as_deref().map(Principal::parse).transpose()?;
    let key = principal.as_ref().map(Principal::key);
    artifact_network::clear_session_grants(key.as_deref());
    grants::clear(&state.db, principal.as_ref())
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::has_full_web_access;
    use crate::artifact_network::{ANY_SITE, FULL_WEB_ACCESS};

    fn hosts(list: &[&str]) -> Vec<String> {
        list.iter().map(|h| h.to_string()).collect()
    }

    #[test]
    fn full_access_comes_from_the_grant_or_the_switch_and_never_while_blocked() {
        let none = hosts(&[]);
        let full = hosts(&[FULL_WEB_ACCESS]);
        let sites = hosts(&["https://api.example.com", ANY_SITE]);
        assert!(!has_full_web_access(false, false, &none, &none));
        // The any-site fetch grant is not full access.
        assert!(!has_full_web_access(false, false, &sites, &sites));
        assert!(has_full_web_access(false, false, &full, &none));
        assert!(has_full_web_access(false, false, &none, &full));
        assert!(has_full_web_access(false, true, &none, &none));
        // Local-only mode or the network switch off: no page loads remote code.
        assert!(!has_full_web_access(true, true, &full, &full));
    }
}
