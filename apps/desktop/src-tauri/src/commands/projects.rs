//! Projects IPC: a folder's settings for every chat in it.

use crate::{
    db::repository::projects::{self, ConversationProject, ProjectSettings},
    state::AppState,
};
use tauri::State;

/// The project `conversation_id` is in (with its settings), or `None`.
#[tauri::command]
pub async fn get_conversation_project(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Option<ConversationProject>, String> {
    projects::for_conversation(&state.db, &state.encryption, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_project_settings(
    state: State<'_, AppState>,
    folder_id: String,
) -> Result<ProjectSettings, String> {
    projects::get_settings(&state.db, &state.encryption, &folder_id)
        .await
        .map_err(|e| e.to_string())
}

/// Save all of a folder's settings at once and return what was stored.
#[tauri::command]
pub async fn set_project_settings(
    state: State<'_, AppState>,
    folder_id: String,
    user_instructions: Option<String>,
    workspace_root: Option<String>,
    skill_ids: Vec<String>,
    collection_ids: Vec<String>,
) -> Result<ProjectSettings, String> {
    if let Some(text) = user_instructions.as_deref() {
        crate::validation::validate_user_instructions(text)?;
    }
    // Blank clears the working folder; anything else must be a real directory.
    if let Some(root) = workspace_root.as_deref().filter(|r| !r.trim().is_empty()) {
        crate::commands::chat::checked_workspace_root(root)?;
    }
    let db = &state.db;
    // The lists can be refused (a bad skill id, a deleted collection), so they
    // go first: a refusal then leaves the instructions as they were.
    projects::set_skills(db, &folder_id, &skill_ids)
        .await
        .map_err(|e| e.to_string())?;
    projects::set_collections(db, &folder_id, &collection_ids)
        .await
        .map_err(|e| e.to_string())?;
    projects::set_settings(
        db,
        &state.encryption,
        &folder_id,
        user_instructions.as_deref(),
        workspace_root.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;
    projects::get_settings(db, &state.encryption, &folder_id)
        .await
        .map_err(|e| e.to_string())
}
