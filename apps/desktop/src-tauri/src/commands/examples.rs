//! First-run examples: added once when onboarding finishes on a new profile,
//! listed so the interface can mark them, and removable all at once. See
//! `first_run_examples`.

use tauri::State;

use crate::first_run_examples::{self as examples, ExampleItem, SeedOutcome, SeedRequest};
use crate::state::AppState;

/// Add the first-run examples if this profile is new and has never had them.
#[tauri::command]
pub async fn seed_examples(
    state: State<'_, AppState>,
    request: SeedRequest,
) -> Result<SeedOutcome, String> {
    examples::seed(&state, &request).await
}

/// The examples this profile still has.
#[tauri::command]
pub async fn list_example_items(state: State<'_, AppState>) -> Result<Vec<ExampleItem>, String> {
    examples::list(&state.db).await.map_err(|e| e.to_string())
}

/// Delete every example the profile still has; returns how many.
#[tauri::command]
pub async fn remove_all_examples(state: State<'_, AppState>) -> Result<usize, String> {
    examples::remove_all(&state).await
}
