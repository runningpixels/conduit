//! Agents at work, in workflows and in chat (migrations 0043 and 0044).
//!
//! One row each time an agent takes on a task: an agent step of a run, a
//! helper it handed a task to, or a chat turn run as a library agent. The
//! Agents page reads the totals back, and a run's agent tree its rows.

use provider_core::schema::HandoffTokens;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{db::DbError, encryption::Encryption, time::now_iso8601};

/// A token count as SQLite keeps it.
fn stored(tokens: u64) -> i64 {
    i64::try_from(tokens).unwrap_or(i64::MAX)
}

/// Who an [`start_agent_call`] row is about.
pub struct AgentCallStart<'a> {
    /// The run, workflow and step it belongs to; `None` for chat work.
    pub run_id: Option<&'a str>,
    pub workflow_id: Option<&'a str>,
    pub step_id: Option<&'a str>,
    /// The conversation it was asked in, for chat work.
    pub conversation_id: Option<&'a str>,
    /// `step` (an agent step), `helper` or `chat` (a chat turn run as an agent).
    pub kind: &'a str,
    pub agent_id: &'a str,
    /// The row of the agent that handed this one its task.
    pub parent_id: Option<&'a str>,
    pub task: &'a str,
    /// The "provider/model" it runs on.
    pub model: Option<&'a str>,
    /// The request of its own turn, when it is known already.
    pub request_id: Option<&'a str>,
}

/// Record that an agent started on a task; returns the row id to finish it
/// with.
pub async fn start_agent_call(
    pool: &SqlitePool,
    enc: &Encryption,
    call: &AgentCallStart<'_>,
) -> Result<String, DbError> {
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO agent_calls (id, run_id, workflow_id, step_id, conversation_id, kind, \
         agent_id, parent_id, task, model, request_id, status, started_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)",
    )
    .bind(&id)
    .bind(call.run_id)
    .bind(call.workflow_id)
    .bind(call.step_id)
    .bind(call.conversation_id)
    .bind(call.kind)
    .bind(call.agent_id)
    .bind(call.parent_id)
    .bind(enc.encrypt(call.task)?)
    .bind(call.model)
    .bind(call.request_id)
    .bind(now_iso8601())
    .execute(pool)
    .await?;
    Ok(id)
}

/// Note the request of the agent's own turn, which Redirect steers.
pub async fn set_agent_call_request(
    pool: &SqlitePool,
    id: &str,
    request_id: &str,
) -> Result<(), DbError> {
    sqlx::query("UPDATE agent_calls SET request_id = ? WHERE id = ?")
        .bind(request_id)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

/// The tokens a running agent has used so far (after each of its rounds). A
/// row that has already finished keeps its final count.
pub async fn record_agent_call_usage(
    pool: &SqlitePool,
    id: &str,
    tokens: u64,
    usage: &HandoffTokens,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE agent_calls SET tokens = ?, input_tokens = ?, output_tokens = ?, \
         cache_read_tokens = ?, cache_write_tokens = ? WHERE id = ? AND status = 'running'",
    )
    .bind(stored(tokens))
    .bind(stored(usage.input_tokens))
    .bind(stored(usage.output_tokens))
    .bind(stored(usage.cache_read_tokens))
    .bind(stored(usage.cache_write_tokens))
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// [`record_agent_call_usage`] without waiting for it: called from a turn's
/// event sink, once per round. A late write can't undo the finish (see
/// there), so the order doesn't matter.
pub fn record_agent_call_usage_soon(
    pool: &SqlitePool,
    id: &str,
    tokens: u64,
    usage: HandoffTokens,
) {
    let (pool, id) = (pool.clone(), id.to_string());
    tokio::spawn(async move {
        if let Err(e) = record_agent_call_usage(&pool, &id, tokens, &usage).await {
            tracing::warn!(error = %e, "could not record an agent's tokens");
        }
    });
}

/// How an agent's task ended.
pub struct AgentCallEnd<'a> {
    pub tokens: u64,
    pub usage: HandoffTokens,
    /// `None` when it answered (or was stopped).
    pub error: Option<&'a str>,
    /// The user stopped it, or the work it was part of was stopped.
    pub stopped: bool,
}

/// Record how an agent's task ended: `done`, `failed` or `stopped`.
pub async fn finish_agent_call(
    pool: &SqlitePool,
    id: &str,
    end: &AgentCallEnd<'_>,
) -> Result<(), DbError> {
    let status = match (end.stopped, end.error) {
        (true, _) => "stopped",
        (false, Some(_)) => "failed",
        (false, None) => "done",
    };
    sqlx::query(
        "UPDATE agent_calls SET status = ?, error = ?, tokens = ?, input_tokens = ?, \
         output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, finished_at = ? \
         WHERE id = ?",
    )
    .bind(status)
    .bind(end.error)
    .bind(stored(end.tokens))
    .bind(stored(end.usage.input_tokens))
    .bind(stored(end.usage.output_tokens))
    .bind(stored(end.usage.cache_read_tokens))
    .bind(stored(end.usage.cache_write_tokens))
    .bind(now_iso8601())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

/// One agent's work in a run, for its agent tree.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCallRow {
    pub id: String,
    /// The row of the agent that handed it the task.
    pub parent_id: Option<String>,
    /// `step`, `helper` or `chat`.
    pub kind: String,
    pub step_id: Option<String>,
    pub agent_id: String,
    /// What the user calls it; the agent's id until a name is filled in.
    pub name: String,
    pub task: String,
    /// "provider/model".
    pub model: Option<String>,
    /// `running`, `done`, `failed` or `stopped`.
    pub status: String,
    pub error: Option<String>,
    pub tokens: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub started_at: String,
    pub finished_at: Option<String>,
}

/// Every agent call of `run_id`, in the order they started; `name` is the
/// agent's id (see `agents::library::agent_calls_of_run` for names).
pub async fn list_agent_calls(
    pool: &SqlitePool,
    enc: &Encryption,
    run_id: &str,
) -> Result<Vec<AgentCallRow>, DbError> {
    use sqlx::Row;

    let rows = sqlx::query(
        "SELECT id, parent_id, kind, step_id, agent_id, task, model, status, error, tokens, \
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, started_at, \
         finished_at FROM agent_calls WHERE run_id = ? ORDER BY started_at, rowid",
    )
    .bind(run_id)
    .fetch_all(pool)
    .await?;
    let count = |row: &sqlx::sqlite::SqliteRow, column: &str| -> Result<u64, DbError> {
        Ok(u64::try_from(row.try_get::<i64, _>(column)?).unwrap_or(0))
    };
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let agent_id: String = row.try_get("agent_id")?;
        let task: Option<String> = row.try_get("task")?;
        out.push(AgentCallRow {
            id: row.try_get("id")?,
            parent_id: row.try_get("parent_id")?,
            kind: row.try_get("kind")?,
            step_id: row.try_get("step_id")?,
            name: agent_id.clone(),
            agent_id,
            task: match task {
                Some(stored) => enc.decrypt(&stored)?,
                None => String::new(),
            },
            model: row.try_get("model")?,
            status: row.try_get("status")?,
            error: row.try_get("error")?,
            tokens: count(row, "tokens")?,
            input_tokens: count(row, "input_tokens")?,
            output_tokens: count(row, "output_tokens")?,
            cache_read_tokens: count(row, "cache_read_tokens")?,
            cache_write_tokens: count(row, "cache_write_tokens")?,
            started_at: row.try_get("started_at")?,
            finished_at: row.try_get("finished_at")?,
        });
    }
    Ok(out)
}

/// An agent call as the page hears of it when it starts or ends (event
/// `agent-call-changed`) and lists the running ones.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCallChange {
    pub id: String,
    /// `step`, `helper` or `chat`.
    pub kind: String,
    pub agent_id: String,
    /// What the user calls it; the agent's id until a name is filled in.
    pub name: String,
    pub task: String,
    /// `running`, `done`, `failed` or `stopped`.
    pub status: String,
    pub error: Option<String>,
    pub conversation_id: Option<String>,
    pub run_id: Option<String>,
    pub workflow_id: Option<String>,
    pub parent_id: Option<String>,
    pub started_at: String,
    pub finished_at: Option<String>,
}

/// The call `id`, or every running call (newest first) when `id` is `None`.
/// `name` is the agent's id (see `agents::calls` for names).
pub async fn agent_call_changes(
    pool: &SqlitePool,
    enc: &Encryption,
    id: Option<&str>,
) -> Result<Vec<AgentCallChange>, DbError> {
    use sqlx::Row;

    let rows = sqlx::query(
        "SELECT id, kind, agent_id, task, status, error, conversation_id, run_id, workflow_id, \
         parent_id, started_at, finished_at FROM agent_calls \
         WHERE (?1 IS NOT NULL AND id = ?1) OR (?1 IS NULL AND status = 'running') \
         ORDER BY started_at DESC, rowid DESC",
    )
    .bind(id)
    .fetch_all(pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let agent_id: String = row.try_get("agent_id")?;
        let task: Option<String> = row.try_get("task")?;
        out.push(AgentCallChange {
            id: row.try_get("id")?,
            kind: row.try_get("kind")?,
            name: agent_id.clone(),
            agent_id,
            task: match task {
                Some(stored) => enc.decrypt(&stored)?,
                None => String::new(),
            },
            status: row.try_get("status")?,
            error: row.try_get("error")?,
            conversation_id: row.try_get("conversation_id")?,
            run_id: row.try_get("run_id")?,
            workflow_id: row.try_get("workflow_id")?,
            parent_id: row.try_get("parent_id")?,
            started_at: row.try_get("started_at")?,
            finished_at: row.try_get("finished_at")?,
        });
    }
    Ok(out)
}

/// The requests of the helpers `request_id`'s turn handed work to, and of
/// theirs in turn: the children of the turn's own agent row, and (when the
/// turn ran without an agent) helpers of the conversation that started
/// between `from` and `to`.
pub async fn helper_request_ids(
    pool: &SqlitePool,
    conversation_id: &str,
    request_id: &str,
    from: &str,
    to: &str,
) -> Result<Vec<String>, DbError> {
    let ids: Vec<Option<String>> = sqlx::query_scalar(
        "WITH RECURSIVE tree(id, request_id) AS ( \
           SELECT id, request_id FROM agent_calls \
            WHERE conversation_id = ?1 AND ( \
              parent_id IN (SELECT id FROM agent_calls WHERE request_id = ?2 AND kind = 'chat') \
              OR (parent_id IS NULL AND kind = 'helper' AND started_at >= ?3 AND started_at <= ?4)) \
           UNION ALL \
           SELECT c.id, c.request_id FROM agent_calls c JOIN tree t ON c.parent_id = t.id) \
         SELECT request_id FROM tree",
    )
    .bind(conversation_id)
    .bind(request_id)
    .bind(from)
    .bind(to)
    .fetch_all(pool)
    .await?;
    Ok(ids.into_iter().flatten().collect())
}

/// Agent tasks left running when the app last closed: none of them is still
/// going (a run that carries on starts its step again).
pub async fn fail_interrupted_agent_calls(pool: &SqlitePool) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE agent_calls SET status = 'failed', error = ?, finished_at = ? \
         WHERE status = 'running'",
    )
    .bind(super::workflows::interrupted())
    .bind(now_iso8601())
    .execute(pool)
    .await?;
    Ok(())
}

/// What one agent (an agent step or a helper of a workflow) has been doing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActivity {
    pub workflow_id: String,
    pub kind: String,
    pub agent_id: String,
    /// The task it is working on now, when it is.
    pub current_task: Option<String>,
    pub current_run_id: Option<String>,
    pub last_active: Option<String>,
    /// Tasks and tokens since the `since` asked for.
    pub tasks: i64,
    pub failed: i64,
    pub tokens: i64,
}

/// Every workflow agent's activity: totals since `since` (an ISO time), when
/// it last worked, and what it is working on now.
pub async fn agent_activity(
    pool: &SqlitePool,
    enc: &Encryption,
    since: &str,
) -> Result<Vec<AgentActivity>, DbError> {
    type Row = (String, String, String, Option<String>, i64, i64, i64);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT workflow_id, kind, agent_id, MAX(started_at), \
         SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END), \
         SUM(CASE WHEN started_at >= ? AND status = 'failed' THEN 1 ELSE 0 END), \
         SUM(CASE WHEN started_at >= ? THEN tokens ELSE 0 END) \
         FROM agent_calls WHERE workflow_id IS NOT NULL GROUP BY workflow_id, kind, agent_id",
    )
    .bind(since)
    .bind(since)
    .bind(since)
    .fetch_all(pool)
    .await?;
    type Running = (String, String, String, Option<String>, Option<String>);
    let running: Vec<Running> = sqlx::query_as(
        "SELECT workflow_id, kind, agent_id, task, run_id FROM agent_calls \
             WHERE status = 'running' AND workflow_id IS NOT NULL ORDER BY started_at",
    )
    .fetch_all(pool)
    .await?;
    let mut out: Vec<AgentActivity> = rows
        .into_iter()
        .map(
            |(workflow_id, kind, agent_id, last_active, tasks, failed, tokens)| AgentActivity {
                workflow_id,
                kind,
                agent_id,
                current_task: None,
                current_run_id: None,
                last_active,
                tasks,
                failed,
                tokens,
            },
        )
        .collect();
    // The latest task each running agent took on.
    for (workflow_id, kind, agent_id, task, run_id) in running {
        if let Some(row) = out
            .iter_mut()
            .find(|a| a.workflow_id == workflow_id && a.kind == kind && a.agent_id == agent_id)
        {
            row.current_task = Some(match task {
                Some(stored) => enc.decrypt(&stored)?,
                None => String::new(),
            });
            row.current_run_id = run_id;
        }
    }
    Ok(out)
}

/// What one library agent has been doing in chat (turns run as it, and tasks
/// the assistant or another agent handed it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatAgentActivity {
    pub agent_id: String,
    pub current_task: Option<String>,
    pub current_conversation_id: Option<String>,
    pub last_active: Option<String>,
    /// Tasks and tokens since the `since` asked for.
    pub tasks: u64,
    pub failed: u64,
    pub tokens: u64,
}

/// Every agent's chat activity: calls with no run, grouped by agent.
pub async fn chat_agent_activity(
    pool: &SqlitePool,
    enc: &Encryption,
    since: &str,
) -> Result<Vec<ChatAgentActivity>, DbError> {
    type Row = (String, Option<String>, i64, i64, i64);
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT agent_id, MAX(started_at), \
         SUM(CASE WHEN started_at >= ? THEN 1 ELSE 0 END), \
         SUM(CASE WHEN started_at >= ? AND status = 'failed' THEN 1 ELSE 0 END), \
         SUM(CASE WHEN started_at >= ? THEN tokens ELSE 0 END) \
         FROM agent_calls WHERE run_id IS NULL GROUP BY agent_id",
    )
    .bind(since)
    .bind(since)
    .bind(since)
    .fetch_all(pool)
    .await?;
    let running: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT agent_id, task, conversation_id FROM agent_calls \
         WHERE status = 'running' AND run_id IS NULL ORDER BY started_at",
    )
    .fetch_all(pool)
    .await?;
    let count = |n: i64| u64::try_from(n).unwrap_or(0);
    let mut out: Vec<ChatAgentActivity> = rows
        .into_iter()
        .map(
            |(agent_id, last_active, tasks, failed, tokens)| ChatAgentActivity {
                agent_id,
                current_task: None,
                current_conversation_id: None,
                last_active,
                tasks: count(tasks),
                failed: count(failed),
                tokens: count(tokens),
            },
        )
        .collect();
    // The latest task each running agent took on.
    for (agent_id, task, conversation_id) in running {
        if let Some(row) = out.iter_mut().find(|a| a.agent_id == agent_id) {
            row.current_task = Some(match task {
                Some(stored) => enc.decrypt(&stored)?,
                None => String::new(),
            });
            row.current_conversation_id = conversation_id;
        }
    }
    Ok(out)
}
