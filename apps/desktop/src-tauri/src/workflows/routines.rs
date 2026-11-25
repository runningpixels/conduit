//! Routines: one of the user's agents doing a task on a schedule or when a
//! feed or folder has something new.
//!
//! A routine is an ordinary workflow underneath, so scheduling, catching up,
//! runs, approvals, Results and the agent tree all work as they do for any
//! workflow. Its definition is one agent step run as the agent (its `agent`
//! set to the library id, the task as its prompt), then a step that keeps the
//! answer (a new chat each run, a new document, or a Markdown file) and, when
//! asked, a notification. The agent is optional: a routine without one is a
//! "task", an agent step with the task as its prompt and the plain assistant's
//! tools. The `routine` column only says where it is listed; turning it into
//! a workflow clears it and keeps the definition.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::definition::{self, ModelChoice, Trigger, WorkflowDefinition};
use super::schedule::ScheduleSpec;
use crate::db::repository::workflows::{self as repo, WorkflowRecord};
use crate::state::AppState;

/// Longest task a routine is given.
pub const MAX_TASK_CHARS: usize = 4000;
/// Longest routine name (a workflow's).
const MAX_NAME_CHARS: usize = 120;

/// Where a routine's answer goes each run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RoutineOutput {
    /// A new chat in the history, titled with the routine's name and the
    /// date, that the user can open and reply to.
    #[default]
    Chat,
    /// A new document in Results, titled with the routine's name and the date.
    Document,
    /// A Markdown file in the app's exports folder.
    File,
}

/// What the routine form sends.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineRequest {
    /// The library agent that does the task; none (or empty) for the plain
    /// assistant.
    #[serde(default)]
    pub agent_id: Option<String>,
    /// The model for the task; without one, the agent's, else the default.
    #[serde(default)]
    pub model: Option<ModelChoice>,
    pub name: String,
    /// What to do each run, in words; used as written (not a template).
    pub task: String,
    /// When it runs: a time schedule, or `trigger` with [`Self::trigger`].
    pub schedule: ScheduleSpec,
    /// What starts it, for a `trigger` schedule: a feed or the folder.
    #[serde(default)]
    pub trigger: Option<Trigger>,
    /// Also show a notification when a run finishes.
    #[serde(default)]
    pub notify: bool,
    #[serde(default)]
    pub output: RoutineOutput,
    /// The folder it may work in (needed for a folder trigger, or an agent
    /// that uses the computer).
    #[serde(default)]
    pub folder: Option<String>,
}

/// One routine, for its agent's card.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutineSummary {
    pub workflow_id: String,
    /// The agent that does it; `None` for a task (the plain assistant).
    pub agent_id: Option<String>,
    pub name: String,
    pub task: String,
    /// The stored schedule spec; `None` when it has none.
    pub schedule: Option<Value>,
    /// What starts it, for a `trigger` schedule.
    pub trigger: Option<Trigger>,
    pub folder: Option<String>,
    pub enabled: bool,
    pub next_run_at: Option<String>,
    pub last_run_id: Option<String>,
    pub last_run_status: Option<String>,
    pub last_run_at: Option<String>,
    /// What its latest run saved, when it saved something.
    pub last_result_title: Option<String>,
}

/// One row of the Scheduled page: a task (a routine without an agent), a
/// routine (an agent's), or a workflow that has a schedule or a trigger.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledItem {
    pub workflow_id: String,
    /// `task`, `routine` or `workflow`.
    pub kind: String,
    pub name: String,
    /// What it does each run, for a task or routine.
    pub task: Option<String>,
    pub agent_id: Option<String>,
    /// The stored schedule spec; `None` when it has none.
    pub schedule: Option<Value>,
    pub trigger: Option<Trigger>,
    pub enabled: bool,
    pub next_run_at: Option<String>,
    pub last_run_id: Option<String>,
    pub last_run_status: Option<String>,
    pub last_run_at: Option<String>,
    /// What its latest run saved, when it saved something.
    pub last_result_title: Option<String>,
    /// The chat its latest run saved, if it saved one.
    pub last_conversation_id: Option<String>,
    /// The document its latest run saved, if it saved one.
    pub last_artifact_id: Option<String>,
}

/// Write `text` so a template shows it as it is.
fn literal(text: &str) -> String {
    text.replace("{{", "\\{{").replace("}}", "\\}}")
}

/// A file name made of the routine's name: letters, digits, spaces, `-`, `_`.
fn file_base(name: &str) -> String {
    let kept: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_') {
                c
            } else {
                ' '
            }
        })
        .collect();
    let base = kept.split_whitespace().collect::<Vec<_>>().join(" ");
    let base: String = base.chars().take(80).collect();
    if base.trim().is_empty() {
        "Routine".to_string()
    } else {
        base.trim().to_string()
    }
}

/// The definition a routine is stored as (see the module docs).
pub fn definition_for(request: &RoutineRequest) -> Result<Value, String> {
    let name = request.name.trim();
    let task = request.task.trim();
    if task.is_empty() {
        return Err("Say what the agent should do each time.".to_string());
    }
    if task.chars().count() > MAX_TASK_CHARS {
        return Err(format!("Keep the task under {MAX_TASK_CHARS} characters."));
    }
    let agent = request
        .agent_id
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty());
    let trigger = match (&request.schedule, &request.trigger) {
        (ScheduleSpec::Trigger, None) => {
            return Err("Choose what starts it.".to_string());
        }
        (ScheduleSpec::Trigger, Some(Trigger::Connector { .. })) => {
            return Err(
                "A routine can start on a schedule, a new post in a feed, or a new file in a folder."
                    .to_string(),
            );
        }
        (ScheduleSpec::Trigger, Some(trigger)) => Some(trigger.clone()),
        (_, _) => None,
    };
    let mut steps = Vec::new();
    // What started the run is handed to the agent with its task.
    let input = match &trigger {
        Some(Trigger::Feed { .. }) => {
            "New post: {{trigger.title}}\n{{trigger.link}}\n\n{{trigger.summary}}".to_string()
        }
        Some(Trigger::Folder) => {
            steps.push(json!({
                "id": "file",
                "type": "read_file",
                "path": "{{trigger.path}}",
                "onError": "skip"
            }));
            "New file: {{trigger.name}}\n\n{{steps.file.text}}".to_string()
        }
        _ => String::new(),
    };
    let mut work = json!({
        "id": "work",
        "type": "agent",
        "prompt": literal(task),
    });
    match agent {
        Some(agent) => work["agent"] = json!(agent),
        // The plain assistant: the read-only tools every agent step may use.
        None => work["tools"] = json!(definition::AGENT_TOOLS),
    }
    if let Some(model) = &request.model {
        work["model"] = serde_json::to_value(model).map_err(|e| e.to_string())?;
    }
    if !input.is_empty() {
        work["input"] = json!(input);
    }
    steps.push(work);
    let title = format!("{} \u{2014} {{{{run.date}}}}", literal(name));
    steps.push(match request.output {
        RoutineOutput::Chat => json!({
            "id": "save",
            "type": "save_chat",
            "title": title,
            "prompt": literal(task),
            "content": "{{steps.work.text}}"
        }),
        RoutineOutput::Document => json!({
            "id": "save",
            "type": "save_artifact",
            "title": title,
            "content": "{{steps.work.text}}",
            "mode": "create"
        }),
        RoutineOutput::File => json!({
            "id": "save",
            "type": "export_file",
            "name": format!("{} {{{{run.date}}}}.md", literal(&file_base(name))),
            "content": "{{steps.work.text}}"
        }),
    });
    if request.notify {
        steps.push(json!({
            "id": "tell",
            "type": "notify",
            "title": literal(name),
            "body": "{{steps.work.text}}"
        }));
    }
    let mut definition = json!({ "steps": steps });
    if let Some(trigger) = trigger {
        definition["trigger"] = serde_json::to_value(trigger).map_err(|e| e.to_string())?;
    }
    if let Some(folder) = request
        .folder
        .as_deref()
        .map(str::trim)
        .filter(|f| !f.is_empty())
    {
        definition["folder"] = json!(folder);
    }
    Ok(definition)
}

/// The routine's name, trimmed, or why it can't be used.
fn checked_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("A routine needs a name.".to_string());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!("Keep the name under {MAX_NAME_CHARS} characters."));
    }
    Ok(name.to_string())
}

/// The name, schedule and definition of `request`, all checked with the
/// user's agents filled in.
async fn checked(
    state: &AppState,
    request: &RoutineRequest,
) -> Result<(String, Value, Value), String> {
    let name = checked_name(&request.name)?;
    request.schedule.validate()?;
    let definition = definition_for(request)?;
    let resolved =
        crate::agents::library::resolve_value(&state.db, &state.encryption, &definition).await?;
    definition::check_value(&resolved)?;
    let spec = serde_json::to_value(&request.schedule).map_err(|e| e.to_string())?;
    Ok((name, spec, definition))
}

/// Save a new routine: its definition checked with the user's agents filled
/// in, the workflow marked as a routine, and its schedule stored but off
/// (nobody has approved what it may do yet; the caller turns it on).
pub async fn create(state: &AppState, request: &RoutineRequest) -> Result<WorkflowRecord, String> {
    let (name, spec, definition) = checked(state, request).await?;
    let record = repo::create(
        &state.db,
        &state.encryption,
        &name,
        Some(request.task.trim()),
        &definition,
    )
    .await
    .map_err(|e| e.to_string())?;
    repo::set_routine(&state.db, &record.id, true)
        .await
        .map_err(|e| e.to_string())?;
    repo::put_schedule(&state.db, &record.id, &spec, false, None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(record)
}

/// Rewrite a routine from the form again: its name, description (the task),
/// definition and schedule. Its runs stay. The schedule is left **off**, as
/// in [`create`]: what it may do has changed, so the caller shows the
/// approval step again and turns it on.
pub async fn update(
    state: &AppState,
    id: &str,
    request: &RoutineRequest,
) -> Result<WorkflowRecord, String> {
    let is_routine = repo::list(&state.db)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .any(|w| w.id == id && w.routine);
    if !is_routine {
        return Err("That task no longer exists.".to_string());
    }
    let (name, spec, definition) = checked(state, request).await?;
    let record = repo::update(
        &state.db,
        &state.encryption,
        id,
        &name,
        Some(request.task.trim()),
        &definition,
    )
    .await
    .map_err(|e| e.to_string())?;
    repo::put_schedule(&state.db, id, &spec, false, None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(record)
}

/// The agent a routine runs as (none for the plain assistant) and its task:
/// its first agent step.
fn agent_and_task(def: &WorkflowDefinition) -> Option<(Option<String>, String)> {
    def.steps.iter().find_map(|step| match &step.action {
        definition::StepAction::Agent { agent, prompt, .. } => Some((
            agent.clone(),
            prompt.replace("\\{{", "{{").replace("\\}}", "}}"),
        )),
        _ => None,
    })
}

/// The latest run of a workflow and what it saved.
struct LastRun {
    id: String,
    status: String,
    started_at: String,
    /// Title of the first thing it saved.
    title: Option<String>,
    conversation_id: Option<String>,
    artifact_id: Option<String>,
}

async fn last_run(state: &AppState, workflow_id: &str) -> Result<Option<LastRun>, String> {
    let mut runs = repo::list_runs(&state.db, workflow_id, 1)
        .await
        .map_err(|e| e.to_string())?;
    repo::add_outputs(&state.db, &state.encryption, &mut runs)
        .await
        .map_err(|e| e.to_string())?;
    Ok(runs.into_iter().next().map(|run| {
        let outputs = run.outputs.unwrap_or_default();
        LastRun {
            title: outputs.first().map(|o| o.title.clone()),
            conversation_id: outputs
                .iter()
                .find(|o| o.kind == "chat")
                .and_then(|o| o.conversation_id.clone()),
            artifact_id: outputs.iter().find_map(|o| o.artifact_id.clone()),
            id: run.id,
            status: run.status,
            started_at: run.started_at,
        }
    }))
}

/// Every routine, most recently changed first; only `agent_id`'s with one.
pub async fn list(state: &AppState, agent_id: Option<&str>) -> Result<Vec<RoutineSummary>, String> {
    let pool = &state.db;
    let enc = &state.encryption;
    let mut out = Vec::new();
    for summary in repo::list(pool)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|s| s.routine)
    {
        let Some(record) = repo::get(pool, enc, &summary.id)
            .await
            .map_err(|e| e.to_string())?
        else {
            continue;
        };
        let Ok(def) = serde_json::from_value::<WorkflowDefinition>(record.definition) else {
            continue;
        };
        let Some((agent, task)) = agent_and_task(&def) else {
            continue;
        };
        if agent_id.is_some_and(|wanted| agent.as_deref() != Some(wanted)) {
            continue;
        }
        let schedule = repo::get_schedule(pool, &summary.id)
            .await
            .map_err(|e| e.to_string())?;
        let last = last_run(state, &summary.id).await?;
        out.push(RoutineSummary {
            workflow_id: summary.id,
            agent_id: agent,
            name: summary.name,
            task,
            schedule: schedule.as_ref().map(|s| s.spec.clone()),
            trigger: def.trigger,
            folder: def.folder,
            enabled: schedule.as_ref().is_some_and(|s| s.enabled),
            next_run_at: schedule.and_then(|s| s.next_run_at),
            last_result_title: last.as_ref().and_then(|r| r.title.clone()),
            last_run_status: last.as_ref().map(|r| r.status.clone()),
            last_run_at: last.as_ref().map(|r| r.started_at.clone()),
            last_run_id: last.map(|r| r.id),
        });
    }
    Ok(out)
}

/// Everything that runs on its own, for the Scheduled page, most recently
/// changed first: every task and routine, and the workflows that have a
/// schedule (on or off) or a trigger.
pub async fn list_scheduled(state: &AppState) -> Result<Vec<ScheduledItem>, String> {
    let pool = &state.db;
    let enc = &state.encryption;
    let mut out = Vec::new();
    for summary in repo::list(pool).await.map_err(|e| e.to_string())? {
        let Some(record) = repo::get(pool, enc, &summary.id)
            .await
            .map_err(|e| e.to_string())?
        else {
            continue;
        };
        let Ok(def) = serde_json::from_value::<WorkflowDefinition>(record.definition) else {
            continue;
        };
        let schedule = repo::get_schedule(pool, &summary.id)
            .await
            .map_err(|e| e.to_string())?;
        let (kind, task, agent_id) = if summary.routine {
            let Some((agent, task)) = agent_and_task(&def) else {
                continue;
            };
            let kind = if agent.is_some() { "routine" } else { "task" };
            (kind, Some(task), agent)
        } else if schedule.is_some() || def.trigger.is_some() {
            ("workflow", None, None)
        } else {
            continue;
        };
        let last = last_run(state, &summary.id).await?;
        out.push(ScheduledItem {
            workflow_id: summary.id,
            kind: kind.to_string(),
            name: summary.name,
            task,
            agent_id,
            schedule: schedule.as_ref().map(|s| s.spec.clone()),
            trigger: def.trigger,
            enabled: schedule.as_ref().is_some_and(|s| s.enabled),
            next_run_at: schedule.and_then(|s| s.next_run_at),
            last_result_title: last.as_ref().and_then(|r| r.title.clone()),
            last_conversation_id: last.as_ref().and_then(|r| r.conversation_id.clone()),
            last_artifact_id: last.as_ref().and_then(|r| r.artifact_id.clone()),
            last_run_status: last.as_ref().map(|r| r.status.clone()),
            last_run_at: last.as_ref().map(|r| r.started_at.clone()),
            last_run_id: last.map(|r| r.id),
        });
    }
    Ok(out)
}

/// Turn a routine into an ordinary workflow: it keeps its definition,
/// schedule and runs, and shows in the Workflows list from now on.
pub async fn convert_to_workflow(state: &AppState, id: &str) -> Result<(), String> {
    if repo::get(&state.db, &state.encryption, id)
        .await
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Err("That workflow no longer exists.".to_string());
    }
    repo::set_routine(&state.db, id, false)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(schedule: ScheduleSpec) -> RoutineRequest {
        RoutineRequest {
            agent_id: Some("researcher".into()),
            model: None,
            name: "Energy brief".into(),
            task: "Brief me on EU energy prices since yesterday".into(),
            schedule,
            trigger: None,
            notify: false,
            output: RoutineOutput::Document,
            folder: None,
        }
    }

    fn weekdays() -> ScheduleSpec {
        ScheduleSpec::Weekdays {
            time: "08:00".into(),
        }
    }

    #[test]
    fn a_routine_is_an_agent_step_run_as_the_agent_then_a_new_document_each_run() {
        let def = definition_for(&request(weekdays())).unwrap();
        assert_eq!(
            def,
            json!({ "steps": [
                { "id": "work", "type": "agent", "agent": "researcher",
                  "prompt": "Brief me on EU energy prices since yesterday" },
                { "id": "save", "type": "save_artifact",
                  "title": "Energy brief \u{2014} {{run.date}}",
                  "content": "{{steps.work.text}}", "mode": "create" }
            ]})
        );
        assert!(
            definition::check_value(&def).is_err(),
            "the agent is filled in first"
        );
    }

    #[test]
    fn a_task_has_no_agent_and_saves_a_chat_by_default() {
        let mut asked = request(weekdays());
        asked.agent_id = Some("  ".into());
        asked.output = RoutineOutput::default();
        asked.model = Some(ModelChoice {
            provider: "openrouter".into(),
            model: "glm".into(),
        });
        let def = definition_for(&asked).unwrap();
        assert_eq!(
            def,
            json!({ "steps": [
                { "id": "work", "type": "agent",
                  "prompt": "Brief me on EU energy prices since yesterday",
                  "tools": ["web_search", "web_fetch", "current_time", "calculator"],
                  "model": { "provider": "openrouter", "model": "glm" } },
                { "id": "save", "type": "save_chat",
                  "title": "Energy brief \u{2014} {{run.date}}",
                  "prompt": "Brief me on EU energy prices since yesterday",
                  "content": "{{steps.work.text}}" }
            ]})
        );
        // Valid as it stands: no agent to fill in.
        definition::check_value(&def).unwrap();
        let parsed: WorkflowDefinition = serde_json::from_value(def).unwrap();
        assert_eq!(
            agent_and_task(&parsed),
            Some((None, "Brief me on EU energy prices since yesterday".into()))
        );
    }

    #[test]
    fn an_agent_routine_sets_the_step_model_only_when_given() {
        let mut asked = request(weekdays());
        assert!(definition_for(&asked).unwrap()["steps"][0]
            .get("model")
            .is_none());
        asked.model = Some(ModelChoice {
            provider: "p".into(),
            model: "m".into(),
        });
        let def = definition_for(&asked).unwrap();
        assert_eq!(def["steps"][0]["agent"], "researcher");
        assert_eq!(def["steps"][0]["model"]["model"], "m");
        assert!(def["steps"][0].get("tools").is_none());
    }

    #[test]
    fn requests_read_from_the_form_without_an_agent() {
        let asked: RoutineRequest = serde_json::from_value(json!({
            "name": "Daily", "task": "Do it",
            "schedule": { "kind": "once", "at": "2030-01-01T09:00" }
        }))
        .unwrap();
        assert_eq!(asked.agent_id, None);
        assert_eq!(asked.output, RoutineOutput::Chat);
        assert_eq!(
            serde_json::to_value(RoutineOutput::Chat).unwrap(),
            json!("chat")
        );
    }

    #[test]
    fn notify_adds_a_notification_and_file_output_writes_markdown() {
        let mut asked = request(ScheduleSpec::Interval { hours: 4 });
        asked.notify = true;
        asked.output = RoutineOutput::File;
        asked.name = "Prices: EU/UK".into();
        let def = definition_for(&asked).unwrap();
        let steps = def["steps"].as_array().unwrap();
        assert_eq!(steps[1]["type"], "export_file");
        assert_eq!(steps[1]["name"], "Prices EU UK {{run.date}}.md");
        assert_eq!(steps[2]["type"], "notify");
        assert_eq!(steps[2]["title"], "Prices: EU/UK");
    }

    #[test]
    fn braces_in_the_task_and_name_stay_as_written() {
        let mut asked = request(weekdays());
        asked.task = "Fill in {{this}}".into();
        asked.name = "A {{b}}".into();
        let def = definition_for(&asked).unwrap();
        assert_eq!(def["steps"][0]["prompt"], "Fill in \\{{this\\}}");
        let parsed: WorkflowDefinition = serde_json::from_value(def).unwrap();
        assert_eq!(
            agent_and_task(&parsed),
            Some((Some("researcher".into()), "Fill in {{this}}".into()))
        );
    }

    #[test]
    fn a_folder_trigger_reads_the_new_file_and_a_feed_hands_over_the_post() {
        let mut asked = request(ScheduleSpec::Trigger);
        asked.trigger = Some(Trigger::Folder);
        asked.folder = Some("C:\\inbox".into());
        let def = definition_for(&asked).unwrap();
        assert_eq!(def["trigger"], json!({ "kind": "folder" }));
        assert_eq!(def["folder"], "C:\\inbox");
        assert_eq!(def["steps"][0]["type"], "read_file");
        assert!(def["steps"][1]["input"]
            .as_str()
            .unwrap()
            .contains("{{steps.file.text}}"));

        asked.trigger = Some(Trigger::Feed {
            url: "https://example.com/feed".into(),
            every_minutes: 30,
        });
        let def = definition_for(&asked).unwrap();
        assert_eq!(def["steps"][0]["type"], "agent");
        assert!(def["steps"][0]["input"]
            .as_str()
            .unwrap()
            .contains("{{trigger.title}}"));
    }

    #[test]
    fn a_routine_needs_a_task_and_something_to_start_it() {
        let mut asked = request(weekdays());
        asked.task = "  ".into();
        assert!(definition_for(&asked).is_err());
        assert!(definition_for(&request(ScheduleSpec::Trigger)).is_err());
    }
}
