//! "Always allow for this page" network grants (ADR-010).
//!
//! One row per artifact and https origin. Session-only grants ("Allow this
//! time") are not stored; see `artifact_network`.

use serde::Serialize;
use sqlx::SqlitePool;

use crate::{db::DbError, time::now_iso8601};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactNetworkGrant {
    pub artifact_id: String,
    pub host: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
    /// The artifact's title, for the Settings list. `None` when untitled.
    pub artifact_title: Option<String>,
}

/// Record that the user always allows `host` for `artifact_id`. Idempotent.
pub async fn grant(pool: &SqlitePool, artifact_id: &str, host: &str) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO artifact_network_grants (artifact_id, host, created_at) VALUES (?, ?, ?) \
         ON CONFLICT(artifact_id, host) DO NOTHING",
    )
    .bind(artifact_id)
    .bind(host)
    .bind(now_iso8601())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn is_granted(pool: &SqlitePool, artifact_id: &str, host: &str) -> Result<bool, DbError> {
    let row: Option<(i64,)> =
        sqlx::query_as("SELECT 1 FROM artifact_network_grants WHERE artifact_id = ? AND host = ?")
            .bind(artifact_id)
            .bind(host)
            .fetch_optional(pool)
            .await?;
    Ok(row.is_some())
}

pub async fn touch(pool: &SqlitePool, artifact_id: &str, host: &str) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE artifact_network_grants SET last_used_at = ? WHERE artifact_id = ? AND host = ?",
    )
    .bind(now_iso8601())
    .bind(artifact_id)
    .bind(host)
    .execute(pool)
    .await?;
    Ok(())
}

/// `artifact_id, host, created_at, last_used_at, title` as selected by [`list`].
type GrantRow = (String, String, String, Option<String>, Option<String>);

/// Grants for one artifact, or for every artifact when `artifact_id` is `None`.
pub async fn list(
    pool: &SqlitePool,
    artifact_id: Option<&str>,
) -> Result<Vec<ArtifactNetworkGrant>, DbError> {
    let rows: Vec<GrantRow> = sqlx::query_as(
        "SELECT g.artifact_id, g.host, g.created_at, g.last_used_at, a.title \
         FROM artifact_network_grants g JOIN artifacts a ON a.id = g.artifact_id \
         WHERE (?1 IS NULL OR g.artifact_id = ?1) \
         ORDER BY COALESCE(g.last_used_at, g.created_at) DESC",
    )
    .bind(artifact_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(artifact_id, host, created_at, last_used_at, artifact_title)| ArtifactNetworkGrant {
                artifact_id,
                host,
                created_at,
                last_used_at,
                artifact_title,
            },
        )
        .collect())
}

pub async fn revoke(pool: &SqlitePool, artifact_id: &str, host: &str) -> Result<(), DbError> {
    sqlx::query("DELETE FROM artifact_network_grants WHERE artifact_id = ? AND host = ?")
        .bind(artifact_id)
        .bind(host)
        .execute(pool)
        .await?;
    Ok(())
}

/// Remove every grant, or every grant of one artifact.
pub async fn clear(pool: &SqlitePool, artifact_id: Option<&str>) -> Result<(), DbError> {
    sqlx::query("DELETE FROM artifact_network_grants WHERE (?1 IS NULL OR artifact_id = ?1)")
        .bind(artifact_id)
        .execute(pool)
        .await?;
    Ok(())
}
