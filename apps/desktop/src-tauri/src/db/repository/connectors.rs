//! `connector_*` repositories (M5) — schema + thin persistence APIs only.
//!
//! The runtime that fills these (MCP supervision, consent, transport) is Phase 4.
//! Phase 3 owns the tables + the create/read/revoke primitives the shell needs to
//! display connector state. Versions are **immutable** (INSERT only); grants are
//! revocable; runtime state + capabilities are upserted (replace-batch for caps).

use serde::{Deserialize, Serialize};
use sqlx::{SqlitePool, Transaction};
use uuid::Uuid;

use crate::{db::DbError, time::now_iso8601};

// --- types -------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub transport: String,
    pub owner: String,
    pub icon: Option<String>,
    pub support_url: Option<String>,
    pub consent_copy: Option<String>,
    pub policy_metadata: Option<serde_json::Value>,
    pub cloud_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorVersion {
    pub id: String,
    pub connector_id: String,
    pub version: String,
    pub transport_config: serde_json::Value,
    pub scope_grants: Option<serde_json::Value>,
    pub capability_allowlist: Option<serde_json::Value>,
    pub rollout_channel: Option<String>,
    pub support_state: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorGrant {
    pub id: String,
    pub connector_version_id: String,
    pub scope: String,
    pub status: String,
    pub credential_ref: Option<String>,
    pub approved_by: Option<String>,
    pub revoked_at: Option<String>,
    pub notes: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorRuntimeState {
    pub connector_version_id: String,
    pub health: String,
    pub last_started_at: Option<String>,
    pub last_error: Option<String>,
    pub restart_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectorCapability {
    pub id: String,
    pub connector_version_id: String,
    pub kind: String,
    pub name: String,
    pub schema_json: Option<serde_json::Value>,
    pub discovered_at: String,
}

// --- definitions -------------------------------------------------------------

/// Insert or update a connector definition by id. `created_at` is preserved on
/// update; `updated_at` is bumped.
pub async fn upsert_definition(
    pool: &SqlitePool,
    def: &ConnectorDefinition,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO connector_definitions \
         (id, name, description, transport, owner, icon, support_url, consent_copy, \
          policy_metadata, cloud_id, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
           name=excluded.name, description=excluded.description, transport=excluded.transport, \
           owner=excluded.owner, icon=excluded.icon, support_url=excluded.support_url, \
           consent_copy=excluded.consent_copy, policy_metadata=excluded.policy_metadata, \
           cloud_id=excluded.cloud_id, updated_at=excluded.updated_at",
    )
    .bind(&def.id)
    .bind(&def.name)
    .bind(&def.description)
    .bind(&def.transport)
    .bind(&def.owner)
    .bind(&def.icon)
    .bind(&def.support_url)
    .bind(&def.consent_copy)
    .bind(def.policy_metadata.as_ref().map(|v| v.to_string()))
    .bind(&def.cloud_id)
    .bind(&def.created_at)
    .bind(&def.updated_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get(pool: &SqlitePool, id: &str) -> Result<Option<ConnectorDefinition>, DbError> {
    let row: Option<(
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
    )> = sqlx::query_as(
        "SELECT id, name, description, transport, owner, icon, support_url, consent_copy, \
                policy_metadata, cloud_id, created_at, updated_at \
         FROM connector_definitions WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(
            id,
            name,
            description,
            transport,
            owner,
            icon,
            support_url,
            consent_copy,
            policy_metadata,
            cloud_id,
            created_at,
            updated_at,
        )| ConnectorDefinition {
            id,
            name,
            description,
            transport,
            owner,
            icon,
            support_url,
            consent_copy,
            policy_metadata: policy_metadata.and_then(|s| serde_json::from_str(&s).ok()),
            cloud_id,
            created_at,
            updated_at,
        },
    ))
}

pub async fn list_definitions(pool: &SqlitePool) -> Result<Vec<ConnectorDefinition>, DbError> {
    let rows: Vec<(
        String,
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
        String,
    )> = sqlx::query_as(
        "SELECT id, name, description, transport, owner, icon, support_url, consent_copy, \
                policy_metadata, cloud_id, created_at, updated_at \
         FROM connector_definitions ORDER BY name ASC",
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
                transport,
                owner,
                icon,
                support_url,
                consent_copy,
                policy_metadata,
                cloud_id,
                created_at,
                updated_at,
            )| ConnectorDefinition {
                id,
                name,
                description,
                transport,
                owner,
                icon,
                support_url,
                consent_copy,
                policy_metadata: policy_metadata.and_then(|s| serde_json::from_str(&s).ok()),
                cloud_id,
                created_at,
                updated_at,
            },
        )
        .collect())
}

// --- versions (immutable) ----------------------------------------------------

/// Insert a version. Versions are immutable — a duplicate `(connector_id, version)`
/// is rejected rather than overwritten.
pub async fn insert_version(pool: &SqlitePool, v: &ConnectorVersion) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO connector_versions \
         (id, connector_id, version, transport_config, scope_grants, capability_allowlist, \
          rollout_channel, support_state, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&v.id)
    .bind(&v.connector_id)
    .bind(&v.version)
    .bind(v.transport_config.to_string())
    .bind(v.scope_grants.as_ref().map(|v| v.to_string()))
    .bind(v.capability_allowlist.as_ref().map(|v| v.to_string()))
    .bind(&v.rollout_channel)
    .bind(&v.support_state)
    .bind(&v.created_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_versions(
    pool: &SqlitePool,
    connector_id: &str,
) -> Result<Vec<ConnectorVersion>, DbError> {
    let rows: Vec<(
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
    )> = sqlx::query_as(
        "SELECT id, connector_id, version, transport_config, scope_grants, \
                capability_allowlist, rollout_channel, support_state, created_at \
         FROM connector_versions WHERE connector_id = ? ORDER BY created_at ASC",
    )
    .bind(connector_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                connector_id,
                version,
                transport_config,
                scope_grants,
                capability_allowlist,
                rollout_channel,
                support_state,
                created_at,
            )| ConnectorVersion {
                id,
                connector_id,
                version,
                transport_config: serde_json::from_str(&transport_config)
                    .unwrap_or(serde_json::Value::Null),
                scope_grants: scope_grants.and_then(|s| serde_json::from_str(&s).ok()),
                capability_allowlist: capability_allowlist
                    .and_then(|s| serde_json::from_str(&s).ok()),
                rollout_channel,
                support_state,
                created_at,
            },
        )
        .collect())
}

/// Fetch a single version by id. Phase 4's runtime needs this to load a
/// connector's `transport_config` + `support_state` for a given version.
pub async fn get_version(
    pool: &SqlitePool,
    version_id: &str,
) -> Result<Option<ConnectorVersion>, DbError> {
    let row: Option<(
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
    )> = sqlx::query_as(
        "SELECT id, connector_id, version, transport_config, scope_grants, \
                capability_allowlist, rollout_channel, support_state, created_at \
         FROM connector_versions WHERE id = ?",
    )
    .bind(version_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(
            id,
            connector_id,
            version,
            transport_config,
            scope_grants,
            capability_allowlist,
            rollout_channel,
            support_state,
            created_at,
        )| ConnectorVersion {
            id,
            connector_id,
            version,
            transport_config: serde_json::from_str(&transport_config)
                .unwrap_or(serde_json::Value::Null),
            scope_grants: scope_grants.and_then(|s| serde_json::from_str(&s).ok()),
            capability_allowlist: capability_allowlist.and_then(|s| serde_json::from_str(&s).ok()),
            rollout_channel,
            support_state,
            created_at,
        },
    ))
}

/// Grants for a specific version. Phase 4 checks that an `Active` grant exists
/// before launching a connector.
pub async fn list_grants_for_version(
    pool: &SqlitePool,
    connector_version_id: &str,
) -> Result<Vec<ConnectorGrant>, DbError> {
    let rows: Vec<(
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
    )> = sqlx::query_as(
        "SELECT id, connector_version_id, scope, status, credential_ref, approved_by, \
                revoked_at, notes, created_at \
         FROM connector_grants WHERE connector_version_id = ? ORDER BY created_at ASC",
    )
    .bind(connector_version_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                connector_version_id,
                scope,
                status,
                credential_ref,
                approved_by,
                revoked_at,
                notes,
                created_at,
            )| ConnectorGrant {
                id,
                connector_version_id,
                scope,
                status,
                credential_ref,
                approved_by,
                revoked_at,
                notes,
                created_at,
            },
        )
        .collect())
}

// --- grants ------------------------------------------------------------------

pub async fn upsert_grant(pool: &SqlitePool, g: &ConnectorGrant) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO connector_grants \
         (id, connector_version_id, scope, status, credential_ref, approved_by, revoked_at, \
          notes, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
           status=excluded.status, credential_ref=excluded.credential_ref, \
           approved_by=excluded.approved_by, revoked_at=excluded.revoked_at, notes=excluded.notes",
    )
    .bind(&g.id)
    .bind(&g.connector_version_id)
    .bind(&g.scope)
    .bind(&g.status)
    .bind(&g.credential_ref)
    .bind(&g.approved_by)
    .bind(&g.revoked_at)
    .bind(&g.notes)
    .bind(&g.created_at)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_grants(
    pool: &SqlitePool,
    status: Option<&str>,
) -> Result<Vec<ConnectorGrant>, DbError> {
    let rows: Vec<(
        String,
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
    )> = if let Some(status) = status {
        sqlx::query_as(
            "SELECT id, connector_version_id, scope, status, credential_ref, approved_by, \
                    revoked_at, notes, created_at \
             FROM connector_grants WHERE status = ? ORDER BY created_at ASC",
        )
        .bind(status)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as(
            "SELECT id, connector_version_id, scope, status, credential_ref, approved_by, \
                    revoked_at, notes, created_at \
             FROM connector_grants ORDER BY created_at ASC",
        )
        .fetch_all(pool)
        .await?
    };
    Ok(rows
        .into_iter()
        .map(
            |(
                id,
                connector_version_id,
                scope,
                status,
                credential_ref,
                approved_by,
                revoked_at,
                notes,
                created_at,
            )| ConnectorGrant {
                id,
                connector_version_id,
                scope,
                status,
                credential_ref,
                approved_by,
                revoked_at,
                notes,
                created_at,
            },
        )
        .collect())
}

/// Revoke a grant: set `status = 'revoked'` + `revoked_at`. Idempotent.
pub async fn revoke_grant(
    pool: &SqlitePool,
    id: &str,
    revoked_at: Option<&str>,
) -> Result<(), DbError> {
    sqlx::query("UPDATE connector_grants SET status = 'revoked', revoked_at = ? WHERE id = ?")
        .bind(revoked_at.unwrap_or_else(|| ""))
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

// --- runtime state + capabilities --------------------------------------------

pub async fn upsert_runtime_state(
    pool: &SqlitePool,
    state: &ConnectorRuntimeState,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO connector_runtime_state \
         (connector_version_id, health, last_started_at, last_error, restart_count) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(connector_version_id) DO UPDATE SET \
           health=excluded.health, last_started_at=excluded.last_started_at, \
           last_error=excluded.last_error, restart_count=excluded.restart_count",
    )
    .bind(&state.connector_version_id)
    .bind(&state.health)
    .bind(&state.last_started_at)
    .bind(&state.last_error)
    .bind(state.restart_count)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_runtime_state(
    pool: &SqlitePool,
    connector_version_id: &str,
) -> Result<Option<ConnectorRuntimeState>, DbError> {
    let row: Option<(String, Option<String>, Option<String>, i64)> = sqlx::query_as(
        "SELECT health, last_started_at, last_error, restart_count \
         FROM connector_runtime_state WHERE connector_version_id = ?",
    )
    .bind(connector_version_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(health, last_started_at, last_error, restart_count)| ConnectorRuntimeState {
            connector_version_id: connector_version_id.to_string(),
            health,
            last_started_at,
            last_error,
            restart_count,
        },
    ))
}

/// All persisted runtime states (Phase 4 M4.6: the connectors rail renders a
/// snapshot of every version's health/restart count).
pub async fn list_runtime_states(pool: &SqlitePool) -> Result<Vec<ConnectorRuntimeState>, DbError> {
    let rows: Vec<(String, String, Option<String>, Option<String>, i64)> = sqlx::query_as(
        "SELECT connector_version_id, health, last_started_at, last_error, restart_count \
         FROM connector_runtime_state ORDER BY connector_version_id ASC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(connector_version_id, health, last_started_at, last_error, restart_count)| {
                ConnectorRuntimeState {
                    connector_version_id,
                    health,
                    last_started_at,
                    last_error,
                    restart_count,
                }
            },
        )
        .collect())
}

/// Replace a version's discovered capabilities in one transaction (delete the
/// prior batch, insert the new one). Supports empty caps to clear the cache
/// for a version (e.g. after allowlist filters everything).
pub async fn upsert_capabilities(
    pool: &SqlitePool,
    connector_version_id: &str,
    caps: &[ConnectorCapability],
) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;
    upsert_capabilities_in_txn(&mut tx, connector_version_id, caps).await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn upsert_capabilities_in_txn(
    tx: &mut Transaction<'_, sqlx::Sqlite>,
    connector_version_id: &str,
    caps: &[ConnectorCapability],
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM connector_capabilities WHERE connector_version_id = ?")
        .bind(connector_version_id)
        .execute(&mut **tx)
        .await?;
    for cap in caps {
        sqlx::query(
            "INSERT INTO connector_capabilities \
             (id, connector_version_id, kind, name, schema_json, discovered_at) \
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(&cap.id)
        .bind(&cap.connector_version_id)
        .bind(&cap.kind)
        .bind(&cap.name)
        .bind(cap.schema_json.as_ref().map(|v| v.to_string()))
        .bind(&cap.discovered_at)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/// Helper for callers/tests: build a capability with a fresh id.
pub fn new_capability(
    connector_version_id: &str,
    kind: &str,
    name: &str,
    schema_json: Option<serde_json::Value>,
) -> ConnectorCapability {
    ConnectorCapability {
        id: Uuid::new_v4().to_string(),
        connector_version_id: connector_version_id.to_string(),
        kind: kind.to_string(),
        name: name.to_string(),
        schema_json,
        discovered_at: now_iso8601(),
    }
}

/// All cached capabilities for a connector version, in discovery order.
pub async fn list_capabilities(
    pool: &SqlitePool,
    connector_version_id: &str,
) -> Result<Vec<ConnectorCapability>, DbError> {
    let rows: Vec<(String, String, String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT id, connector_version_id, kind, name, schema_json, discovered_at \
         FROM connector_capabilities WHERE connector_version_id = ? \
         ORDER BY discovered_at ASC",
    )
    .bind(connector_version_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, cvi, kind, name, schema_json, discovered_at)| ConnectorCapability {
                id,
                connector_version_id: cvi,
                kind,
                name,
                schema_json: schema_json.and_then(|s| serde_json::from_str(&s).ok()),
                discovered_at,
            },
        )
        .collect())
}

/// Resolve a single capability by `(connector_version_id, name)`. The Phase 4
/// execution path uses this to turn an MCP tool id into the cached capability
/// (and thus its `kind` + schema) before consent/invocation.
pub async fn get_capability_by_name(
    pool: &SqlitePool,
    connector_version_id: &str,
    name: &str,
) -> Result<Option<ConnectorCapability>, DbError> {
    let row: Option<(String, String, String, String, Option<String>, String)> = sqlx::query_as(
        "SELECT id, connector_version_id, kind, name, schema_json, discovered_at \
         FROM connector_capabilities WHERE connector_version_id = ? AND name = ?",
    )
    .bind(connector_version_id)
    .bind(name)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(id, cvi, kind, name, schema_json, discovered_at)| ConnectorCapability {
            id,
            connector_version_id: cvi,
            kind,
            name,
            schema_json: schema_json.and_then(|s| serde_json::from_str(&s).ok()),
            discovered_at,
        },
    ))
}
