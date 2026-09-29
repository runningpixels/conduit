//! Saved mini-apps: save an HTML artifact as an app, list, open, edit, update
//! from its source, delete. Network access for an app goes through the
//! `artifact_network` commands with principal `app:<id>`.

use provider_core::schema::{AppCategory, AppDetail, AppSummary};
use serde::Deserialize;
use tauri::State;

use crate::{
    artifact_network,
    db::repository::apps::{self, AppMeta},
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
        .filter(|h| h.as_str() != artifact_network::ANY_SITE)
        .filter_map(|h| artifact_network::grant_host(h).ok())
        .collect()
}

#[tauri::command]
pub async fn save_app(
    state: State<'_, AppState>,
    artifact_id: String,
    meta: AppMetaInput,
    declared_hosts: Vec<String>,
    keep_hosts: Vec<String>,
) -> Result<AppSummary, String> {
    apps::save_from_artifact(
        &state.db,
        &state.paths.artifacts,
        &state.encryption,
        &artifact_id,
        meta.validated()?,
        declared_origins(declared_hosts),
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
) -> Result<AppSummary, String> {
    apps::update_from_artifact(
        &state.db,
        &state.paths.artifacts,
        &state.encryption,
        &id,
        declared_origins(declared_hosts),
    )
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
