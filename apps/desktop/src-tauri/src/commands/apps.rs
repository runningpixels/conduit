//! Saved mini-apps: save an HTML artifact as an app, list, open, edit, update
//! from its source, delete. Network access for an app goes through the
//! `artifact_network` commands with principal `app:<id>`.

use provider_core::schema::{AppCategory, AppDetail, AppInput, AppSummary, StarterAppInfo};
use serde::Deserialize;
use tauri::State;

use crate::{
    artifact_network,
    db::repository::apps::{self, AppMeta},
    starter_apps::{self, STARTER_APPS},
    state::AppState,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppMetaInput {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    pub category: AppCategory,
}

impl AppMetaInput {
    fn validated(self) -> Result<AppMeta, String> {
        AppMeta {
            name: self.name,
            description: self.description,
            icon: self.icon,
            category: self.category,
        }
        .validated()
    }
}

/// Normalise the hosts a page declares to https origins, dropping any that
/// aren't one (the page's meta tags are free text).
fn declared_origins(hosts: Vec<String>) -> Vec<String> {
    hosts
        .iter()
        .filter(|h| !artifact_network::reaches_any_site(h))
        .filter_map(|h| artifact_network::grant_host(h).ok())
        .collect()
}

#[tauri::command]
pub async fn save_app(
    state: State<'_, AppState>,
    artifact_id: String,
    meta: AppMetaInput,
    declared_hosts: Vec<String>,
    declared_capabilities: Vec<String>,
    declared_inputs: Vec<AppInput>,
    keep_hosts: Vec<String>,
) -> Result<AppSummary, String> {
    let capabilities = apps::validate_capabilities(&declared_capabilities)?;
    provider_core::app_inputs::validate_declaration(&declared_inputs)
        .map_err(|e| format!("invalid: {e}"))?;
    apps::save_from_artifact(
        &state.db,
        &state.paths.artifacts,
        &state.encryption,
        &artifact_id,
        meta.validated()?,
        declared_origins(declared_hosts),
        capabilities,
        declared_inputs,
        &keep_hosts,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_apps(state: State<'_, AppState>) -> Result<Vec<AppSummary>, String> {
    apps::list(&state.db, &state.encryption)
        .await
        .map_err(|e| e.to_string())
}

/// Open an app: its page, and a stamp of when it was last opened.
#[tauri::command]
pub async fn open_app(state: State<'_, AppState>, id: String) -> Result<AppDetail, String> {
    apps::open(&state.db, &state.encryption, &id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That app no longer exists.".to_string())
}

#[tauri::command]
pub async fn update_app(
    state: State<'_, AppState>,
    id: String,
    meta: AppMetaInput,
) -> Result<AppSummary, String> {
    apps::update_meta(&state.db, &state.encryption, &id, meta.validated()?)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_app_from_artifact(
    state: State<'_, AppState>,
    id: String,
    declared_hosts: Vec<String>,
    declared_capabilities: Vec<String>,
    declared_inputs: Vec<AppInput>,
) -> Result<AppSummary, String> {
    let capabilities = apps::validate_capabilities(&declared_capabilities)?;
    provider_core::app_inputs::validate_declaration(&declared_inputs)
        .map_err(|e| format!("invalid: {e}"))?;
    apps::update_from_artifact(
        &state.db,
        &state.paths.artifacts,
        &state.encryption,
        &id,
        declared_origins(declared_hosts),
        capabilities,
        declared_inputs,
    )
    .await
    .map_err(|e| e.to_string())
}

/// The ready-made apps, and which of them the user has added.
#[tauri::command]
pub async fn list_starter_apps(state: State<'_, AppState>) -> Result<Vec<StarterAppInfo>, String> {
    let installed = apps::installed_starters(&state.db)
        .await
        .map_err(|e| e.to_string())?;
    Ok(STARTER_APPS
        .iter()
        .map(|s| StarterAppInfo {
            id: s.id.to_string(),
            idea_id: s.idea_id.to_string(),
            category: s.category,
            icon: s.icon.to_string(),
            hosts: s.hosts.iter().map(|h| h.to_string()).collect(),
            installed_app_id: installed.get(s.id).cloned(),
        })
        .collect())
}

/// Add a starter app (or return the copy the user already has). `meta`
/// carries the name and description in the user's language; the category
/// and mark are the starter's own.
#[tauri::command]
pub async fn install_starter_app(
    state: State<'_, AppState>,
    id: String,
    name: String,
    description: Option<String>,
) -> Result<AppSummary, String> {
    let starter = starter_apps::find(&id).ok_or_else(|| format!("No starter app called {id}."))?;
    let meta = AppMeta {
        name,
        description,
        icon: Some(starter.icon.to_string()),
        category: starter.category,
    }
    .validated()?;
    apps::install_starter(&state.db, &state.encryption, starter, meta)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_app(state: State<'_, AppState>, id: String) -> Result<(), String> {
    artifact_network::clear_session_grants(Some(&format!("app:{id}")));
    apps::delete(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::declared_origins;

    #[test]
    fn a_page_cannot_declare_itself_a_blanket_grant() {
        let declared = declared_origins(vec![
            "*".to_string(),
            "full".to_string(),
            "https://API.example.com/v1".to_string(),
        ]);
        assert_eq!(declared, vec!["https://api.example.com".to_string()]);
    }
}
