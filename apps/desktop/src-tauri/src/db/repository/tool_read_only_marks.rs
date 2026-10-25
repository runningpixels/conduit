//! Connector tools the user marked as only reading (#22).
//!
//! A tool that declares nothing asks first. A mark lets such a tool run
//! without asking; it never overrides what a tool declares itself (see
//! `McpTool::apply_user_read_only`).

use std::collections::HashSet;

use sqlx::SqlitePool;

use crate::time::now_iso8601;

/// The tools of `connector_id` the user marked as only reading.
pub async fn list(pool: &SqlitePool, connector_id: &str) -> Result<HashSet<String>, sqlx::Error> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT tool_name FROM connector_tool_read_only WHERE connector_id = ?")
            .bind(connector_id)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(name,)| name).collect())
}

/// Mark `tool_name` as only reading, or take the mark away.
pub async fn set(
    pool: &SqlitePool,
    connector_id: &str,
    tool_name: &str,
    read_only: bool,
) -> Result<(), sqlx::Error> {
    if read_only {
        sqlx::query(
            "INSERT OR IGNORE INTO connector_tool_read_only (connector_id, tool_name, created_at) \
             VALUES (?, ?, ?)",
        )
        .bind(connector_id)
        .bind(tool_name)
        .bind(now_iso8601())
        .execute(pool)
        .await?;
    } else {
        sqlx::query(
            "DELETE FROM connector_tool_read_only WHERE connector_id = ? AND tool_name = ?",
        )
        .bind(connector_id)
        .bind(tool_name)
        .execute(pool)
        .await?;
    }
    Ok(())
}
