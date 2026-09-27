//! Network access for HTML artifacts (ADR-010): the request itself, and the
//! user's grants. The renderer's consent state only decides whether to *ask*;
//! every check that matters is repeated here.

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::{
    artifact_network::{self, AddressPolicy, ArtifactFetchRequest, ArtifactFetchResponse},
    db::repository::artifact_network::{self as grants, ArtifactNetworkGrant},
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

/// Make a request for an artifact, to a host the user granted it.
#[tauri::command]
pub async fn artifact_fetch(
    state: State<'_, AppState>,
    request: ArtifactFetchRequest,
) -> Result<ArtifactFetchResponse, String> {
    if let Some(reason) = network_blocked_reason(&state)? {
        return Err(reason);
    }
    let host = artifact_network::grant_host(&request.url)?;
    // Everything this page may reach: its remembered and session grants, where
    // ANY_SITE stands for every public https site.
    let mut reachable: std::collections::HashSet<String> =
        grants::list(&state.db, Some(&request.artifact_id))
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|g| g.host)
            .collect();
    let remembered = reachable.clone();
    reachable.extend(artifact_network::session_hosts(&request.artifact_id));
    let any_site = reachable.contains(artifact_network::ANY_SITE);
    if !any_site && !reachable.contains(&host) {
        return Err(format!("This page has not been allowed to contact {host}."));
    }
    let _slot = artifact_network::reserve_slot(&request.artifact_id).await?;
    let allowed = move |origin: &str| any_site || reachable.contains(origin);
    let response = artifact_network::perform(&request, AddressPolicy::APP, &allowed).await?;
    let grant = if remembered.contains(&host) {
        Some(host.as_str())
    } else if remembered.contains(artifact_network::ANY_SITE) {
        Some(artifact_network::ANY_SITE)
    } else {
        None
    };
    if let Some(grant) = grant {
        let _ = grants::touch(&state.db, &request.artifact_id, grant).await;
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

/// Allow `host` (an https origin) for `artifact_id`.
#[tauri::command]
pub async fn grant_artifact_network(
    state: State<'_, AppState>,
    artifact_id: String,
    host: String,
    scope: GrantScope,
) -> Result<(), String> {
    let host = artifact_network::grant_host(&host)?;
    match scope {
        GrantScope::Session => artifact_network::grant_for_session(&artifact_id, &host),
        GrantScope::Page => grants::grant(&state.db, &artifact_id, &host)
            .await
            .map_err(|e| e.to_string())?,
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
}

#[tauri::command]
pub async fn get_artifact_network_state(
    state: State<'_, AppState>,
    artifact_id: String,
) -> Result<ArtifactNetworkState, String> {
    let always = grants::list(&state.db, Some(&artifact_id))
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|g| g.host)
        .collect();
    Ok(ArtifactNetworkState {
        blocked_reason: network_blocked_reason(&state)?,
        always,
        session: artifact_network::session_hosts(&artifact_id),
    })
}

/// Every remembered grant, for Settings.
#[tauri::command]
pub async fn list_artifact_network_grants(
    state: State<'_, AppState>,
) -> Result<Vec<ArtifactNetworkGrant>, String> {
    grants::list(&state.db, None)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn revoke_artifact_network_grant(
    state: State<'_, AppState>,
    artifact_id: String,
    host: String,
) -> Result<(), String> {
    artifact_network::revoke_session_grant(&artifact_id, &host);
    grants::revoke(&state.db, &artifact_id, &host)
        .await
        .map_err(|e| e.to_string())
}

/// Forget every grant — remembered and session — or those of one page.
#[tauri::command]
pub async fn clear_artifact_network_grants(
    state: State<'_, AppState>,
    artifact_id: Option<String>,
) -> Result<(), String> {
    artifact_network::clear_session_grants(artifact_id.as_deref());
    grants::clear(&state.db, artifact_id.as_deref())
        .await
        .map_err(|e| e.to_string())
}
