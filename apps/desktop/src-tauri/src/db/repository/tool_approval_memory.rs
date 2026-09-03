//! Per-tool approval memory (t1-2 M3).
//!
//! Remembers that the user allowed a side-effectful MCP tool for this chat or
//! always. Sensitive tools must never be stored — callers enforce that before
//! insert. Redaction / path policy / reinjection still run on remembered Auto.

use sqlx::SqlitePool;
use thiserror::Error;
use uuid::Uuid;

use crate::time::now_iso8601;

#[derive(Debug, Error)]
pub enum ApprovalMemoryError {
    #[error("database error: {0}")]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    Invalid(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalScope {
    Conversation,
    Always,
}

impl ApprovalScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Conversation => "conversation",
            Self::Always => "always",
        }
    }

    pub fn parse(s: &str) -> Result<Self, ApprovalMemoryError> {
        match s {
            "conversation" => Ok(Self::Conversation),
            "always" => Ok(Self::Always),
            other => Err(ApprovalMemoryError::Invalid(format!(
                "unknown approval scope '{other}'"
            ))),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalMemoryRow {
    pub id: String,
    pub tool_key: String,
    pub scope: String,
    pub conversation_id: Option<String>,
    pub created_at: String,
}

pub fn tool_key(connector_version_id: &str, tool_name: &str) -> String {
    format!("{connector_version_id}::{tool_name}")
}

/// True when a remembered approval covers this tool for the given conversation.
pub async fn is_remembered(
    pool: &SqlitePool,
    connector_version_id: &str,
    tool_name: &str,
    conversation_id: Option<&str>,
) -> Result<bool, ApprovalMemoryError> {
    let key = tool_key(connector_version_id, tool_name);
    let always: Option<(String,)> = sqlx::query_as(
        "SELECT id FROM tool_approval_memory WHERE tool_key = ? AND scope = 'always' LIMIT 1",
    )
    .bind(&key)
    .fetch_optional(pool)
    .await?;
    if always.is_some() {
        return Ok(true);
    }
    if let Some(cid) = conversation_id {
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT id FROM tool_approval_memory \
             WHERE tool_key = ? AND scope = 'conversation' AND conversation_id = ? LIMIT 1",
        )
        .bind(&key)
        .bind(cid)
        .fetch_optional(pool)
        .await?;
        return Ok(row.is_some());
    }
    Ok(false)
}

pub async fn remember(
    pool: &SqlitePool,
    connector_version_id: &str,
    tool_name: &str,
    scope: ApprovalScope,
    conversation_id: Option<&str>,
) -> Result<(), ApprovalMemoryError> {
    if scope == ApprovalScope::Conversation
        && conversation_id.map(str::trim).unwrap_or("").is_empty()
    {
        return Err(ApprovalMemoryError::Invalid(
            "conversation-scoped approval requires a conversation id".into(),
        ));
    }
    let key = tool_key(connector_version_id, tool_name);
    let exists = match scope {
        ApprovalScope::Always => {
            let row: Option<(String,)> = sqlx::query_as(
                "SELECT id FROM tool_approval_memory WHERE tool_key = ? AND scope = 'always' LIMIT 1",
            )
            .bind(&key)
            .fetch_optional(pool)
            .await?;
            row.is_some()
        }
        ApprovalScope::Conversation => {
            let cid = conversation_id.unwrap();
            let row: Option<(String,)> = sqlx::query_as(
                "SELECT id FROM tool_approval_memory \
                 WHERE tool_key = ? AND scope = 'conversation' AND conversation_id = ? LIMIT 1",
            )
            .bind(&key)
            .bind(cid)
            .fetch_optional(pool)
            .await?;
            row.is_some()
        }
    };
    if exists {
        return Ok(());
    }
    let id = Uuid::new_v4().to_string();
    let cid = match scope {
        ApprovalScope::Always => None,
        ApprovalScope::Conversation => conversation_id.map(|s| s.to_string()),
    };
    sqlx::query(
        "INSERT INTO tool_approval_memory (id, tool_key, scope, conversation_id, created_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&key)
    .bind(scope.as_str())
    .bind(cid)
    .bind(now_iso8601())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_all(pool: &SqlitePool) -> Result<Vec<ApprovalMemoryRow>, ApprovalMemoryError> {
    let rows: Vec<(String, String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT id, tool_key, scope, conversation_id, created_at \
         FROM tool_approval_memory ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, tool_key, scope, conversation_id, created_at)| ApprovalMemoryRow {
                id,
                tool_key,
                scope,
                conversation_id,
                created_at,
            },
        )
        .collect())
}

pub async fn revoke(pool: &SqlitePool, id: &str) -> Result<bool, ApprovalMemoryError> {
    let result = sqlx::query("DELETE FROM tool_approval_memory WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}
