//! IPC for workflows: save and edit definitions, run one by hand, and read back
//! what a run did. See `crate::workflows`.

use std::collections::HashMap;

use serde_json::Value;
use tauri::State;

use crate::artifact_network::AddressPolicy;
use crate::db::repository::conversations;
use crate::db::repository::workflows::{
    self as repo, WorkflowRecord, WorkflowRun, WorkflowRunDetail, WorkflowSummary,
};
use crate::state::AppState;
use crate::stream_manager::StreamManager;
use crate::workflows::{definition, runner::Runner};

const MAX_NAME_CHARS: usize = 120;

/// The name, trimmed, or why it can't be used.
fn checked_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A workflow needs a name.".to_string());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("Keep the name under {MAX_NAME_CHARS} characters."));
    }
    Ok(name.to_string())
}

/// Parse and validate a definition sent by the renderer.
fn checked_definition(definition: &Value) -> Result<(), String> {
    let parsed: definition::WorkflowDefinition = serde_json::from_value(definition.clone())
        .map_err(|e| format!("The workflow definition can't be read: {e}"))?;
    definition::validate(&parsed).map_err(|problems| problems.join("\n"))
}

#[tauri::command]
pub async fn list_workflows(state: State<'_, AppState>) -> Result<Vec<WorkflowSummary>, String> {
    repo::list(&state.db).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_workflow(
    state: State<'_, AppState>,
    id: String,
) -> Result<WorkflowRecord, String> {
    repo::get(&state.db, &state.encryption, &id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That workflow no longer exists.".to_string())
}

#[tauri::command]
pub async fn create_workflow(
    state: State<'_, AppState>,
    name: String,
    description: Option<String>,
    definition: Value,
) -> Result<WorkflowRecord, String> {
    let name = checked_name(&name)?;
    checked_definition(&definition)?;
    repo::create(
        &state.db,
        &state.encryption,
        &name,
        description.as_deref(),
        &definition,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_workflow(
    state: State<'_, AppState>,
    id: String,
    name: String,
    description: Option<String>,
    definition: Value,
) -> Result<WorkflowRecord, String> {
    let name = checked_name(&name)?;
    checked_definition(&definition)?;
    repo::update(
        &state.db,
        &state.encryption,
        &id,
        &name,
        description.as_deref(),
        &definition,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Delete a workflow, its runs, and its conversation with the artifacts it saved.
#[tauri::command]
pub async fn delete_workflow(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let workflow = repo::get(&state.db, &state.encryption, &id)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(conversation_id) = workflow.and_then(|w| w.conversation_id) {
        conversations::delete_with_files(
            &state.db,
            &state.paths.artifacts,
            &state.paths.attachments,
            &conversation_id,
        )
        .await
        .map_err(|e| e.to_string())?;
    }
    repo::delete(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

/// Run a workflow now and return what it did. Waits for the whole run.
#[tauri::command]
pub async fn run_workflow(
    state: State<'_, AppState>,
    stream_manager: State<'_, StreamManager>,
    id: String,
    inputs: Option<HashMap<String, String>>,
) -> Result<WorkflowRunDetail, String> {
    let runner = Runner {
        state: state.inner(),
        streams: stream_manager.inner(),
        fetch_policy: AddressPolicy::APP,
    };
    runner.run(&id, &inputs.unwrap_or_default(), "manual").await
}

#[tauri::command]
pub async fn list_workflow_runs(
    state: State<'_, AppState>,
    id: String,
    limit: Option<i64>,
) -> Result<Vec<WorkflowRun>, String> {
    repo::list_runs(&state.db, &id, limit.unwrap_or(30).clamp(1, 200))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_workflow_run(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<WorkflowRunDetail, String> {
    repo::get_run(&state.db, &state.encryption, &run_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That run no longer exists.".to_string())
}
