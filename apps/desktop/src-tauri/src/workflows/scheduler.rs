//! Runs scheduled workflows while Conduit is open.
//!
//! A single background task ([`scheduler_loop`]) sleeps until the next schedule
//! is due, runs whatever is due ([`run_due`]), and tells the renderer each run
//! finished (the `workflow-run-finished` event), which shows a notification in
//! the user's language and refreshes the Workflows page. It lives in Rust, not
//! behind a timer in the page, so it doesn't depend on the window — the tray
//! work keeps it running with the window closed.
//!
//! - Missed runs coalesce: after a run (or on launch after being closed), the
//!   next time is computed from *now*, so a workflow missed three mornings runs
//!   once, marked `catch_up`.
//! - The next time is saved before the run starts, so a crash mid-run can't
//!   make the same schedule fire again and again.
//! - One run per workflow at a time: [`RunningWorkflows`] is shared with "Run
//!   now", and a schedule that comes due while its workflow is running skips
//!   that slot.
//! - The loop wakes at least once a minute, which covers the computer sleeping
//!   past a due time, and at once when a schedule changes ([`SchedulerWake`]).

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration as ChronoDuration, Local, TimeZone, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

use super::runner::Runner;
use super::schedule::ScheduleSpec;
use crate::artifact_network::AddressPolicy;
use crate::db::repository::workflows as repo;
use crate::state::AppState;
use crate::stream_manager::StreamManager;

/// Event the renderer listens for.
pub const RUN_FINISHED_EVENT: &str = "workflow-run-finished";
/// Longest the loop sleeps without looking again.
const HEARTBEAT: std::time::Duration = std::time::Duration::from_secs(60);
/// A due time further in the past than this is a catch-up run.
const LATE_AFTER: ChronoDuration = ChronoDuration::minutes(2);

/// Workflows running right now, shared by the scheduler and "Run now".
#[derive(Default)]
pub struct RunningWorkflows(Mutex<HashSet<String>>);

impl RunningWorkflows {
    /// Mark `workflow_id` as running, or `None` if it already is. The mark is
    /// cleared when the guard is dropped.
    pub fn try_start(self: &Arc<Self>, workflow_id: &str) -> Option<RunGuard> {
        let mut running = self.0.lock().ok()?;
        if !running.insert(workflow_id.to_string()) {
            return None;
        }
        Some(RunGuard {
            owner: self.clone(),
            workflow_id: workflow_id.to_string(),
        })
    }
}

pub struct RunGuard {
    owner: Arc<RunningWorkflows>,
    workflow_id: String,
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        if let Ok(mut running) = self.owner.0.lock() {
            running.remove(&self.workflow_id);
        }
    }
}

/// Wakes the scheduler when a schedule changes, so a new time takes effect now.
#[derive(Default, Clone)]
pub struct SchedulerWake(pub Arc<Notify>);

impl SchedulerWake {
    pub fn poke(&self) {
        self.0.notify_one();
    }
}

/// A document a run saved, for the notification and "Open document".
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedDocument {
    pub artifact_id: String,
    pub conversation_id: String,
    pub title: String,
}

/// What the renderer is told when a scheduled run ends.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunFinished {
    pub workflow_id: String,
    pub workflow_name: String,
    pub run_id: Option<String>,
    /// `completed`, `failed`, or `skipped` (still running from before).
    pub status: String,
    pub error: Option<String>,
    /// `schedule`, or `catch_up` for a run that was due while Conduit was closed.
    pub trigger: String,
    pub documents: Vec<SavedDocument>,
}

/// ISO-8601 UTC with milliseconds, the format every `*_at` column uses, so
/// times compare correctly as text.
pub fn to_iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// When `spec` is next due after `now`, reading its times in `tz`.
pub fn next_run<Tz: TimeZone>(
    spec: &ScheduleSpec,
    now: DateTime<Utc>,
    tz: &Tz,
) -> Result<String, String> {
    let next = spec.next_after(&now.with_timezone(tz))?;
    Ok(to_iso(next.with_timezone(&Utc)))
}

fn saved_documents(detail: &repo::WorkflowRunDetail) -> Vec<SavedDocument> {
    let mut docs: Vec<SavedDocument> = Vec::new();
    for step in &detail.steps {
        let Some(out) = &step.output else { continue };
        let (Some(artifact_id), Some(conversation_id)) =
            (out["artifactId"].as_str(), out["conversationId"].as_str())
        else {
            continue;
        };
        if docs.iter().any(|d| d.artifact_id == artifact_id) {
            continue;
        }
        docs.push(SavedDocument {
            artifact_id: artifact_id.to_string(),
            conversation_id: conversation_id.to_string(),
            title: out["title"].as_str().unwrap_or(artifact_id).to_string(),
        });
    }
    docs
}

/// Run every schedule due at `now`, one after another, reading schedule times
/// in `tz`. Returns what happened to each, in order.
pub async fn run_due<Tz: TimeZone>(
    state: &AppState,
    streams: &StreamManager,
    running: &Arc<RunningWorkflows>,
    fetch_policy: AddressPolicy,
    now: DateTime<Utc>,
    tz: &Tz,
) -> Vec<RunFinished> {
    let pool = &state.db;
    let due = match repo::due_schedules(pool, &to_iso(now)).await {
        Ok(due) => due,
        Err(e) => {
            tracing::warn!(error = %e, "could not read due workflow schedules");
            return Vec::new();
        }
    };
    let mut finished = Vec::new();
    for schedule in due {
        let id = schedule.workflow_id.clone();
        let name = repo::get(pool, &state.encryption, &id)
            .await
            .ok()
            .flatten()
            .map(|w| w.name)
            .unwrap_or_default();
        let late = schedule
            .next_run_at
            .as_deref()
            .and_then(|at| DateTime::parse_from_rfc3339(at).ok())
            .is_some_and(|at| now - at.with_timezone(&Utc) > LATE_AFTER);
        let trigger = if late { "catch_up" } else { "schedule" }.to_string();

        let spec: Result<ScheduleSpec, String> =
            serde_json::from_value(schedule.spec.clone()).map_err(|e| e.to_string());
        let next = spec
            .as_ref()
            .map_err(Clone::clone)
            .and_then(|spec| next_run(spec, now, tz));
        // Saved before the run, so a crash can't fire this slot again. A spec
        // that no longer reads turns the schedule off (no next time).
        if let Err(e) = repo::mark_schedule_ran(pool, &id, &to_iso(now), next.as_deref().ok()).await
        {
            tracing::warn!(workflow_id = %id, error = %e, "could not update a workflow schedule");
            continue;
        }
        if let Err(e) = &next {
            finished.push(RunFinished {
                workflow_id: id,
                workflow_name: name,
                run_id: None,
                status: "failed".into(),
                error: Some(format!("The schedule can't be read: {e}")),
                trigger,
                documents: Vec::new(),
            });
            continue;
        }

        let Some(_guard) = running.try_start(&id) else {
            finished.push(RunFinished {
                workflow_id: id,
                workflow_name: name,
                run_id: None,
                status: "skipped".into(),
                error: None,
                trigger,
                documents: Vec::new(),
            });
            continue;
        };
        let runner = Runner {
            state,
            streams,
            fetch_policy,
        };
        let outcome = runner.run(&id, &HashMap::new(), &trigger).await;
        finished.push(match outcome {
            Ok(detail) => RunFinished {
                workflow_id: id,
                workflow_name: name,
                run_id: Some(detail.run.id.clone()),
                status: detail.run.status.clone(),
                error: detail.run.error.clone(),
                trigger,
                documents: saved_documents(&detail),
            },
            Err(error) => RunFinished {
                workflow_id: id,
                workflow_name: name,
                run_id: None,
                status: "failed".into(),
                error: Some(error),
                trigger,
                documents: Vec::new(),
            },
        });
    }
    finished
}

/// How long to sleep before looking again: until the next due time, at most
/// [`HEARTBEAT`], at least a second.
async fn sleep_for(state: &AppState) -> std::time::Duration {
    let Ok(Some(next)) = repo::earliest_next_run(&state.db).await else {
        return HEARTBEAT;
    };
    let Ok(next) = DateTime::parse_from_rfc3339(&next) else {
        return HEARTBEAT;
    };
    (next.with_timezone(&Utc) - Utc::now())
        .to_std()
        .unwrap_or_default()
        .clamp(std::time::Duration::from_secs(1), HEARTBEAT)
}

/// The scheduler, for the life of the app. Started from `main`'s setup.
pub async fn scheduler_loop(app: AppHandle) {
    let wake = app.state::<SchedulerWake>().inner().clone();
    let running = app.state::<Arc<RunningWorkflows>>().inner().clone();
    loop {
        let state = app.state::<AppState>();
        let streams = app.state::<StreamManager>();
        for event in run_due(
            &state,
            &streams,
            &running,
            AddressPolicy::APP,
            Utc::now(),
            &Local,
        )
        .await
        {
            if let Err(e) = app.emit(RUN_FINISHED_EVENT, &event) {
                tracing::warn!(error = %e, "could not announce a finished workflow run");
            }
        }
        let wait = sleep_for(&state).await;
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = wake.0.notified() => {}
        }
    }
}
