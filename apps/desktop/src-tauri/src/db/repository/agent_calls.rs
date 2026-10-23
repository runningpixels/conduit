//! Agents at work, in workflows and in chat (migration 0043).
//!
//! One row each time an agent takes on a task: an agent step of a run, a
//! helper it handed a task to, or a chat turn run as a library agent. The
//! Agents page reads the totals back.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::{db::DbError, encryption::Encryption, time::now_iso8601};

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
         agent_id, parent_id, task, model, status, started_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)",
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
    .bind(now_iso8601())
    .execute(pool)
    .await?;
    Ok(id)
}

/// Record how an agent's task ended: `error` is `None` when it answered.
pub async fn finish_agent_call(
    pool: &SqlitePool,
    id: &str,
    tokens: u64,
    error: Option<&str>,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE agent_calls SET status = ?, error = ?, tokens = ?, finished_at = ? WHERE id = ?",
    )
    .bind(if error.is_some() { "failed" } else { "done" })
    .bind(error)
    .bind(i64::try_from(tokens).unwrap_or(i64::MAX))
    .bind(now_iso8601())
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
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
