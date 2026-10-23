//! The user's agents, defined once and used in any workflow (migration 0042).
//!
//! `definition_json` holds the agent as a workflow helper (`AgentDef`),
//! encrypted at rest like a workflow definition. See `crate::agents`.

use sqlx::{Sqlite, SqlitePool, Transaction};

use crate::workflows::definition::AgentDef;
use crate::{db::DbError, encryption::Encryption, time::now_iso8601};

/// A stored agent with its timestamps.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentRecord {
    pub agent: AgentDef,
    pub created_at: String,
    pub updated_at: String,
}

type AgentRow = (String, String, String, String);

fn record(enc: &Encryption, row: AgentRow) -> Result<AgentRecord, DbError> {
    let (id, definition_json, created_at, updated_at) = row;
    let text = enc.decrypt(&definition_json)?;
    let mut agent: AgentDef = serde_json::from_str(&text)
        .map_err(|e| DbError::Query(format!("stored agent is invalid: {e}")))?;
    // The row's id is the agent's id, whatever the JSON says.
    agent.id = id;
    agent.library = None;
    Ok(AgentRecord {
        agent,
        created_at,
        updated_at,
    })
}

fn encode(enc: &Encryption, agent: &AgentDef) -> Result<String, DbError> {
    let json = serde_json::to_string(agent)
        .map_err(|e| DbError::Query(format!("agent can't be stored: {e}")))?;
    enc.encrypt(&json)
}

const COLUMNS: &str = "id, definition_json, created_at, updated_at";

/// Every agent, in id order (callers sort by name).
pub async fn list(pool: &SqlitePool, enc: &Encryption) -> Result<Vec<AgentRecord>, DbError> {
    let rows: Vec<AgentRow> = sqlx::query_as(&format!("SELECT {COLUMNS} FROM agents ORDER BY id"))
        .fetch_all(pool)
        .await?;
    rows.into_iter().map(|r| record(enc, r)).collect()
}

pub async fn get(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
) -> Result<Option<AgentRecord>, DbError> {
    let row: Option<AgentRow> =
        sqlx::query_as(&format!("SELECT {COLUMNS} FROM agents WHERE id = ?"))
            .bind(id)
            .fetch_optional(pool)
            .await?;
    row.map(|r| record(enc, r)).transpose()
}

/// Add an agent under `agent.id`; fails when that id is taken.
pub async fn insert(
    pool: &SqlitePool,
    enc: &Encryption,
    agent: &AgentDef,
) -> Result<AgentRecord, DbError> {
    let now = now_iso8601();
    sqlx::query(
        "INSERT INTO agents (id, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&agent.id)
    .bind(encode(enc, agent)?)
    .bind(&now)
    .bind(&now)
    .execute(pool)
    .await?;
    get(pool, enc, &agent.id)
        .await?
        .ok_or_else(|| DbError::Query("agent vanished after insert".into()))
}

/// Replace an agent's definition; fails when there is none under `agent.id`.
pub async fn update(
    pool: &SqlitePool,
    enc: &Encryption,
    agent: &AgentDef,
) -> Result<AgentRecord, DbError> {
    let done = sqlx::query("UPDATE agents SET definition_json = ?, updated_at = ? WHERE id = ?")
        .bind(encode(enc, agent)?)
        .bind(now_iso8601())
        .bind(&agent.id)
        .execute(pool)
        .await?;
    if done.rows_affected() == 0 {
        return Err(DbError::Query(format!("no agent {}", agent.id)));
    }
    get(pool, enc, &agent.id)
        .await?
        .ok_or_else(|| DbError::Query(format!("no agent {}", agent.id)))
}

/// Every workflow's id, name and stored definition (undecrypted, JSON).
pub async fn workflow_definitions(
    pool: &SqlitePool,
    enc: &Encryption,
) -> Result<Vec<(String, String, serde_json::Value)>, DbError> {
    let rows: Vec<(String, String, String)> =
        sqlx::query_as("SELECT id, name, definition_json FROM workflows ORDER BY updated_at DESC")
            .fetch_all(pool)
            .await?;
    rows.into_iter()
        .map(|(id, name, stored)| {
            let text = enc.decrypt(&stored)?;
            let value = serde_json::from_str(&text)
                .map_err(|e| DbError::Query(format!("stored JSON is invalid: {e}")))?;
            Ok((id, name, value))
        })
        .collect()
}

/// Replace a workflow's stored definition inside `tx`, as an edit does: its
/// version goes up by one.
pub async fn replace_workflow_definition(
    tx: &mut Transaction<'_, Sqlite>,
    enc: &Encryption,
    id: &str,
    definition: &serde_json::Value,
) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE workflows SET definition_json = ?, version = version + 1, updated_at = ? WHERE id = ?",
    )
    .bind(enc.encrypt(&definition.to_string())?)
    .bind(now_iso8601())
    .bind(id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Replace an agent's definition inside `tx` (its other agents changed).
pub async fn update_in(
    tx: &mut Transaction<'_, Sqlite>,
    enc: &Encryption,
    agent: &AgentDef,
) -> Result<(), DbError> {
    sqlx::query("UPDATE agents SET definition_json = ?, updated_at = ? WHERE id = ?")
        .bind(encode(enc, agent)?)
        .bind(now_iso8601())
        .bind(&agent.id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Remove an agent inside `tx`.
pub async fn delete_in(tx: &mut Transaction<'_, Sqlite>, id: &str) -> Result<(), DbError> {
    sqlx::query("DELETE FROM agents WHERE id = ?")
        .bind(id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Whether the starter agents were already offered (a key in `settings`).
pub async fn starters_offered(pool: &SqlitePool) -> Result<bool, DbError> {
    let value: Option<String> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'agentsSeeded'")
            .fetch_optional(pool)
            .await?;
    Ok(value.as_deref() == Some("true"))
}

pub async fn mark_starters_offered(pool: &SqlitePool) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('agentsSeeded', 'true') \
         ON CONFLICT(key) DO UPDATE SET value = 'true'",
    )
    .execute(pool)
    .await?;
    Ok(())
}
