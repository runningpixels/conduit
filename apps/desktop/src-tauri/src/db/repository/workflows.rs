//! Workflows, their runs, and each run's steps (migration 0020).
//!
//! Definitions and step inputs/outputs are encrypted at rest like other
//! content: step outputs hold fetched pages and model replies.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::workflows::permissions::Permission;
use crate::{db::DbError, encryption::Encryption, time::now_iso8601};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRecord {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// The definition as stored JSON (see `workflows::definition`).
    pub definition: Value,
    pub version: i64,
    pub conversation_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSummary {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub version: i64,
    pub updated_at: String,
    pub last_run_status: Option<String>,
    pub last_run_at: Option<String>,
    /// When it next runs on its own, if it has a schedule that is on.
    pub next_run_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRun {
    pub id: String,
    pub workflow_id: String,
    pub version: i64,
    pub trigger: String,
    pub status: String,
    pub error: Option<String>,
    /// How a `completed` run ended when it didn't run to the last step:
    /// `nothing_new` (a condition stopped it). `None` for an ordinary run.
    pub outcome: Option<String>,
    /// The step the outcome came from (the condition that stopped the run).
    pub outcome_step: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

/// The run outcome of a run stopped by a condition. Kept in the run's `error`
/// column, which a completed run never otherwise uses, so no migration is
/// needed (an older build reading the row sees a completed run); read back
/// through [`WorkflowRun::outcome`], never as an error.
pub const NOTHING_NEW: &str = "nothing_new";

fn outcome_marker(kind: &str, step_id: &str) -> String {
    format!("outcome:{kind}:{step_id}")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunStep {
    pub id: String,
    pub run_id: String,
    pub step_id: String,
    pub iteration: Option<i64>,
    pub status: String,
    pub input: Option<Value>,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowRunDetail {
    pub run: WorkflowRun,
    pub steps: Vec<WorkflowRunStep>,
}

fn encrypt_json(enc: &Encryption, value: &Value) -> Result<String, DbError> {
    enc.encrypt(&value.to_string())
}

fn decrypt_json(enc: &Encryption, stored: &str) -> Result<Value, DbError> {
    let text = enc.decrypt(stored)?;
    serde_json::from_str(&text).map_err(|e| DbError::Query(format!("stored JSON is invalid: {e}")))
}

type WorkflowRow = (
    String,
    String,
    Option<String>,
    String,
    i64,
    Option<String>,
    String,
    String,
);

fn record(enc: &Encryption, row: WorkflowRow) -> Result<WorkflowRecord, DbError> {
    let (id, name, description, definition_json, version, conversation_id, created_at, updated_at) =
        row;
    Ok(WorkflowRecord {
        id,
        name,
        description,
        definition: decrypt_json(enc, &definition_json)?,
        version,
        conversation_id,
        created_at,
        updated_at,
    })
}

const WORKFLOW_COLUMNS: &str =
    "id, name, description, definition_json, version, conversation_id, created_at, updated_at";

pub async fn create(
    pool: &SqlitePool,
    enc: &Encryption,
    name: &str,
    description: Option<&str>,
    definition: &Value,
) -> Result<WorkflowRecord, DbError> {
    let id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    sqlx::query(
        "INSERT INTO workflows (id, name, description, definition_json, version, created_at, updated_at) \
         VALUES (?, ?, ?, ?, 1, ?, ?)",
    )
    .bind(&id)
    .bind(name)
    .bind(description)
    .bind(encrypt_json(enc, definition)?)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    get(pool, enc, &id)
        .await?
        .ok_or_else(|| DbError::Query("workflow vanished after insert".into()))
}

/// Replace a workflow's name, description and definition; bumps `version`.
pub async fn update(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
    name: &str,
    description: Option<&str>,
    definition: &Value,
) -> Result<WorkflowRecord, DbError> {
    let done = sqlx::query(
        "UPDATE workflows SET name = ?, description = ?, definition_json = ?, \
         version = version + 1, updated_at = ? WHERE id = ?",
    )
    .bind(name)
    .bind(description)
    .bind(encrypt_json(enc, definition)?)
    .bind(now_iso8601())
    .bind(id)
    .execute(pool)
    .await?;
    if done.rows_affected() == 0 {
        return Err(DbError::Query(format!("no workflow {id}")));
    }
    get(pool, enc, id)
        .await?
        .ok_or_else(|| DbError::Query(format!("no workflow {id}")))
}

pub async fn get(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
) -> Result<Option<WorkflowRecord>, DbError> {
    let row: Option<WorkflowRow> = sqlx::query_as(&format!(
        "SELECT {WORKFLOW_COLUMNS} FROM workflows WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;
    row.map(|r| record(enc, r)).transpose()
}

/// Every workflow, most recently changed first, with its latest run.
pub async fn list(pool: &SqlitePool) -> Result<Vec<WorkflowSummary>, DbError> {
    type Row = (
        String,
        String,
        Option<String>,
        i64,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
    );
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT w.id, w.name, w.description, w.version, w.updated_at, \
                (SELECT r.status FROM workflow_runs r WHERE r.workflow_id = w.id \
                   ORDER BY r.started_at DESC LIMIT 1), \
                (SELECT r.started_at FROM workflow_runs r WHERE r.workflow_id = w.id \
                   ORDER BY r.started_at DESC LIMIT 1), \
                (SELECT s.next_run_at FROM workflow_schedules s \
                   WHERE s.workflow_id = w.id AND s.enabled = 1) \
         FROM workflows w ORDER BY w.updated_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                name,
                description,
                version,
                updated_at,
                last_run_status,
                last_run_at,
                next_run_at,
            )| {
                WorkflowSummary {
                    id,
                    name,
                    description,
                    version,
                    updated_at,
                    last_run_status,
                    last_run_at,
                    next_run_at,
                }
            },
        )
        .collect())
}

/// Delete a workflow and its runs. Its conversation is the caller's to remove
/// (with its artifact files), see `commands::workflows::delete_workflow`.
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), DbError> {
    sqlx::query("DELETE FROM workflows WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn set_conversation(
    pool: &SqlitePool,
    id: &str,
    conversation_id: &str,
) -> Result<(), DbError> {
    sqlx::query("UPDATE workflows SET conversation_id = ? WHERE id = ?")
        .bind(conversation_id)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn start_run(
    pool: &SqlitePool,
    workflow_id: &str,
    version: i64,
    trigger: &str,
) -> Result<WorkflowRun, DbError> {
    let run = WorkflowRun {
        id: Uuid::new_v4().to_string(),
        workflow_id: workflow_id.to_string(),
        version,
        trigger: trigger.to_string(),
        status: "running".to_string(),
        error: None,
        outcome: None,
        outcome_step: None,
        started_at: now_iso8601(),
        finished_at: None,
    };
    sqlx::query(
        "INSERT INTO workflow_runs (id, workflow_id, version, trigger, status, started_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&run.id)
    .bind(&run.workflow_id)
    .bind(run.version)
    .bind(&run.trigger)
    .bind(&run.status)
    .bind(&run.started_at)
    .execute(pool)
    .await?;
    Ok(run)
}

pub async fn finish_run(
    pool: &SqlitePool,
    run_id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<(), DbError> {
    sqlx::query("UPDATE workflow_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?")
        .bind(status)
        .bind(error)
        .bind(now_iso8601())
        .bind(run_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// End a run as `completed` with an outcome (`kind` is [`NOTHING_NEW`]) from
/// `step_id`.
pub async fn finish_run_with_outcome(
    pool: &SqlitePool,
    run_id: &str,
    kind: &str,
    step_id: &str,
) -> Result<(), DbError> {
    finish_run(
        pool,
        run_id,
        "completed",
        Some(&outcome_marker(kind, step_id)),
    )
    .await
}

/// The output of `step_id`'s most recent top-level row that `completed` (not
/// `reused`, not skipped or failed) in a run of `workflow_id` other than
/// `run_id`, in a run that itself completed: the baseline a "has it
/// changed?" check compares with. A run that failed after its check passed
/// doesn't count, so the change is reported again on the next run.
pub async fn last_completed_output(
    pool: &SqlitePool,
    enc: &Encryption,
    workflow_id: &str,
    step_id: &str,
    run_id: &str,
) -> Result<Option<Value>, DbError> {
    let stored: Option<Option<String>> = sqlx::query_scalar(
        "SELECT s.output_json FROM workflow_run_steps s          JOIN workflow_runs r ON r.id = s.run_id          WHERE r.workflow_id = ? AND s.step_id = ? AND s.iteration IS NULL            AND s.status = 'completed' AND r.status = 'completed' AND s.run_id != ?          ORDER BY s.started_at DESC, s.rowid DESC LIMIT 1",
    )
    .bind(workflow_id)
    .bind(step_id)
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    stored.flatten().map(|s| decrypt_json(enc, &s)).transpose()
}

/// Mark runs (and their steps) still `running` or `paused` as failed: at
/// launch nothing is running, so they were cut off when Conduit closed.
/// Returns how many runs.
pub async fn fail_interrupted_runs(pool: &SqlitePool) -> Result<u64, DbError> {
    let now = now_iso8601();
    let error = interrupted();
    sqlx::query(
        "UPDATE workflow_run_steps SET status = 'failed', error = ?, finished_at = ? \
         WHERE status = 'running'",
    )
    .bind(&error)
    .bind(&now)
    .execute(pool)
    .await?;
    let runs = sqlx::query(
        "UPDATE workflow_runs SET status = 'failed', error = ?, finished_at = ? \
         WHERE status IN ('running', 'paused')",
    )
    .bind(&error)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(runs.rows_affected())
}

fn interrupted() -> String {
    format!(
        "{} closed before this run finished.",
        crate::brand::app_name()
    )
}

/// Record that a step started; returns the row id to finish it with.
pub async fn start_step(
    pool: &SqlitePool,
    enc: &Encryption,
    run_id: &str,
    step_id: &str,
    iteration: Option<i64>,
    input: &Value,
) -> Result<String, DbError> {
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO workflow_run_steps (id, run_id, step_id, iteration, status, input_json, started_at) \
         VALUES (?, ?, ?, ?, 'running', ?, ?)",
    )
    .bind(&id)
    .bind(run_id)
    .bind(step_id)
    .bind(iteration)
    .bind(encrypt_json(enc, input)?)
    .bind(now_iso8601())
    .execute(pool)
    .await?;
    Ok(id)
}

pub async fn finish_step(
    pool: &SqlitePool,
    enc: &Encryption,
    row_id: &str,
    status: &str,
    output: Option<&Value>,
    error: Option<&str>,
) -> Result<(), DbError> {
    let output = output.map(|v| encrypt_json(enc, v)).transpose()?;
    sqlx::query(
        "UPDATE workflow_run_steps SET status = ?, output_json = ?, error = ?, finished_at = ? WHERE id = ?",
    )
    .bind(status)
    .bind(output)
    .bind(error)
    .bind(now_iso8601())
    .bind(row_id)
    .execute(pool)
    .await?;
    Ok(())
}

type RunRow = (
    String,
    String,
    i64,
    String,
    String,
    Option<String>,
    String,
    Option<String>,
);

fn run_from(row: RunRow) -> WorkflowRun {
    let (id, workflow_id, version, trigger, status, error, started_at, finished_at) = row;
    let marker = error
        .as_deref()
        .filter(|_| status == "completed")
        .and_then(|e| e.strip_prefix("outcome:"))
        .and_then(|rest| rest.split_once(':'))
        .map(|(kind, step)| (kind.to_string(), step.to_string()));
    let (outcome, outcome_step, error) = match marker {
        Some((kind, step)) => (Some(kind), Some(step), None),
        None => (None, None, error),
    };
    WorkflowRun {
        id,
        workflow_id,
        version,
        trigger,
        status,
        error,
        outcome,
        outcome_step,
        started_at,
        finished_at,
    }
}

const RUN_COLUMNS: &str =
    "id, workflow_id, version, trigger, status, error, started_at, finished_at";

/// A workflow's runs, newest first.
pub async fn list_runs(
    pool: &SqlitePool,
    workflow_id: &str,
    limit: i64,
) -> Result<Vec<WorkflowRun>, DbError> {
    let rows: Vec<RunRow> = sqlx::query_as(&format!(
        "SELECT {RUN_COLUMNS} FROM workflow_runs WHERE workflow_id = ? ORDER BY started_at DESC LIMIT ?"
    ))
    .bind(workflow_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(run_from).collect())
}

/// A run with every step it recorded, in the order they started.
pub async fn get_run(
    pool: &SqlitePool,
    enc: &Encryption,
    run_id: &str,
) -> Result<Option<WorkflowRunDetail>, DbError> {
    let row: Option<RunRow> = sqlx::query_as(&format!(
        "SELECT {RUN_COLUMNS} FROM workflow_runs WHERE id = ?"
    ))
    .bind(run_id)
    .fetch_optional(pool)
    .await?;
    let Some(row) = row else { return Ok(None) };
    type StepRow = (
        String,
        String,
        String,
        Option<i64>,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        Option<String>,
    );
    let rows: Vec<StepRow> = sqlx::query_as(
        "SELECT id, run_id, step_id, iteration, status, input_json, output_json, error, started_at, finished_at \
         FROM workflow_run_steps WHERE run_id = ? ORDER BY started_at, rowid",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await?;
    let mut steps = Vec::with_capacity(rows.len());
    for (id, run_id, step_id, iteration, status, input, output, error, started_at, finished_at) in
        rows
    {
        steps.push(WorkflowRunStep {
            id,
            run_id,
            step_id,
            iteration,
            status,
            input: input.as_deref().map(|s| decrypt_json(enc, s)).transpose()?,
            output: output
                .as_deref()
                .map(|s| decrypt_json(enc, s))
                .transpose()?,
            error,
            started_at,
            finished_at,
        });
    }
    Ok(Some(WorkflowRunDetail {
        run: run_from(row),
        steps,
    }))
}

/// A workflow's schedule (migration 0021). `spec` is a
/// `workflows::schedule::ScheduleSpec` as JSON.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowSchedule {
    pub workflow_id: String,
    pub spec: Value,
    pub enabled: bool,
    /// UTC. `None` when the schedule is off.
    pub next_run_at: Option<String>,
    pub last_run_at: Option<String>,
}

type ScheduleRow = (String, String, i64, Option<String>, Option<String>);

fn schedule_from(row: ScheduleRow) -> Result<WorkflowSchedule, DbError> {
    let (workflow_id, spec_json, enabled, next_run_at, last_run_at) = row;
    Ok(WorkflowSchedule {
        workflow_id,
        spec: serde_json::from_str(&spec_json)
            .map_err(|e| DbError::Query(format!("stored schedule is invalid: {e}")))?,
        enabled: enabled != 0,
        next_run_at,
        last_run_at,
    })
}

const SCHEDULE_COLUMNS: &str = "workflow_id, spec_json, enabled, next_run_at, last_run_at";

pub async fn get_schedule(
    pool: &SqlitePool,
    workflow_id: &str,
) -> Result<Option<WorkflowSchedule>, DbError> {
    let row: Option<ScheduleRow> = sqlx::query_as(&format!(
        "SELECT {SCHEDULE_COLUMNS} FROM workflow_schedules WHERE workflow_id = ?"
    ))
    .bind(workflow_id)
    .fetch_optional(pool)
    .await?;
    row.map(schedule_from).transpose()
}

/// Create or replace a workflow's schedule.
pub async fn put_schedule(
    pool: &SqlitePool,
    workflow_id: &str,
    spec: &Value,
    enabled: bool,
    next_run_at: Option<&str>,
) -> Result<WorkflowSchedule, DbError> {
    let now = now_iso8601();
    sqlx::query(
        "INSERT INTO workflow_schedules (workflow_id, spec_json, enabled, next_run_at, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?) \
         ON CONFLICT(workflow_id) DO UPDATE SET spec_json = excluded.spec_json, \
           enabled = excluded.enabled, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at",
    )
    .bind(workflow_id)
    .bind(spec.to_string())
    .bind(i64::from(enabled))
    .bind(next_run_at)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    get_schedule(pool, workflow_id)
        .await?
        .ok_or_else(|| DbError::Query("schedule vanished after save".into()))
}

pub async fn delete_schedule(pool: &SqlitePool, workflow_id: &str) -> Result<(), DbError> {
    sqlx::query("DELETE FROM workflow_schedules WHERE workflow_id = ?")
        .bind(workflow_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Schedules that are on and due at or before `now` (UTC), soonest first.
pub async fn due_schedules(pool: &SqlitePool, now: &str) -> Result<Vec<WorkflowSchedule>, DbError> {
    let rows: Vec<ScheduleRow> = sqlx::query_as(&format!(
        "SELECT {SCHEDULE_COLUMNS} FROM workflow_schedules \
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at"
    ))
    .bind(now)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(schedule_from).collect()
}

/// When the next schedule is due, if any is on.
pub async fn earliest_next_run(pool: &SqlitePool) -> Result<Option<String>, DbError> {
    let next: Option<Option<String>> = sqlx::query_scalar(
        "SELECT MIN(next_run_at) FROM workflow_schedules WHERE enabled = 1 AND next_run_at IS NOT NULL",
    )
    .fetch_optional(pool)
    .await?;
    Ok(next.flatten())
}

/// Record that a schedule ran (or was skipped) at `ran_at`, and when it runs next.
pub async fn mark_schedule_ran(
    pool: &SqlitePool,
    workflow_id: &str,
    ran_at: &str,
    next_run_at: Option<&str>,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE workflow_schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE workflow_id = ?",
    )
    .bind(ran_at)
    .bind(next_run_at)
    .bind(now_iso8601())
    .bind(workflow_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Set a run's status while it is in progress: `paused` while it waits for
/// the user, `running` again after.
pub async fn set_run_status(pool: &SqlitePool, run_id: &str, status: &str) -> Result<(), DbError> {
    sqlx::query("UPDATE workflow_runs SET status = ? WHERE id = ?")
        .bind(status)
        .bind(run_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// What the user approved a workflow to do unattended, and when; `None`
/// before the first approval.
pub async fn get_permissions(
    pool: &SqlitePool,
    enc: &Encryption,
    workflow_id: &str,
) -> Result<Option<(Vec<Permission>, String)>, DbError> {
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT approved, approved_at FROM workflow_permissions WHERE workflow_id = ?",
    )
    .bind(workflow_id)
    .fetch_optional(pool)
    .await?;
    row.map(|(approved, at)| {
        let list = serde_json::from_value(decrypt_json(enc, &approved)?).map_err(|e| {
            DbError::Query(format!("stored workflow permissions can't be read: {e}"))
        })?;
        Ok((list, at))
    })
    .transpose()
}

/// Replace what a workflow is approved to do unattended.
pub async fn set_permissions(
    pool: &SqlitePool,
    enc: &Encryption,
    workflow_id: &str,
    approved: &[Permission],
) -> Result<(), DbError> {
    let json = serde_json::to_value(approved)
        .map_err(|e| DbError::Query(format!("workflow permissions can't be stored: {e}")))?;
    sqlx::query(
        "INSERT INTO workflow_permissions (workflow_id, approved, approved_at) VALUES (?, ?, ?) \
         ON CONFLICT(workflow_id) DO UPDATE SET approved = excluded.approved, \
         approved_at = excluded.approved_at",
    )
    .bind(workflow_id)
    .bind(encrypt_json(enc, &json)?)
    .bind(now_iso8601())
    .execute(pool)
    .await?;
    Ok(())
}

/// Remember what a run was started with (see migration 0023).
pub async fn set_run_inputs(
    pool: &SqlitePool,
    enc: &Encryption,
    run_id: &str,
    inputs: &Value,
) -> Result<(), DbError> {
    sqlx::query("UPDATE workflow_runs SET inputs = ? WHERE id = ?")
        .bind(encrypt_json(enc, inputs)?)
        .bind(run_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// What a run was started with; `None` for runs from before inputs were kept.
pub async fn get_run_inputs(
    pool: &SqlitePool,
    enc: &Encryption,
    run_id: &str,
) -> Result<Option<Value>, DbError> {
    let stored: Option<Option<String>> =
        sqlx::query_scalar("SELECT inputs FROM workflow_runs WHERE id = ?")
            .bind(run_id)
            .fetch_optional(pool)
            .await?;
    stored
        .flatten()
        .map(|text| decrypt_json(enc, &text))
        .transpose()
}
