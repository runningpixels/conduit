//! IPC for workflows: save and edit definitions, run one by hand, and read back
//! what a run did. See `crate::workflows`.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::artifact_network::AddressPolicy;
use crate::db::repository::conversations;
use crate::db::repository::workflows::{
    self as repo, WorkflowRecord, WorkflowRun, WorkflowRunDetail, WorkflowSchedule, WorkflowSummary,
};
use crate::state::AppState;
use crate::stream_manager::StreamManager;
use crate::workflows::{
    ask::{self, PendingQuestion, Questions},
    author::{self, DraftRequest, DraftResult},
    definition,
    permissions::{self, Decision, PendingReview, PermissionView, Reviews},
    runner::{search_backend, Resume, RunBudget, Runner},
    schedule::ScheduleSpec,
    scheduler::{next_run, show_notification, RunningWorkflows, SchedulerWake},
};

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
    definition::check_value(definition)
}

/// Everything wrong with a definition, in plain English; empty when it can
/// be saved and run. The editor calls this as the user edits.
#[tauri::command]
pub fn validate_workflow(definition: Value) -> Vec<String> {
    match checked_definition(&definition) {
        Ok(()) => Vec::new(),
        Err(problems) => problems.lines().map(str::to_string).collect(),
    }
}

/// Draft a workflow from a description with the chat's model. Nothing is
/// saved; the result opens in the editor as an unsaved draft. Waits for the
/// model (up to 90 seconds); `cancel_workflow_draft` stops it.
#[tauri::command]
pub async fn draft_workflow(
    state: State<'_, AppState>,
    streams: State<'_, StreamManager>,
    description: String,
) -> Result<DraftResult, String> {
    author::draft_cancellable(
        &state,
        &streams,
        DraftRequest {
            description,
            transcript: None,
        },
    )
    .await
}

/// Draft a workflow from what happened in a chat: what the user asked and
/// which tools were used (never tool outputs or document text), secrets removed.
#[tauri::command]
pub async fn draft_workflow_from_chat(
    state: State<'_, AppState>,
    streams: State<'_, StreamManager>,
    conversation_id: String,
    description: Option<String>,
) -> Result<DraftResult, String> {
    let transcript = author::chat_transcript(&state, &conversation_id).await?;
    let description = description
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| author::DEFAULT_CHAT_REQUEST.to_string());
    author::draft_cancellable(
        &state,
        &streams,
        DraftRequest {
            description,
            transcript: Some(transcript),
        },
    )
    .await
}

/// Stop the draft in progress; `false` when none was running. The waiting
/// `draft_workflow` call then fails with "Drafting was stopped."
#[tauri::command]
pub fn cancel_workflow_draft() -> bool {
    author::cancel_current()
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

/// Run `workflow_id` with the user watching (not gated), from `resume` when
/// given. One run per workflow at a time. Waits for the whole run.
async fn run_manually(
    app: &tauri::AppHandle,
    workflow_id: &str,
    inputs: &HashMap<String, String>,
    trigger: &str,
    resume: Option<&Resume>,
) -> Result<WorkflowRunDetail, String> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let streams = app.state::<StreamManager>();
    let running = app.state::<Arc<RunningWorkflows>>();
    let questions = app.state::<Questions>();
    let documents = app.state::<crate::workflows::documents::DocumentChanges>();
    let connectors = app.state::<crate::connector_runtime::ConnectorRuntimeManager>();
    let guard = running
        .try_start(workflow_id)
        .ok_or_else(|| "This workflow is already running.".to_string())?;
    let notify = |title: &str, body: &str| show_notification(app, title, body);
    let runner = Runner {
        state: state.inner(),
        streams: streams.inner(),
        fetch_policy: AddressPolicy::APP,
        stop: guard.stop_token(),
        unattended: None,
        budget: RunBudget::default(),
        notify: Some(&notify),
        questions: Some(questions.inner()),
        connectors: Some(connectors.inner()),
        documents: Some(documents.inner()),
    };
    runner.run_from(workflow_id, inputs, trigger, resume).await
}

/// Run a workflow now and return what it did. Waits for the whole run.
#[tauri::command]
pub async fn run_workflow(
    app: tauri::AppHandle,
    id: String,
    inputs: Option<HashMap<String, String>>,
) -> Result<WorkflowRunDetail, String> {
    run_manually(&app, &id, &inputs.unwrap_or_default(), "manual", None).await
}

/// Run a workflow again from `step_id`, reusing what an earlier run did
/// before that step (and the values it was started with). Waits for the run.
#[tauri::command]
pub async fn rerun_workflow_from(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    step_id: String,
) -> Result<WorkflowRunDetail, String> {
    let earlier = repo::get_run(&state.db, &state.encryption, &run_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That run no longer exists.".to_string())?;
    let inputs: HashMap<String, String> =
        repo::get_run_inputs(&state.db, &state.encryption, &run_id)
            .await
            .map_err(|e| e.to_string())?
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default();
    let workflow_id = earlier.run.workflow_id.clone();
    let resume = Resume {
        from_step: step_id,
        earlier: earlier.steps,
    };
    run_manually(&app, &workflow_id, &inputs, "rerun", Some(&resume)).await
}

/// Stop a workflow's run in progress. The run ends as `stopped` after the
/// step it is on; `false` when it wasn't running.
#[tauri::command]
pub fn stop_workflow_run(running: State<'_, Arc<RunningWorkflows>>, id: String) -> bool {
    running.stop(&id)
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

#[tauri::command]
pub async fn get_workflow_schedule(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<WorkflowSchedule>, String> {
    repo::get_schedule(&state.db, &id)
        .await
        .map_err(|e| e.to_string())
}

/// Set a workflow's schedule (`spec: null` removes it). The next run is worked
/// out in the user's time zone; the scheduler is woken so it takes effect now.
#[tauri::command]
pub async fn set_workflow_schedule(
    state: State<'_, AppState>,
    wake: State<'_, SchedulerWake>,
    id: String,
    spec: Option<Value>,
    enabled: bool,
) -> Result<Option<WorkflowSchedule>, String> {
    if repo::get(&state.db, &state.encryption, &id)
        .await
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Err("That workflow no longer exists.".to_string());
    }
    let Some(spec_value) = spec else {
        repo::delete_schedule(&state.db, &id)
            .await
            .map_err(|e| e.to_string())?;
        wake.poke();
        return Ok(None);
    };
    let spec: ScheduleSpec = serde_json::from_value(spec_value.clone())
        .map_err(|e| format!("The schedule can't be read: {e}"))?;
    spec.validate()?;
    let next = if enabled {
        Some(next_run(&spec, chrono::Utc::now(), &chrono::Local)?)
    } else {
        None
    };
    let saved = repo::put_schedule(&state.db, &id, &spec_value, enabled, next.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    wake.poke();
    Ok(Some(saved))
}

/// Longest notification title / body accepted from the renderer.
const MAX_NOTIFY_TITLE: usize = 120;
const MAX_NOTIFY_BODY: usize = 400;

/// Show a desktop notification for a finished scheduled run. The renderer
/// builds the text (it holds the translations); Rust shows it, so the webview
/// needs no notification permission. Text is trimmed to fixed lengths.
#[tauri::command]
pub fn notify_workflow_run(
    app: tauri::AppHandle,
    title: String,
    body: String,
) -> Result<(), String> {
    let clip = |s: &str, max: usize| s.trim().chars().take(max).collect::<String>();
    let title = clip(&title, MAX_NOTIFY_TITLE);
    if title.is_empty() {
        return Err("A notification needs a title.".to_string());
    }
    show_notification(&app, &title, &clip(&body, MAX_NOTIFY_BODY))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn validate_workflow_lists_each_problem_or_nothing() {
        let ok = json!({ "steps": [{ "id": "a", "type": "template", "template": "hi" }] });
        assert!(validate_workflow(ok).is_empty());
        let bad = json!({ "steps": [
            { "id": "a", "type": "template", "template": "{{steps.b.text}}" },
            { "id": "a", "type": "template", "template": "x" }
        ]});
        let problems = validate_workflow(bad);
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert!(validate_workflow(json!({ "steps": "nope" }))[0].contains("can't be read"));
    }

    #[test]
    fn validate_workflow_rejects_unknown_settings_and_explains_step_types() {
        let wrong_case = json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": ["https://a.test"], "on_error": "skip" }
        ]});
        assert_eq!(
            validate_workflow(wrong_case),
            vec!["Step \"fetch\": unknown setting \"on_error\" \u{2014} did you mean \"onError\"?"]
        );
        let bad_type = json!({ "steps": [{ "id": "a", "type": "launch_rockets" }] });
        let problems = validate_workflow(bad_type);
        assert!(
            problems[0].contains("\"launch_rockets\" isn't a step type. Use one of: fetch_page")
        );
        let escaped =
            json!({ "steps": [{ "id": "a", "type": "template", "template": "{{ \"x\" }}" }] });
        assert!(validate_workflow(escaped)[0].contains("put a backslash before it"));
    }
}

/// What a workflow needs to run on its own, and what of that isn't approved.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPermissions {
    /// Everything it will be allowed to do, with today's settings.
    pub required: Vec<PermissionView>,
    /// What of `required` the user hasn't approved (empty when all is).
    pub missing: Vec<PermissionView>,
    /// When the user last approved; `None` if never.
    pub approved_at: Option<String>,
}

async fn workflow_permissions(state: &AppState, id: &str) -> Result<WorkflowPermissions, String> {
    let workflow = repo::get(&state.db, &state.encryption, id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That workflow no longer exists.".to_string())?;
    let def: definition::WorkflowDefinition = serde_json::from_value(workflow.definition)
        .map_err(|e| format!("The workflow definition can't be read: {e}"))?;
    let settings = state.settings()?;
    let backend = search_backend(&settings);
    // The live provider registry, as a run uses it: a step whose chosen
    // provider isn't set up counts as using the active one.
    let configured = |provider: &str| {
        provider_core::get_adapter(provider).is_some()
            && StreamManager::build_adapter_context(state, provider).is_ok()
    };
    let titles = permissions::collection_titles(&state.db, &def).await;
    let collection_title = |id: &str| titles.get(id).cloned();
    let names = permissions::connector_names(&state.db, &def).await;
    let connector_name = |id: &str| names.get(id).cloned();
    let required = permissions::required(
        &def,
        &permissions::Context {
            search_backend: &backend,
            provider: &settings.active_provider,
            model: &settings.active_model,
            configured: Some(&configured),
            collection_title: Some(&collection_title),
            connector_name: Some(&connector_name),
        },
    );
    let stored = repo::get_permissions(&state.db, &state.encryption, id)
        .await
        .map_err(|e| e.to_string())?;
    let approved = stored
        .as_ref()
        .map(|(list, _)| list.iter().cloned().collect())
        .unwrap_or_default();
    let missing = permissions::missing(&required, &approved);
    Ok(WorkflowPermissions {
        required: required.into_iter().map(permissions::view).collect(),
        missing: missing.into_iter().map(permissions::view).collect(),
        approved_at: stored.map(|(_, at)| at),
    })
}

/// What the workflow would be allowed to do on its own, for the approval
/// shown when a schedule is turned on.
#[tauri::command]
pub async fn get_workflow_permissions(
    state: State<'_, AppState>,
    id: String,
) -> Result<WorkflowPermissions, String> {
    workflow_permissions(&state, &id).await
}

/// Approve everything the workflow needs now; what it no longer needs is
/// dropped from the approval.
#[tauri::command]
pub async fn approve_workflow_permissions(
    state: State<'_, AppState>,
    id: String,
) -> Result<WorkflowPermissions, String> {
    let current = workflow_permissions(&state, &id).await?;
    let approved: Vec<_> = current
        .required
        .into_iter()
        .map(|view| view.permission)
        .collect();
    repo::set_permissions(&state.db, &state.encryption, &id, &approved)
        .await
        .map_err(|e| e.to_string())?;
    workflow_permissions(&state, &id).await
}

/// Scheduled runs waiting for the user, oldest first.
#[tauri::command]
pub fn list_workflow_reviews(reviews: State<'_, Reviews>) -> Vec<PendingReview> {
    reviews.list()
}

/// Answer a paused run: `allowOnce`, `alwaysAllow` or `deny`. `false` when it
/// is no longer waiting (answered, stopped, or expired).
#[tauri::command]
pub fn answer_workflow_review(
    reviews: State<'_, Reviews>,
    run_id: String,
    decision: Decision,
) -> bool {
    reviews.answer(&run_id, decision)
}

/// Runs waiting at an "Ask me" step, oldest first.
#[tauri::command]
pub fn list_workflow_questions(questions: State<'_, Questions>) -> Vec<PendingQuestion> {
    questions.list()
}

/// Answer a run waiting at an "Ask me" step. `Ok(false)` when it is no longer
/// waiting; `Err` when the answer won't do (empty, or not one of the choices).
#[tauri::command]
pub fn answer_workflow_question(
    questions: State<'_, Questions>,
    run_id: String,
    answer: String,
) -> Result<bool, String> {
    let Some(pending) = questions.get(&run_id) else {
        return Ok(false);
    };
    let answer = ask::checked_answer(&pending, &answer)?;
    Ok(questions.answer(&run_id, answer))
}
