//! `licenses` + `license_key_sets` repositories (M5) — thin persistence.
//!
//! One current license per `(tenant_id, seat_id)` (the row id is
//! `{tenant_id}:{seat_id}` so re-issuance upserts in place). The signature
//! verification loop, refresh, and tenant-policy tier flip are Phase 7; Phase 3
//! stores the claims + the monotonic `last_seen_server_time` anchor (spec §11).

use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::{db::DbError, encryption::Encryption};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct License {
    pub id: String,
    pub tenant_id: String,
    pub seat_id: String,
    pub tier: String,
    pub token: String,
    pub exp: i64,
    pub config_version: String,
    pub key_set_version: Option<String>,
    pub feature_flags: Option<serde_json::Value>,
    pub offline_grace_deadline: Option<i64>,
    pub issued_at: Option<i64>,
    pub last_seen_server_time: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseKeySet {
    pub version: String,
    pub public_keys: serde_json::Value,
    pub fetched_at: String,
    pub is_active: bool,
}

fn license_id(tenant_id: &str, seat_id: &str) -> String {
    format!("{tenant_id}:{seat_id}")
}

/// Insert or update the current license for `(tenant_id, seat_id)`. On update
/// `created_at` is preserved; `last_seen_server_time` is set from the claims.
pub async fn upsert_license(
    pool: &SqlitePool,
    enc: &Encryption,
    lic: &License,
) -> Result<(), DbError> {
    let id = license_id(&lic.tenant_id, &lic.seat_id);
    let stored_token = enc.encrypt(&lic.token)?;
    let enc_key_version = if enc.is_on() {
        Some(enc.key_version() as i64)
    } else {
        None
    };
    sqlx::query(
        "INSERT INTO licenses \
         (id, tenant_id, seat_id, tier, token, exp, config_version, key_set_version, \
          feature_flags, offline_grace_deadline, issued_at, last_seen_server_time, \
          enc_key_version, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(id) DO UPDATE SET \
           tier=excluded.tier, token=excluded.token, exp=excluded.exp, \
           config_version=excluded.config_version, key_set_version=excluded.key_set_version, \
           feature_flags=excluded.feature_flags, \
           offline_grace_deadline=excluded.offline_grace_deadline, \
           issued_at=excluded.issued_at, last_seen_server_time=excluded.last_seen_server_time, \
           enc_key_version=excluded.enc_key_version",
    )
    .bind(&id)
    .bind(&lic.tenant_id)
    .bind(&lic.seat_id)
    .bind(&lic.tier)
    .bind(&stored_token)
    .bind(lic.exp)
    .bind(&lic.config_version)
    .bind(&lic.key_set_version)
    .bind(lic.feature_flags.as_ref().map(|v| v.to_string()))
    .bind(lic.offline_grace_deadline)
    .bind(lic.issued_at)
    .bind(lic.last_seen_server_time)
    .bind(enc_key_version)
    .bind(&lic.created_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// The current license row, or `None`. Expiry-based "active" determination
/// (exp vs wall clock, grace windows) is Phase 7. The `token` is decrypted
/// before returning.
pub async fn get_active_license(
    pool: &SqlitePool,
    enc: &Encryption,
) -> Result<Option<License>, DbError> {
    let row: Option<(
        String,
        String,
        String,
        String,
        String,
        i64,
        String,
        Option<String>,
        Option<String>,
        Option<i64>,
        Option<i64>,
        Option<i64>,
        String,
    )> = sqlx::query_as(
        "SELECT id, tenant_id, seat_id, tier, token, exp, config_version, key_set_version, \
                feature_flags, offline_grace_deadline, issued_at, last_seen_server_time, \
                created_at \
         FROM licenses ORDER BY exp DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    match row {
        Some((
            id,
            tenant_id,
            seat_id,
            tier,
            token,
            exp,
            config_version,
            key_set_version,
            feature_flags,
            offline_grace_deadline,
            issued_at,
            last_seen_server_time,
            created_at,
        )) => {
            let token = enc.decrypt(&token)?;
            Ok(Some(License {
                id,
                tenant_id,
                seat_id,
                tier,
                token,
                exp,
                config_version,
                key_set_version,
                feature_flags: feature_flags.and_then(|s| serde_json::from_str(&s).ok()),
                offline_grace_deadline,
                issued_at,
                last_seen_server_time,
                created_at,
            }))
        }
        None => Ok(None),
    }
}

// --- key sets ----------------------------------------------------------------

pub async fn upsert_key_set(pool: &SqlitePool, ks: &LicenseKeySet) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO license_key_sets (version, public_keys, fetched_at, is_active) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT(version) DO UPDATE SET \
           public_keys=excluded.public_keys, fetched_at=excluded.fetched_at",
    )
    .bind(&ks.version)
    .bind(ks.public_keys.to_string())
    .bind(&ks.fetched_at)
    .bind(ks.is_active as i64)
    .execute(pool)
    .await?;
    Ok(())
}

/// Activate one key-set version and deactivate all others, in one transaction.
pub async fn set_active_key_set(pool: &SqlitePool, version: &str) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;
    sqlx::query("UPDATE license_key_sets SET is_active = 0")
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE license_key_sets SET is_active = 1 WHERE version = ?")
        .bind(version)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

pub async fn get_active_key_set(pool: &SqlitePool) -> Result<Option<LicenseKeySet>, DbError> {
    let row: Option<(String, String, String, i64)> = sqlx::query_as(
        "SELECT version, public_keys, fetched_at, is_active \
         FROM license_key_sets WHERE is_active = 1 LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(
        |(version, public_keys, fetched_at, is_active)| LicenseKeySet {
            version,
            public_keys: serde_json::from_str(&public_keys).unwrap_or(serde_json::Value::Null),
            fetched_at,
            is_active: is_active != 0,
        },
    ))
}

// --- clock-rollback guard (spec §11 primitive) -------------------------------

/// `true` if any stored license records a `last_seen_server_time` strictly
/// greater than `last_seen` — i.e. the server clock has moved backwards since
/// the last refresh. The verification response loop lands in Phase 7.
pub async fn refuse_clock_rollback(pool: &SqlitePool, last_seen: i64) -> Result<bool, DbError> {
    let row: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM licenses \
         WHERE last_seen_server_time IS NOT NULL AND last_seen_server_time > ?",
    )
    .bind(last_seen)
    .fetch_one(pool)
    .await?;
    Ok(row.0 > 0)
}

/// Read the monotonic `last_seen_server_time` anchor, for the refresh loop.
pub async fn last_seen_server_time(pool: &SqlitePool) -> Result<Option<i64>, DbError> {
    let row: Option<(Option<i64>,)> =
        sqlx::query_as("SELECT MAX(last_seen_server_time) FROM licenses")
            .fetch_optional(pool)
            .await?;
    Ok(row.and_then(|(v,)| v))
}
