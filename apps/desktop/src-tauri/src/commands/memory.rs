//! Persistent memory IPC (t1-5).

use crate::{
    db::repository::memory::{
        self, compose_prompt_block, MemoryItem, MemoryKind, MemoryStatus, NewMemory, GLOBAL_SCOPE,
    },
    state::AppState,
};
use tauri::State;

fn parse_kind(kind: Option<&str>) -> Result<MemoryKind, String> {
    match kind.unwrap_or("core") {
        "core" => Ok(MemoryKind::Core),
        "note" => Ok(MemoryKind::Note),
        other => Err(format!("unknown memory kind {other:?}")),
    }
}

/// `global` (the user's own memory) when absent; otherwise `agent:<id>`.
fn parse_scope(scope: Option<&str>) -> Result<String, String> {
    match scope.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(GLOBAL_SCOPE.to_string()),
        Some(scope) if memory::is_scope(scope) => Ok(scope.to_string()),
        Some(other) => Err(format!("unknown memory scope {other:?}")),
    }
}

/// The user's own memory, or with `scope` (`agent:<id>`) one agent's notes.
#[tauri::command]
pub async fn list_memory_items(
    state: State<'_, AppState>,
    status: Option<String>,
    scope: Option<String>,
) -> Result<Vec<MemoryItem>, String> {
    let filter = match status.as_deref() {
        None | Some("") => None,
        Some("pending") => Some(MemoryStatus::Pending),
        Some("active") => Some(MemoryStatus::Active),
        Some(other) => return Err(format!("unknown memory status {other:?}")),
    };
    let scope = parse_scope(scope.as_deref())?;
    memory::list_in(&state.db, &state.encryption, filter, &scope)
        .await
        .map_err(|e| e.to_string())
}

/// A fact the user adds by hand: to their own memory, or with `scope` to
/// one agent's notes. Active at once either way.
#[tauri::command]
pub async fn create_memory_item(
    state: State<'_, AppState>,
    body: String,
    kind: Option<String>,
    pinned: Option<bool>,
    scope: Option<String>,
) -> Result<MemoryItem, String> {
    memory::create(
        &state.db,
        &state.encryption,
        NewMemory {
            kind: parse_kind(kind.as_deref())?,
            body,
            source_conversation_id: None,
            pinned: pinned.unwrap_or(false),
            status: MemoryStatus::Active,
            scope: parse_scope(scope.as_deref())?,
            origin: None,
        },
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_memory_item(
    state: State<'_, AppState>,
    id: String,
    body: String,
    kind: Option<String>,
    pinned: Option<bool>,
) -> Result<MemoryItem, String> {
    let existing = memory::get(&state.db, &state.encryption, &id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "memory item not found".to_string())?;
    memory::update(
        &state.db,
        &state.encryption,
        &id,
        parse_kind(kind.as_deref().or(Some(existing.kind.as_str())))?,
        &body,
        pinned.unwrap_or(existing.pinned),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_memory_item(state: State<'_, AppState>, id: String) -> Result<(), String> {
    memory::delete(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn accept_memory_item(
    state: State<'_, AppState>,
    id: String,
) -> Result<MemoryItem, String> {
    memory::accept(&state.db, &state.encryption, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_memory_prompt_block(state: State<'_, AppState>) -> Result<String, String> {
    let enabled = state.settings()?.memory_enabled;
    let items = memory::list(&state.db, &state.encryption, Some(MemoryStatus::Active))
        .await
        .map_err(|e| e.to_string())?;
    Ok(compose_prompt_block(&items, enabled))
}
