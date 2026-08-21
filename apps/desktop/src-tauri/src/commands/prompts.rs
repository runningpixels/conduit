//! Prompt library commands — CRUD for reusable prompt templates.

use crate::{
    db::repository::prompts::{self, Prompt},
    state::AppState,
};
use tauri::State;

#[tauri::command]
pub async fn create_prompt(
    state: State<'_, AppState>,
    title: String,
    body: String,
    folder: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Prompt, String> {
    prompts::create(
        &state.db,
        &state.encryption,
        &title,
        &body,
        folder.as_deref(),
        tags.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_prompts(
    state: State<'_, AppState>,
    folder: Option<String>,
) -> Result<Vec<Prompt>, String> {
    prompts::list(&state.db, &state.encryption, folder.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_prompt(state: State<'_, AppState>, id: String) -> Result<Option<Prompt>, String> {
    prompts::get(&state.db, &state.encryption, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_prompt(
    state: State<'_, AppState>,
    id: String,
    title: String,
    body: String,
    folder: Option<String>,
    tags: Option<Vec<String>>,
) -> Result<Prompt, String> {
    prompts::update(
        &state.db,
        &state.encryption,
        &id,
        &title,
        &body,
        folder.as_deref(),
        tags.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_prompt(state: State<'_, AppState>, id: String) -> Result<(), String> {
    prompts::delete(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_prompt_folders(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    prompts::list_folders(&state.db)
        .await
        .map_err(|e| e.to_string())
}
