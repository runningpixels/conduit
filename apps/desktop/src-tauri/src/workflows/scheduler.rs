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
//! - Every run can be stopped: [`RunningWorkflows`] holds each run's stop
//!   token ("Stop", "Stop all workflows" in the tray, quitting mid-run).
//! - A run still marked running at launch was cut off when Conduit closed; the
//!   loop marks it failed before anything else runs.
//! - Scheduled runs are unattended: they may do what the user approved and
//!   pause to ask about anything else (`permissions`). Due runs are claimed in
//!   the loop and run in the background, so a run waiting for an answer
//!   doesn't hold up the next schedule.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use chrono::{DateTime, Duration as ChronoDuration, Local, TimeZone, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use super::ask::Questions;
use super::permissions::Reviews;
use super::runner::{Notifier, RunBudget, Runner, Unattended};
use super::schedule::ScheduleSpec;
use crate::artifact_network::AddressPolicy;
use crate::db::repository::workflows as repo;
use crate::state::AppState;
use crate::stream_manager::StreamManager;

/// Event the renderer listens for.
pub const RUN_FINISHED_EVENT: &str = "workflow-run-finished";
/// Emitted with the number of runs in progress whenever it changes.
pub const RUNS_CHANGED_EVENT: &str = "workflow-runs-changed";
/// Emitted with a `PendingReview` when a scheduled run pauses to ask.
pub const RUN_PAUSED_EVENT: &str = "workflow-run-paused";
/// Emitted with a `PendingQuestion` when a run stops at an "Ask me" step.
pub const RUN_QUESTION_EVENT: &str = "workflow-run-question";
/// Longest the loop sleeps without looking again.
const HEARTBEAT: std::time::Duration = std::time::Duration::from_secs(60);
/// A due time further in the past than this is a catch-up run.
const LATE_AFTER: ChronoDuration = ChronoDuration::minutes(2);

type CountListener = Box<dyn Fn(usize) + Send + Sync>;

/// Workflows running right now, shared by the scheduler and "Run now", each
/// with the token that stops it.
#[derive(Default)]
pub struct RunningWorkflows {
    runs: Mutex<HashMap<String, CancellationToken>>,
    on_change: Mutex<Option<CountListener>>,
}

impl RunningWorkflows {
    /// Mark `workflow_id` as running, or `None` if it already is. The mark is
    /// cleared when the guard is dropped.
    pub fn try_start(self: &Arc<Self>, workflow_id: &str) -> Option<RunGuard> {
        let stop = CancellationToken::new();
        let count = {
            let mut runs = self.runs.lock().ok()?;
            if runs.contains_key(workflow_id) {
                return None;
            }
            runs.insert(workflow_id.to_string(), stop.clone());
            runs.len()
        };
        self.changed(count);
        Some(RunGuard {
            owner: self.clone(),
            workflow_id: workflow_id.to_string(),
            stop,
        })
    }

    /// How many runs are in progress.
    pub fn count(&self) -> usize {
        self.runs.lock().map(|r| r.len()).unwrap_or(0)
    }

    /// Ask one workflow's run to stop. `false` when it isn't running.
    pub fn stop(&self, workflow_id: &str) -> bool {
        let Ok(runs) = self.runs.lock() else {
            return false;
        };
        match runs.get(workflow_id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }

    /// Ask every run to stop; returns how many were asked.
    pub fn stop_all(&self) -> usize {
        let Ok(runs) = self.runs.lock() else { return 0 };
        for token in runs.values() {
            token.cancel();
        }
        runs.len()
    }

    /// Called with the new count whenever a run starts or ends (the tray).
    pub fn set_listener(&self, listener: impl Fn(usize) + Send + Sync + 'static) {
        if let Ok(mut slot) = self.on_change.lock() {
            *slot = Some(Box::new(listener));
        }
    }

    fn changed(&self, count: usize) {
        if let Ok(slot) = self.on_change.lock() {
            if let Some(listener) = slot.as_ref() {
                listener(count);
            }
        }
    }
}

pub struct RunGuard {
    owner: Arc<RunningWorkflows>,
    workflow_id: String,
    stop: CancellationToken,
}

impl RunGuard {
    /// The token that stops this run; give it to the [`Runner`].
    pub fn stop_token(&self) -> CancellationToken {
        self.stop.clone()
    }
}

impl Drop for RunGuard {
    fn drop(&mut self) {
        let count = match self.owner.runs.lock() {
            Ok(mut runs) => {
                runs.remove(&self.workflow_id);
                runs.len()
            }
            Err(_) => return,
        };
        self.owner.changed(count);
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
    /// `completed`, `failed`, `stopped`, or `skipped` (still running from before).
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

/// Show a desktop notification. Only Rust shows them; the webview has no
/// notification permission.
pub fn show_notification<R: tauri::Runtime>(
    app: &AppHandle<R>,
    title: &str,
    body: &str,
) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// A due schedule, claimed: its slot is used up and its next time saved.
pub struct Claimed {
    pub workflow_id: String,
    pub workflow_name: String,
    pub trigger: String,
    /// Why it can't run (its schedule no longer reads), if so.
    pub error: Option<String>,
}

/// Claim every schedule due at `now`, reading schedule times in `tz`. Each
/// one's next time is saved before anything runs, so neither a crash nor the
/// next look (while these still run) can fire the same slot again.
pub async fn claim_due<Tz: TimeZone>(
    state: &AppState,
    now: DateTime<Utc>,
    tz: &Tz,
) -> Vec<Claimed> {
    let pool = &state.db;
    let due = match repo::due_schedules(pool, &to_iso(now)).await {
        Ok(due) => due,
        Err(e) => {
            tracing::warn!(error = %e, "could not read due workflow schedules");
            return Vec::new();
        }
    };
    let mut claimed = Vec::new();
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
        // A spec that no longer reads turns the schedule off (no next time).
        if let Err(e) = repo::mark_schedule_ran(pool, &id, &to_iso(now), next.as_deref().ok()).await
        {
            tracing::warn!(workflow_id = %id, error = %e, "could not update a workflow schedule");
            continue;
        }
        claimed.push(Claimed {
            workflow_id: id,
            workflow_name: name,
            trigger,
            error: next
                .err()
                .map(|e| format!("The schedule can't be read: {e}")),
        });
    }
    claimed
}

/// What scheduled runs run with.
pub struct RunContext<'a> {
    pub state: &'a AppState,
    pub streams: &'a StreamManager,
    pub running: &'a Arc<RunningWorkflows>,
    pub reviews: &'a Reviews,
    pub questions: &'a Questions,
    /// `AddressPolicy::APP` in the app; tests allow a local server.
    pub fetch_policy: AddressPolicy,
    /// Shows `notify` steps; `None` in tests.
    pub notify: Option<&'a Notifier<'a>>,
}

/// Run what was claimed, all at once, so a run waiting for the user holds up
/// no other; `on_finished` hears each as it ends. Returns them in the order
/// they finished.
pub async fn run_claimed(
    ctx: &RunContext<'_>,
    claimed: Vec<Claimed>,
    on_finished: &(dyn Fn(&RunFinished) + Sync),
) -> Vec<RunFinished> {
    let finished = Mutex::new(Vec::new());
    let runs = claimed.into_iter().map(|claim| async {
        let event = run_one(ctx, claim).await;
        on_finished(&event);
        if let Ok(mut finished) = finished.lock() {
            finished.push(event);
        }
    });
    futures::future::join_all(runs).await;
    finished.into_inner().unwrap_or_default()
}

async fn run_one(ctx: &RunContext<'_>, claim: Claimed) -> RunFinished {
    let RunContext {
        state,
        streams,
        running,
        reviews,
        questions,
        fetch_policy,
        notify,
    } = *ctx;
    let Claimed {
        workflow_id,
        workflow_name,
        trigger,
        error,
    } = claim;
    let finished = |status: &str, error: Option<String>| RunFinished {
        workflow_id: workflow_id.clone(),
        workflow_name: workflow_name.clone(),
        run_id: None,
        status: status.into(),
        error,
        trigger: trigger.clone(),
        documents: Vec::new(),
    };
    if error.is_some() {
        return finished("failed", error);
    }
    let Some(guard) = running.try_start(&workflow_id) else {
        return finished("skipped", None);
    };
    // Nobody is watching: the run may do what the user approved, and asks
    // about anything else.
    let approved = repo::get_permissions(&state.db, &state.encryption, &workflow_id)
        .await
        .ok()
        .flatten()
        .map(|(approved, _)| approved)
        .unwrap_or_default();
    let runner = Runner {
        state,
        streams,
        fetch_policy,
        stop: guard.stop_token(),
        unattended: Some(Unattended::new(reviews, approved)),
        budget: RunBudget::default(),
        notify,
        questions: Some(questions),
    };
    let outcome = runner.run(&workflow_id, &HashMap::new(), &trigger).await;
    drop(guard);
    match outcome {
        Ok(detail) => RunFinished {
            run_id: Some(detail.run.id.clone()),
            status: detail.run.status.clone(),
            error: detail.run.error.clone(),
            documents: saved_documents(&detail),
            ..finished("", None)
        },
        Err(error) => finished("failed", Some(error)),
    }
}

/// Claim and run everything due at `now` ([`claim_due`], then
/// [`run_claimed`]).
pub async fn run_due<Tz: TimeZone>(
    state: &AppState,
    streams: &StreamManager,
    running: &Arc<RunningWorkflows>,
    reviews: &Reviews,
    fetch_policy: AddressPolicy,
    now: DateTime<Utc>,
    tz: &Tz,
) -> Vec<RunFinished> {
    let claimed = claim_due(state, now, tz).await;
    let questions = Questions::default();
    let ctx = RunContext {
        state,
        streams,
        running,
        reviews,
        questions: &questions,
        fetch_policy,
        notify: None,
    };
    run_claimed(&ctx, claimed, &|_| {}).await
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
    match repo::fail_interrupted_runs(&app.state::<AppState>().db).await {
        Ok(0) => {}
        Ok(n) => tracing::info!(runs = n, "marked workflow runs cut off by a quit as failed"),
        Err(e) => tracing::warn!(error = %e, "could not tidy workflow runs left running"),
    }
    loop {
        let state = app.state::<AppState>();
        let claimed = claim_due(&state, Utc::now(), &Local).await;
        // The runs go on in the background: one waiting a day for an answer
        // must not stop the loop from starting the next schedule on time.
        if !claimed.is_empty() {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let announce = |event: &RunFinished| {
                    if let Err(e) = app.emit(RUN_FINISHED_EVENT, event) {
                        tracing::warn!(error = %e, "could not announce a finished workflow run");
                    }
                };
                let notify = |title: &str, body: &str| show_notification(&app, title, body);
                let ctx = RunContext {
                    state: &app.state::<AppState>(),
                    streams: &app.state::<StreamManager>(),
                    running: &app.state::<Arc<RunningWorkflows>>(),
                    reviews: &app.state::<Reviews>(),
                    questions: &app.state::<Questions>(),
                    fetch_policy: AddressPolicy::APP,
                    notify: Some(&notify),
                };
                run_claimed(&ctx, claimed, &announce).await;
            });
        }
        let wait = sleep_for(&state).await;
        tokio::select! {
            _ = tokio::time::sleep(wait) => {}
            _ = wake.0.notified() => {}
        }
    }
}
