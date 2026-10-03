//! IPC for Research: start a run in a chat, approve or cancel its brief, stop
//! it, and read it back. See `crate::research`. Progress and status changes
//! arrive as the app-wide `research-run-updated` event.

use provider_core::schema::{ResearchBrief, ResearchRun, ResearchStatus};
use tauri::State;

use crate::research::{app, service, ResearchRuns};
use crate::state::AppState;

/// Save the question and the run's message in the chat, and start planning.
/// Returns the run (`planning`).
#[tauri::command]
pub async fn start_research(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
    question: String,
) -> Result<ResearchRun, String> {
    let run = service::start(&state, &conversation_id, &question).await?;
    app::announce(&app, &run.id, run.status);
    app::spawn_plan(app.clone(), run.id.clone(), question.trim().to_string());
    Ok(run)
}

/// Start a run waiting on its brief, with the brief as the user edited it.
/// Returns the run (`running`).
#[tauri::command]
pub async fn approve_research_brief(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    brief: ResearchBrief,
) -> Result<ResearchRun, String> {
    let (run, brief) = service::approve(&state, &run_id, &brief).await?;
    app::announce(&app, &run.id, run.status);
    app::spawn_run(app.clone(), run.id.clone(), brief);
    Ok(run)
}

/// Stop a run after the step it is on; a partial report is written.
#[tauri::command]
pub async fn stop_research(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    runs: State<'_, ResearchRuns>,
    run_id: String,
) -> Result<(), String> {
    service::stop(&state, &runs, &run_id).await?;
    // A run that is working announces its own end; this covers the rest.
    if !runs.is_active(&run_id) {
        let status = service::get(&state, &run_id).await?.status;
        app::announce(&app, &run_id, status);
    }
    Ok(())
}

/// Cancel a run waiting for approval; it ends `stopped` having done nothing.
#[tauri::command]
pub async fn cancel_research(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    run_id: String,
) -> Result<(), String> {
    service::cancel(&state, &run_id).await?;
    app::announce(&app, &run_id, ResearchStatus::Stopped);
    Ok(())
}

#[tauri::command]
pub async fn get_research_run(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<ResearchRun, String> {
    service::get(&state, &run_id).await
}
