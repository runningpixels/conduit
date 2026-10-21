//! IPC for the agent library: the user's agents, defined once and used as
//! helpers in any workflow. See `crate::agents`.

use serde_json::Value;
use tauri::State;

use crate::agents::library::{self, LibraryAgent};
use crate::state::AppState;
use crate::workflows::definition::AgentDef;

/// The user's agents, by name, with the workflows that use each.
#[tauri::command]
pub async fn list_library_agents(state: State<'_, AppState>) -> Result<Vec<LibraryAgent>, String> {
    library::list(&state.db, &state.encryption).await
}

/// Save a new agent. An empty id is made from its name, and a taken one gets
/// a suffix. Errors are the problems, one per line.
#[tauri::command]
pub async fn create_library_agent(
    state: State<'_, AppState>,
    agent: AgentDef,
) -> Result<LibraryAgent, String> {
    library::create(&state.db, &state.encryption, agent).await
}

/// Save changes to an agent; every workflow that uses it gets them.
#[tauri::command]
pub async fn update_library_agent(
    state: State<'_, AppState>,
    agent: AgentDef,
) -> Result<LibraryAgent, String> {
    library::update(&state.db, &state.encryption, agent).await
}

/// Delete an agent. Workflows that use it keep their own copy. Returns how
/// many workflows were given one.
#[tauri::command]
pub async fn delete_library_agent(state: State<'_, AppState>, id: String) -> Result<u32, String> {
    library::delete(&state.db, &state.encryption, &id).await
}

/// Everything wrong with an agent, in plain English; empty when it can be
/// saved. The editor calls this as the user types.
#[tauri::command]
pub async fn validate_library_agent(
    state: State<'_, AppState>,
    agent: AgentDef,
) -> Result<Vec<String>, String> {
    library::validate(&state.db, &state.encryption, agent).await
}

/// A definition's helpers with the user's agents filled in (and the agents
/// they hand work to added), as a run sees them.
#[tauri::command]
pub async fn resolve_workflow_agents(
    state: State<'_, AppState>,
    definition: Value,
) -> Result<Vec<AgentDef>, String> {
    library::resolve_value_helpers(&state.db, &state.encryption, &definition).await
}
