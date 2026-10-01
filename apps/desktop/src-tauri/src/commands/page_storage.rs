//! IPC for `window.conduit.storage` (ADR-012, bridge v2): one command per
//! operation, keyed by principal (`artifact:<id>` or `app:<id>`). Every error
//! is `Err(String)` starting with a bridge error code and a colon
//! (`invalid:`, `quota:`, `rate_limited:`, `unavailable:`); the renderer maps
//! the prefix to the bridge's `{ code, message }` and the rest to the message.

use provider_core::schema::PageStorageUsage;
use serde_json::Value;
use tauri::State;

use crate::{
    db::repository::{app_activity, artifact_network::Principal, page_storage},
    state::AppState,
};

/// The renderer never names its own principal freely, but a malformed string
/// still has to fail as `invalid:`, not panic or fall through.
fn parse_principal(raw: &str) -> Result<Principal, String> {
    Principal::parse(raw).map_err(|e| format!("invalid: {e}"))
}

#[tauri::command]
pub async fn page_storage_get(
    state: State<'_, AppState>,
    principal: String,
    key: String,
) -> Result<Option<Value>, String> {
    let principal = parse_principal(&principal)?;
    page_storage::get(&state.db, &state.encryption, &principal, &key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn page_storage_set(
    state: State<'_, AppState>,
    principal: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    let principal = parse_principal(&principal)?;
    page_storage::set(&state.db, &state.encryption, &principal, &key, &value)
        .await
        .map_err(|e| e.to_string())?;
    app_activity::record_storage_write(&state.db, &principal).await;
    Ok(())
}

#[tauri::command]
pub async fn page_storage_delete(
    state: State<'_, AppState>,
    principal: String,
    key: String,
) -> Result<(), String> {
    let principal = parse_principal(&principal)?;
    page_storage::delete(&state.db, &principal, &key)
        .await
        .map_err(|e| e.to_string())?;
    app_activity::record_storage_write(&state.db, &principal).await;
    Ok(())
}

#[tauri::command]
pub async fn page_storage_keys(
    state: State<'_, AppState>,
    principal: String,
    prefix: Option<String>,
) -> Result<Vec<String>, String> {
    let principal = parse_principal(&principal)?;
    page_storage::keys(&state.db, &principal, prefix.as_deref())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn page_storage_usage(
    state: State<'_, AppState>,
    principal: String,
) -> Result<PageStorageUsage, String> {
    let principal = parse_principal(&principal)?;
    page_storage::usage(&state.db, &principal)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn page_storage_clear(
    state: State<'_, AppState>,
    principal: String,
) -> Result<(), String> {
    let principal = parse_principal(&principal)?;
    page_storage::clear(&state.db, &principal)
        .await
        .map_err(|e| e.to_string())?;
    app_activity::record_storage_write(&state.db, &principal).await;
    Ok(())
}
