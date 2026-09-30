//! IPC for launch inputs (ADR-013). `get_app_inputs` resolves the effective
//! values for an app's declared inputs (a stored-and-valid value, else the
//! default, else omitted); `set_app_inputs` validates and replaces them.
//! Every error is `Err(String)` starting with `invalid:` or `unavailable:`,
//! matching the `page_storage` bridge error-code convention.

use serde_json::{Map, Value};
use tauri::State;

use crate::{
    db::repository::{app_inputs, apps},
    state::AppState,
};

#[tauri::command]
pub async fn get_app_inputs(
    state: State<'_, AppState>,
    id: String,
) -> Result<Map<String, Value>, String> {
    let manifest = apps::stored_manifest(&state.db, &state.encryption, &id)
        .await
        .map_err(|e| e.to_string())?;
    app_inputs::get_values(&state.db, &state.encryption, &id, &manifest.inputs)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_app_inputs(
    state: State<'_, AppState>,
    id: String,
    values: Map<String, Value>,
) -> Result<Map<String, Value>, String> {
    let manifest = apps::stored_manifest(&state.db, &state.encryption, &id)
        .await
        .map_err(|e| e.to_string())?;
    app_inputs::set_values(&state.db, &state.encryption, &id, &manifest.inputs, values)
        .await
        .map_err(|e| e.to_string())
}
