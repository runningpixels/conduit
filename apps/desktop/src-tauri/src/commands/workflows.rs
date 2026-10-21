//! IPC for workflows: save and edit definitions, run one by hand, and read back
//! what a run did. See `crate::workflows`.

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::agents::library;
use crate::artifact_network::AddressPolicy;
use crate::db::repository::conversations;
use crate::db::repository::workflows::{
    self as repo, WorkflowRecord, WorkflowResult, WorkflowRun, WorkflowRunDetail, WorkflowSchedule,
    WorkflowSummary,
};
use crate::state::AppState;
use crate::stream_manager::StreamManager;
use crate::workflows::{
    actions::{ActionAnswer, ActionRules, Actions, PendingAction},
    ask::{self, PendingQuestion, Questions},
    author::{self, DraftRequest, DraftResult},
    computer, definition,
    permissions::{self, Decision, PendingReview, PermissionView, Reviews},
    runner::{search_backend, Resume, RunBudget, Runner},
    schedule::ScheduleSpec,
    scheduler::{next_run, show_notification, RunningWorkflows, SchedulerWake},
    triggers,
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

/// Parse and validate a definition sent by the renderer, with the user's
/// agents it refers to filled in (the definition itself is saved as sent).
async fn checked_definition(state: &AppState, definition: &Value) -> Result<(), String> {
    let resolved = library::resolve_value(&state.db, &state.encryption, definition).await?;
    definition::check_value(&resolved)
}

/// The problems of a definition as one line each.
fn validate_definition(definition: Value) -> Vec<String> {
    match definition::check_value(&definition) {
        Ok(()) => Vec::new(),
        Err(problems) => problems.lines().map(str::to_string).collect(),
    }
}

/// Everything wrong with a definition, in plain English; empty when it can
/// be saved and run. The editor calls this as the user edits.
#[tauri::command]
pub async fn validate_workflow(
    state: State<'_, AppState>,
    definition: Value,
) -> Result<Vec<String>, String> {
    let resolved = library::resolve_value(&state.db, &state.encryption, &definition).await?;
    Ok(validate_definition(resolved))
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
    checked_definition(&state, &definition).await?;
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
    checked_definition(&state, &definition).await?;
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
        .map_err(|e| e.to_string())?;
    triggers::remove_cursor(&state.paths.root, &id);
    Ok(())
}

/// Run `workflow_id` with the user watching (not gated), from `resume` when
/// given. One run per workflow at a time. Waits for the whole run.
async fn run_manually(
    app: &tauri::AppHandle,
    workflow_id: &str,
    inputs: &HashMap<String, String>,
    trigger: &str,
    resume: Option<&Resume>,
    item: Option<Value>,
) -> Result<WorkflowRunDetail, String> {
    use tauri::Manager;
    let state = app.state::<AppState>();
    let streams = app.state::<StreamManager>();
    let running = app.state::<Arc<RunningWorkflows>>();
    let questions = app.state::<Questions>();
    let actions = app.state::<Actions>();
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
        actions: Some(actions.inner()),
        connectors: Some(connectors.inner()),
        documents: Some(documents.inner()),
    };
    runner
        .run_triggered(workflow_id, inputs, trigger, resume, item)
        .await
}

/// Run a workflow now and return what it did. Waits for the whole run.
#[tauri::command]
pub async fn run_workflow(
    app: tauri::AppHandle,
    id: String,
    inputs: Option<HashMap<String, String>>,
) -> Result<WorkflowRunDetail, String> {
    run_manually(&app, &id, &inputs.unwrap_or_default(), "manual", None, None).await
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
    let mut stored = repo::get_run_inputs(&state.db, &state.encryption, &run_id)
        .await
        .map_err(|e| e.to_string())?;
    // The post or file that started the earlier run is used again.
    let item = stored
        .as_mut()
        .and_then(Value::as_object_mut)
        .and_then(|fields| fields.remove(repo::TRIGGER_ITEM_KEY));
    let inputs: HashMap<String, String> = stored
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let workflow_id = earlier.run.workflow_id.clone();
    let resume = Resume {
        from_step: step_id,
        earlier: earlier.steps,
    };
    run_manually(&app, &workflow_id, &inputs, "rerun", Some(&resume), item).await
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
    let mut runs = repo::list_runs(&state.db, &id, limit.unwrap_or(30).clamp(1, 200))
        .await
        .map_err(|e| e.to_string())?;
    repo::add_trigger_items(&state.db, &state.encryption, &mut runs)
        .await
        .map_err(|e| e.to_string())?;
    repo::add_outputs(&state.db, &state.encryption, &mut runs)
        .await
        .map_err(|e| e.to_string())?;
    Ok(runs)
}

/// Finished runs that saved something (or failed on their own), newest first:
/// across every workflow, or one workflow's with `workflow_id`.
#[tauri::command]
pub async fn list_workflow_results(
    state: State<'_, AppState>,
    workflow_id: Option<String>,
    unread_only: Option<bool>,
    limit: Option<i64>,
) -> Result<Vec<WorkflowResult>, String> {
    repo::list_results(
        &state.db,
        &state.encryption,
        workflow_id.as_deref(),
        unread_only.unwrap_or(false),
        limit.unwrap_or(50).clamp(1, 500),
    )
    .await
    .map_err(|e| e.to_string())
}

/// How many results haven't been opened yet.
#[tauri::command]
pub async fn count_unread_workflow_results(state: State<'_, AppState>) -> Result<i64, String> {
    repo::unread_result_count(&state.db)
        .await
        .map_err(|e| e.to_string())
}

/// Mark runs as seen: `run_ids`, or with none, every run of `workflow_id`
/// (every run when that is missing too). Returns how many changed.
#[tauri::command]
pub async fn mark_workflow_runs_seen(
    state: State<'_, AppState>,
    run_ids: Vec<String>,
    workflow_id: Option<String>,
) -> Result<u64, String> {
    repo::mark_seen(&state.db, &run_ids, workflow_id.as_deref())
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
    let Some(mut schedule) = repo::get_schedule(&state.db, &id)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(None);
    };
    // A trigger schedule says what it watches and whether it is stuck.
    if serde_json::from_value::<ScheduleSpec>(schedule.spec.clone()).ok()
        == Some(ScheduleSpec::Trigger)
    {
        if let Some(workflow) = repo::get(&state.db, &state.encryption, &id)
            .await
            .map_err(|e| e.to_string())?
        {
            let def =
                serde_json::from_value::<definition::WorkflowDefinition>(workflow.definition).ok();
            schedule.watch = def.as_ref().and_then(|def| {
                def.trigger.as_ref().map(|trigger| {
                    triggers::watch_status(&state.paths.root, &id, trigger, def.folder.as_deref())
                })
            });
        }
    }
    Ok(Some(schedule))
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
    // Turning a trigger off or on again starts it afresh: the first look
    // after it is on only notes what is already there.
    let was_watching = repo::get_schedule(&state.db, &id)
        .await
        .map_err(|e| e.to_string())?
        .is_some_and(|s| s.enabled && s.spec["kind"] == "trigger");
    let Some(spec_value) = spec else {
        repo::delete_schedule(&state.db, &id)
            .await
            .map_err(|e| e.to_string())?;
        triggers::remove_cursor(&state.paths.root, &id);
        wake.poke();
        return Ok(None);
    };
    let spec: ScheduleSpec = serde_json::from_value(spec_value.clone())
        .map_err(|e| format!("The schedule can't be read: {e}"))?;
    spec.validate()?;
    let next = if !enabled {
        None
    } else if spec == ScheduleSpec::Trigger {
        let workflow = repo::get(&state.db, &state.encryption, &id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "That workflow no longer exists.".to_string())?;
        let watched = serde_json::from_value::<definition::WorkflowDefinition>(workflow.definition)
            .ok()
            .and_then(|def| def.trigger);
        if watched.is_none() {
            return Err(
                "This workflow has nothing to watch. Choose what starts it first.".to_string(),
            );
        }
        // The first look, right away, is the baseline.
        Some(crate::workflows::scheduler::to_iso(chrono::Utc::now()))
    } else {
        Some(next_run(&spec, chrono::Utc::now(), &chrono::Local)?)
    };
    if spec != ScheduleSpec::Trigger || !enabled || !was_watching {
        triggers::remove_cursor(&state.paths.root, &id);
    }
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
        assert!(validate_definition(ok).is_empty());
        let bad = json!({ "steps": [
            { "id": "a", "type": "template", "template": "{{steps.b.text}}" },
            { "id": "a", "type": "template", "template": "x" }
        ]});
        let problems = validate_definition(bad);
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert!(validate_definition(json!({ "steps": "nope" }))[0].contains("can't be read"));
    }

    #[test]
    fn validate_workflow_rejects_unknown_settings_and_explains_step_types() {
        let wrong_case = json!({ "steps": [
            { "id": "fetch", "type": "fetch_page", "urls": ["https://a.test"], "on_error": "skip" }
        ]});
        assert_eq!(
            validate_definition(wrong_case),
            vec!["Step \"fetch\": unknown setting \"on_error\" \u{2014} did you mean \"onError\"?"]
        );
        let bad_type = json!({ "steps": [{ "id": "a", "type": "launch_rockets" }] });
        let problems = validate_definition(bad_type);
        assert!(
            problems[0].contains("\"launch_rockets\" isn't a step type. Use one of: fetch_page")
        );
        let escaped =
            json!({ "steps": [{ "id": "a", "type": "template", "template": "{{ \"x\" }}" }] });
        assert!(validate_definition(escaped)[0].contains("put a backslash before it"));
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
    let mut def: definition::WorkflowDefinition = serde_json::from_value(workflow.definition)
        .map_err(|e| format!("The workflow definition can't be read: {e}"))?;
    // The user's agents it uses count as its helpers: what they may do is
    // approved with the rest.
    library::resolve(&state.db, &state.encryption, &mut def).await?;
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

/// Answer a paused run: `allowOnce`, `alwaysAllow` or `deny`. A run whose
/// steps run side by side can wait on several; `step_id` says which, and may be
/// left out when the run waits on one thing. `false` when it is no longer
/// waiting (answered, stopped, or expired), or `step_id` is missing and the
/// run waits on more than one.
#[tauri::command]
pub fn answer_workflow_review(
    reviews: State<'_, Reviews>,
    run_id: String,
    decision: Decision,
    step_id: Option<String>,
) -> bool {
    reviews.answer(&run_id, step_id.as_deref(), decision)
}

/// Runs waiting at an "Ask me" step, oldest first.
#[tauri::command]
pub fn list_workflow_questions(questions: State<'_, Questions>) -> Vec<PendingQuestion> {
    questions.list()
}

/// Answer a run waiting at an "Ask me" step. A run whose steps run side by
/// side can ask several questions at once; `step_id` says which, and may be
/// left out when the run asks one. `Ok(false)` when it is no longer waiting
/// (or `step_id` is missing and several questions are open); `Err` when the
/// answer won't do (empty, or not one of the choices).
#[tauri::command]
pub fn answer_workflow_question(
    questions: State<'_, Questions>,
    run_id: String,
    answer: String,
    step_id: Option<String>,
) -> Result<bool, String> {
    let Some(pending) = questions.get(&run_id, step_id.as_deref()) else {
        return Ok(false);
    };
    let answer = ask::checked_answer(&pending, &answer)?;
    Ok(questions.answer(&run_id, Some(&pending.step_id), answer))
}

/// Outside actions waiting for the user to check them, oldest first.
#[tauri::command]
pub fn list_workflow_actions(actions: State<'_, Actions>) -> Vec<PendingAction> {
    actions.list()
}

/// Answer an outside action a run waits on: send it (with changed arguments,
/// and "don't ask again" when `remember`) or not. `Ok(false)` when it is no
/// longer waiting; `Err` when the changed arguments won't do.
#[tauri::command]
pub fn answer_workflow_action(
    actions: State<'_, Actions>,
    run_id: String,
    step_id: String,
    answer: ActionAnswer,
) -> Result<bool, String> {
    if actions.get(&run_id, Some(&step_id)).is_none() {
        return Ok(false);
    }
    // A command rule to remember must be one, so the card can say what's wrong.
    if let Some(rule) = answer
        .rule
        .as_deref()
        .filter(|_| answer.remember && answer.send)
    {
        computer::parse_rule(rule).map_err(|e| format!("\u{201c}{rule}\u{201d}: {e}"))?;
    }
    let answer = ActionAnswer {
        arguments: answer
            .arguments
            .map(crate::workflows::actions::checked_arguments)
            .transpose()?,
        ..answer
    };
    Ok(actions.answer(&run_id, Some(&step_id), answer))
}

/// Which outside actions `id` takes without asking.
#[tauri::command]
pub async fn get_workflow_action_rules(
    state: State<'_, AppState>,
    id: String,
) -> Result<ActionRules, String> {
    repo::get_action_rules(&state.db, &state.encryption, &id)
        .await
        .map_err(|e| e.to_string())
}

/// Replace which outside actions `id` takes without asking.
#[tauri::command]
pub async fn set_workflow_action_rules(
    state: State<'_, AppState>,
    id: String,
    rules: Value,
) -> Result<ActionRules, String> {
    repo::get(&state.db, &state.encryption, &id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "That workflow no longer exists.".to_string())?;
    let mut parsed: ActionRules = serde_json::from_value(rules.clone())
        .map_err(|e| format!("The rules can't be read: {e}"))?;
    // A caller that only changes the outside-action rules leaves the command
    // rules as they are.
    let stored = repo::get_action_rules(&state.db, &state.encryption, &id)
        .await
        .map_err(|e| e.to_string())?
        .commands;
    if rules.get("commands").is_none() {
        parsed.commands = stored;
    } else {
        // The UI sends the rules without how often they were used.
        parsed.commands.keep_uses(&stored);
    }
    for list in [&mut parsed.commands.allow, &mut parsed.commands.deny] {
        *list = list
            .iter()
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty())
            .collect();
        for rule in list.iter() {
            computer::parse_rule(rule).map_err(|e| format!("\u{201c}{rule}\u{201d}: {e}"))?;
        }
    }
    repo::set_action_rules(&state.db, &state.encryption, &id, &parsed)
        .await
        .map_err(|e| e.to_string())?;
    Ok(parsed)
}

/// What a command rule covers, for the editor: example commands it would and
/// wouldn't match, or why it isn't a rule.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRulePreview {
    pub error: Option<String>,
    pub covers: Vec<String>,
    pub does_not_cover: Vec<String>,
}

/// How many recent runs [`suggest_command_rules`] looks through.
const SUGGESTION_RUNS: i64 = 10;

/// Rules worth adding to `id`: commands its recent runs asked about and the
/// user approved by hand, grouped by the rule that would have covered them.
#[tauri::command]
pub async fn suggest_command_rules(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<computer::RuleSuggestion>, String> {
    let rules = repo::get_action_rules(&state.db, &state.encryption, &id)
        .await
        .map_err(|e| e.to_string())?;
    let runs = repo::list_runs(&state.db, &id, SUGGESTION_RUNS)
        .await
        .map_err(|e| e.to_string())?;
    let mut records: Vec<Value> = Vec::new();
    for run in runs {
        let Some(detail) = repo::get_run(&state.db, &state.encryption, &run.id)
            .await
            .map_err(|e| e.to_string())?
        else {
            continue;
        };
        for step in detail.steps {
            if let Some(list) = step
                .output
                .as_ref()
                .and_then(|o| o.get("computer"))
                .and_then(Value::as_array)
            {
                records.extend(list.iter().cloned());
            }
        }
    }
    Ok(computer::suggestions(&records, &rules.commands))
}

#[tauri::command]
pub fn preview_command_rule(rule: String) -> CommandRulePreview {
    match computer::rule_examples(&rule) {
        Ok((covers, does_not_cover)) => CommandRulePreview {
            error: None,
            covers,
            does_not_cover,
        },
        Err(error) => CommandRulePreview {
            error: Some(error),
            covers: Vec::new(),
            does_not_cover: Vec::new(),
        },
    }
}

/// Days of work the Agents page totals.
const AGENT_ACTIVITY_DAYS: i64 = 30;

/// An agent on the Agents page: an agent step or a helper of a workflow, and
/// what it has been doing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEntry {
    pub workflow_id: String,
    pub workflow_name: String,
    /// `step` or `helper`.
    pub kind: String,
    /// The step's or the helper's id.
    pub agent_id: String,
    /// For a helper that is one of the user's agents: its library id (the
    /// same as `agent_id`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub library: Option<String>,
    /// A helper's name; empty for a step (the page names it).
    pub name: String,
    /// A helper's instructions, or the step's instruction.
    pub about: String,
    /// Its own model, when it names one.
    pub model: Option<definition::ModelChoice>,
    pub tools: Vec<String>,
    /// The helpers it may hand tasks to, by name.
    pub hands_to: Vec<String>,
    /// The task it is working on now, and in which run.
    pub current_task: Option<String>,
    pub current_run_id: Option<String>,
    pub last_active: Option<String>,
    pub tasks: i64,
    pub failed: i64,
    pub tokens: i64,
}

/// Every agent step and helper in the saved workflows, with what each has
/// done in the last [`AGENT_ACTIVITY_DAYS`] days and is doing now.
#[tauri::command]
pub async fn list_agents(state: State<'_, AppState>) -> Result<Vec<AgentEntry>, String> {
    let pool = &state.db;
    let since = (chrono::Utc::now() - chrono::Duration::days(AGENT_ACTIVITY_DAYS))
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let activity = repo::agent_activity(pool, &state.encryption, &since)
        .await
        .map_err(|e| e.to_string())?;
    let library_agents = library::load(pool, &state.encryption).await?;
    let mut out = Vec::new();
    for summary in repo::list(pool).await.map_err(|e| e.to_string())? {
        let Ok(Some(record)) = repo::get(pool, &state.encryption, &summary.id).await else {
            continue;
        };
        let Ok(mut def) =
            serde_json::from_value::<definition::WorkflowDefinition>(record.definition.clone())
        else {
            continue;
        };
        if def.agents.iter().any(|h| h.library.is_some()) {
            library::resolve_with(&library_agents, &mut def);
        }
        let name_of = |id: &String| {
            def.agents
                .iter()
                .find(|h| &h.id == id)
                .map(|h| h.name.trim().to_string())
                .unwrap_or_else(|| id.clone())
        };
        let mut push = |kind: &str,
                        agent_id: &str,
                        name: String,
                        about: String,
                        model: Option<definition::ModelChoice>,
                        tools: Vec<String>,
                        hands_to: Vec<String>| {
            let seen = activity
                .iter()
                .find(|a| a.workflow_id == record.id && a.kind == kind && a.agent_id == agent_id);
            out.push(AgentEntry {
                workflow_id: record.id.clone(),
                workflow_name: record.name.clone(),
                kind: kind.to_string(),
                agent_id: agent_id.to_string(),
                library: (kind == "helper")
                    .then(|| def.agents.iter().find(|h| h.id == agent_id))
                    .flatten()
                    .and_then(|h| h.library.clone()),
                name,
                about,
                model,
                tools,
                hands_to,
                current_task: seen.and_then(|a| a.current_task.clone()),
                current_run_id: seen.and_then(|a| a.current_run_id.clone()),
                last_active: seen.and_then(|a| a.last_active.clone()),
                tasks: seen.map_or(0, |a| a.tasks),
                failed: seen.map_or(0, |a| a.failed),
                tokens: seen.map_or(0, |a| a.tokens),
            });
        };
        fn agent_steps<'s>(steps: &'s [definition::Step], out: &mut Vec<&'s definition::Step>) {
            for step in steps {
                match &step.action {
                    definition::StepAction::Agent { .. } => out.push(step),
                    definition::StepAction::ForEach { steps, .. } => agent_steps(steps, out),
                    _ => {}
                }
            }
        }
        let mut steps = Vec::new();
        agent_steps(&def.steps, &mut steps);
        for step in steps {
            if let definition::StepAction::Agent {
                prompt,
                tools,
                agents,
                ..
            } = &step.action
            {
                push(
                    "step",
                    &step.id,
                    String::new(),
                    prompt.clone(),
                    step.model.clone(),
                    tools.clone(),
                    agents.iter().map(name_of).collect(),
                );
            }
        }
        for helper in &def.agents {
            push(
                "helper",
                &helper.id,
                helper.name.trim().to_string(),
                helper.instructions.clone(),
                helper.model.clone(),
                helper.tools.clone(),
                helper.agents.iter().map(name_of).collect(),
            );
        }
    }
    Ok(out)
}
