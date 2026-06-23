//! `tenant_config_cache` repository (M5) — thin persistence.
//!
//! Caches a `TenantConfig` fetched from the cloud (Phase 7 fetches it; Phase 3
//! stores it). `get_tenant_config` returns `None` when the cached entry is stale
//! (`expires_at < now`); a NULL `expires_at` is treated as non-expiring.

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::{
    db::DbError,
    encryption::Encryption,
    time::now_iso8601,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TenantConfigCache {
    pub id: String,
    pub version: String,
    pub config_json: serde_json::Value,
    pub fetched_at: String,
    pub expires_at: Option<String>,
}

/// Insert or update a cached tenant config. `config_json` is encrypted at the
/// bind boundary when `enc.tier() == On` (the tenant config can carry
/// entitlement/quota details worth protecting at rest).
pub async fn upsert_tenant_config(
    pool: &SqlitePool,
    enc: &Encryption,
    entry: &TenantConfigCache,
) -> Result<(), DbError> {
    let stored_json = enc.encrypt(&entry.config_json.to_string())?;
    let enc_key_version = if enc.is_on() {
        Some(enc.key_version() as i64)
    } else {
        None
    };
    sqlx::query(
        "INSERT INTO tenant_config_cache \
         (id, version, config_json, fetched_at, expires_at, enc_key_version) \
         VALUES (?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
           version=excluded.version, config_json=excluded.config_json, \
           fetched_at=excluded.fetched_at, expires_at=excluded.expires_at, \
           enc_key_version=excluded.enc_key_version",
    )
    .bind(&entry.id)
    .bind(&entry.version)
    .bind(&stored_json)
    .bind(&entry.fetched_at)
    .bind(&entry.expires_at)
    .bind(enc_key_version)
    .execute(pool)
    .await?;
    Ok(())
}

/// Fetch the cached config for `id`, or `None` if missing or stale
/// (`expires_at < now`). A NULL `expires_at` is non-expiring. The stored
/// `config_json` is decrypted before returning.
pub async fn get_tenant_config(
    pool: &SqlitePool,
    enc: &Encryption,
    id: &str,
) -> Result<Option<TenantConfigCache>, DbError> {
    let row: Option<(String, String, String, Option<String>)> = sqlx::query_as(
        "SELECT version, config_json, fetched_at, expires_at \
         FROM tenant_config_cache WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;

    let Some((version, config_json, fetched_at, expires_at)) = row else {
        return Ok(None);
    };

    if let Some(exp) = &expires_at {
        if !exp.is_empty() && exp.as_str() < now_iso8601().as_str() {
            return Ok(None);
        }
    }

    let plain = enc.decrypt(&config_json)?;
    Ok(Some(TenantConfigCache {
        id: id.to_string(),
        version,
        config_json: serde_json::from_str(&plain).unwrap_or(serde_json::Value::Null),
        fetched_at,
        expires_at,
    }))
}

/// Drop the cached entry for `id` (forces a re-fetch on next read).
pub async fn invalidate(pool: &SqlitePool, id: &str) -> Result<(), DbError> {
    sqlx::query("DELETE FROM tenant_config_cache WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}