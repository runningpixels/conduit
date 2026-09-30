//! `window.conduit.storage` (ADR-012, bridge v2): a small key/value store kept
//! in the database per principal (`artifact:<id>` or `app:<id>`, see
//! [`Principal`] in `artifact_network`). One command up the stack per
//! operation; every limit is enforced here, atomically, before anything is
//! written.
//!
//! Limits: a key is 1–256 characters with no control characters (never
//! silently trimmed — a key that would only pass after trimming is refused);
//! a value's JSON is at most [`MAX_VALUE_BYTES`]; a principal's rows are at
//! most [`MAX_TOTAL_BYTES`] and [`MAX_KEYS`] in total (replacing a key counts
//! its new size minus its old one); and at most [`MAX_WRITES_PER_MINUTE`]
//! writes (`set`/`delete`/`clear`) per minute per principal, tracked in
//! memory like `artifact_network::reserve_slot`. A write that would cross a
//! limit fails whole: the size/count check and the write happen inside one
//! transaction, so a refused write leaves the stored rows exactly as they
//! were.
//!
//! Values are encrypted at rest like other content columns (`enc.encrypt` /
//! `enc.decrypt`); `size_bytes` is the plaintext JSON's byte length, stored
//! alongside the ciphertext so quota checks never need to decrypt.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use provider_core::schema::PageStorageUsage;
use sqlx::SqlitePool;

use super::artifact_network::Principal;
use crate::{db::DbError, encryption::Encryption, time::now_iso8601};

/// A key must be at least 1 and at most this many characters.
pub const MAX_KEY_CHARS: usize = 256;
/// A single value's compact JSON, in bytes.
pub const MAX_VALUE_BYTES: u64 = 1024 * 1024;
/// A principal's rows, total JSON bytes.
pub const MAX_TOTAL_BYTES: u64 = 5 * 1024 * 1024;
/// A principal's rows, total count.
pub const MAX_KEYS: u64 = 10_000;
/// `set` / `delete` / `clear` calls, per principal, per rolling minute.
pub const MAX_WRITES_PER_MINUTE: usize = 600;

/// Why a storage operation was refused. `Display` renders the bridge error
/// code and a colon, exactly as the IPC contract specifies, so a command can
/// turn this straight into its `Err(String)`.
#[derive(Debug)]
pub enum PageStorageError {
    Invalid(String),
    Quota(String),
    RateLimited(String),
    /// Something below the storage contract itself failed (the database, or
    /// decrypting a row already known to exist).
    Unavailable(DbError),
}

impl std::fmt::Display for PageStorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(msg) => write!(f, "invalid: {msg}"),
            Self::Quota(msg) => write!(f, "quota: {msg}"),
            Self::RateLimited(msg) => write!(f, "rate_limited: {msg}"),
            // The page sees this text: keep database details out of it.
            Self::Unavailable(_) => write!(f, "unavailable: Storage isn't available right now."),
        }
    }
}

impl std::error::Error for PageStorageError {}

impl From<DbError> for PageStorageError {
    fn from(err: DbError) -> Self {
        Self::Unavailable(err)
    }
}

impl From<sqlx::Error> for PageStorageError {
    fn from(err: sqlx::Error) -> Self {
        Self::Unavailable(DbError::from(err))
    }
}

/// Folds a storage error back into `DbError` for callers (`apps.rs`) that
/// only need "did this work", not the bridge error code.
impl From<PageStorageError> for DbError {
    fn from(err: PageStorageError) -> Self {
        match err {
            PageStorageError::Unavailable(inner) => inner,
            other => DbError::Query(other.to_string()),
        }
    }
}

/// A key is refused, not trimmed, when it's empty, over the length limit, or
/// contains a control character.
fn validate_key(key: &str) -> Result<(), PageStorageError> {
    if key.is_empty() {
        return Err(PageStorageError::Invalid(
            "A storage key can't be empty.".to_string(),
        ));
    }
    if key.chars().count() > MAX_KEY_CHARS {
        return Err(PageStorageError::Invalid(format!(
            "A storage key can be at most {MAX_KEY_CHARS} characters."
        )));
    }
    if key.chars().any(|c| c.is_control()) {
        return Err(PageStorageError::Invalid(
            "A storage key can't contain control characters.".to_string(),
        ));
    }
    Ok(())
}

// ── Write rate limit: 600/min per principal, in memory ──────────────────────

#[derive(Default)]
struct RateState {
    recent: HashMap<String, Vec<Instant>>,
}

fn rate_state() -> &'static Mutex<RateState> {
    static STATE: OnceLock<Mutex<RateState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(RateState::default()))
}

/// Count one write attempt against `key` (a principal key), refusing it once
/// [`MAX_WRITES_PER_MINUTE`] have landed in the last rolling minute.
fn check_write_rate(key: &str) -> Result<(), PageStorageError> {
    let mut state = rate_state().lock().map_err(|_| {
        PageStorageError::Unavailable(DbError::Query("storage rate state unavailable".to_string()))
    })?;
    let now = Instant::now();
    let recent = state.recent.entry(key.to_string()).or_default();
    recent.retain(|t| now.duration_since(*t) < Duration::from_secs(60));
    if recent.len() >= MAX_WRITES_PER_MINUTE {
        return Err(PageStorageError::RateLimited(format!(
            "This page made more than {MAX_WRITES_PER_MINUTE} storage writes in a minute; wait and try again."
        )));
    }
    recent.push(now);
    Ok(())
}

// ── Reads ────────────────────────────────────────────────────────────────────

/// The value stored at `key`, or `None` when absent.
pub async fn get(
    pool: &SqlitePool,
    enc: &Encryption,
    principal: &Principal,
    key: &str,
) -> Result<Option<serde_json::Value>, PageStorageError> {
    validate_key(key)?;
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value_json FROM page_storage WHERE principal = ? AND key = ?")
            .bind(principal.key())
            .bind(key)
            .fetch_optional(pool)
            .await
            .map_err(DbError::from)?;
    let Some((stored,)) = row else {
        return Ok(None);
    };
    let json = enc.decrypt(&stored)?;
    let value = serde_json::from_str(&json).map_err(|e| {
        PageStorageError::Unavailable(DbError::Query(format!("decode stored value: {e}")))
    })?;
    Ok(Some(value))
}

/// Every key for `principal`, sorted, optionally filtered to those starting
/// with `prefix`.
pub async fn keys(
    pool: &SqlitePool,
    principal: &Principal,
    prefix: Option<&str>,
) -> Result<Vec<String>, PageStorageError> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT key FROM page_storage WHERE principal = ? ORDER BY key")
            .bind(principal.key())
            .fetch_all(pool)
            .await
            .map_err(DbError::from)?;
    let mut keys: Vec<String> = rows.into_iter().map(|(k,)| k).collect();
    if let Some(prefix) = prefix {
        keys.retain(|k| k.starts_with(prefix));
    }
    Ok(keys)
}

/// Total bytes and key count for `principal`.
pub async fn usage(
    pool: &SqlitePool,
    principal: &Principal,
) -> Result<PageStorageUsage, PageStorageError> {
    let (bytes, keys): (i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(size_bytes), 0), COUNT(*) FROM page_storage WHERE principal = ?",
    )
    .bind(principal.key())
    .fetch_one(pool)
    .await
    .map_err(DbError::from)?;
    Ok(PageStorageUsage {
        bytes: bytes as u64,
        keys: keys as u64,
    })
}

// ── Writes ───────────────────────────────────────────────────────────────────

/// Store `value` at `key`, replacing anything already there. Refused whole —
/// nothing written — when the key is invalid, the value's JSON is over
/// [`MAX_VALUE_BYTES`], the write would put the principal over
/// [`MAX_TOTAL_BYTES`] or [`MAX_KEYS`], or the principal is over the write
/// rate limit.
pub async fn set(
    pool: &SqlitePool,
    enc: &Encryption,
    principal: &Principal,
    key: &str,
    value: &serde_json::Value,
) -> Result<(), PageStorageError> {
    validate_key(key)?;
    let json = serde_json::to_string(value)
        .map_err(|e| PageStorageError::Invalid(format!("That value can't be stored: {e}")))?;
    let size = json.len() as u64;
    if size > MAX_VALUE_BYTES {
        return Err(PageStorageError::Quota(format!(
            "A stored value can be at most {} bytes.",
            MAX_VALUE_BYTES
        )));
    }
    check_write_rate(&principal.key())?;
    let encrypted = enc.encrypt(&json)?;

    let mut tx = pool.begin().await.map_err(DbError::from)?;
    let existing: Option<(i64,)> =
        sqlx::query_as("SELECT size_bytes FROM page_storage WHERE principal = ? AND key = ?")
            .bind(principal.key())
            .bind(key)
            .fetch_optional(&mut *tx)
            .await
            .map_err(DbError::from)?;
    let old_size = existing.map(|(s,)| s as u64).unwrap_or(0);
    let is_new_key = existing.is_none();
    let (total_bytes, total_keys): (i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(size_bytes), 0), COUNT(*) FROM page_storage WHERE principal = ?",
    )
    .bind(principal.key())
    .fetch_one(&mut *tx)
    .await
    .map_err(DbError::from)?;
    let new_total = (total_bytes as u64) - old_size + size;
    if new_total > MAX_TOTAL_BYTES {
        tx.rollback().await.ok();
        return Err(PageStorageError::Quota(format!(
            "This page's storage is limited to {} MB.",
            MAX_TOTAL_BYTES / (1024 * 1024)
        )));
    }
    if is_new_key && (total_keys as u64) + 1 > MAX_KEYS {
        tx.rollback().await.ok();
        return Err(PageStorageError::Quota(format!(
            "This page's storage is limited to {MAX_KEYS} keys."
        )));
    }

    sqlx::query(
        "INSERT INTO page_storage (principal, key, value_json, size_bytes, updated_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(principal, key) DO UPDATE SET \
           value_json = excluded.value_json, \
           size_bytes = excluded.size_bytes, \
           updated_at = excluded.updated_at",
    )
    .bind(principal.key())
    .bind(key)
    .bind(&encrypted)
    .bind(size as i64)
    .bind(now_iso8601())
    .execute(&mut *tx)
    .await
    .map_err(DbError::from)?;
    tx.commit().await.map_err(DbError::from)?;
    Ok(())
}

/// Delete `key`, if present. Not an error when it wasn't there.
pub async fn delete(
    pool: &SqlitePool,
    principal: &Principal,
    key: &str,
) -> Result<(), PageStorageError> {
    validate_key(key)?;
    check_write_rate(&principal.key())?;
    sqlx::query("DELETE FROM page_storage WHERE principal = ? AND key = ?")
        .bind(principal.key())
        .bind(key)
        .execute(pool)
        .await
        .map_err(DbError::from)?;
    Ok(())
}

/// Delete every row for `principal`.
pub async fn clear(pool: &SqlitePool, principal: &Principal) -> Result<(), PageStorageError> {
    check_write_rate(&principal.key())?;
    sqlx::query("DELETE FROM page_storage WHERE principal = ?")
        .bind(principal.key())
        .execute(pool)
        .await
        .map_err(DbError::from)?;
    Ok(())
}

/// Copy every row of `from` to `to`, replacing anything already at `to` under
/// the same key. Not rate-limited: this is an internal move (save-as-app),
/// never a page's own write.
pub async fn copy(
    pool: &SqlitePool,
    from: &Principal,
    to: &Principal,
) -> Result<(), PageStorageError> {
    sqlx::query(
        "INSERT INTO page_storage (principal, key, value_json, size_bytes, updated_at) \
         SELECT ?, key, value_json, size_bytes, updated_at FROM page_storage WHERE principal = ? \
         ON CONFLICT(principal, key) DO UPDATE SET \
           value_json = excluded.value_json, \
           size_bytes = excluded.size_bytes, \
           updated_at = excluded.updated_at",
    )
    .bind(to.key())
    .bind(from.key())
    .execute(pool)
    .await
    .map_err(DbError::from)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encryption::generate_key;
    use serde_json::json;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::MIGRATOR.run(&pool).await.unwrap();
        pool
    }

    fn art(id: &str) -> Principal {
        Principal::artifact(id)
    }

    #[test]
    fn key_rules() {
        assert!(validate_key("").is_err(), "empty");
        assert!(validate_key(&"k".repeat(256)).is_ok(), "256 is fine");
        assert!(validate_key(&"k".repeat(257)).is_err(), "257 is too many");
        assert!(validate_key("a\u{0}b").is_err(), "NUL is a control char");
        assert!(validate_key("a\tb").is_err(), "tab is a control char");
        assert!(
            validate_key(" trailing space ").is_ok(),
            "not trimmed, but not control either"
        );
    }

    #[tokio::test]
    async fn round_trip_with_encryption_off() {
        let pool = pool().await;
        let enc = Encryption::off();
        let p = art("a1");
        assert_eq!(get(&pool, &enc, &p, "missing").await.unwrap(), None);
        set(&pool, &enc, &p, "k", &json!({"n": 1})).await.unwrap();
        assert_eq!(
            get(&pool, &enc, &p, "k").await.unwrap(),
            Some(json!({"n": 1}))
        );
        let (raw,): (String,) =
            sqlx::query_as("SELECT value_json FROM page_storage WHERE principal = ? AND key = ?")
                .bind(p.key())
                .bind("k")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(raw, r#"{"n":1}"#, "off tier stores plaintext JSON");
    }

    #[tokio::test]
    async fn round_trip_with_encryption_on() {
        let pool = pool().await;
        let enc = Encryption::on_with_key(generate_key(), 1);
        let p = art("a2");
        set(&pool, &enc, &p, "k", &json!("secret")).await.unwrap();
        assert_eq!(
            get(&pool, &enc, &p, "k").await.unwrap(),
            Some(json!("secret"))
        );
        let (raw,): (String,) =
            sqlx::query_as("SELECT value_json FROM page_storage WHERE principal = ? AND key = ?")
                .bind(p.key())
                .bind("k")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(raw.starts_with("enc:v1:"), "on tier encrypts the value");
    }

    #[tokio::test]
    async fn a_value_over_one_mib_is_refused() {
        let pool = pool().await;
        let enc = Encryption::off();
        let p = art("a3");
        // `serde_json::Value::String` serializes with two quote bytes; pad so
        // the JSON itself, not just the string, crosses the limit.
        let big = "x".repeat(MAX_VALUE_BYTES as usize + 1);
        let err = set(&pool, &enc, &p, "k", &json!(big)).await.unwrap_err();
        assert!(matches!(err, PageStorageError::Quota(_)));
        assert_eq!(usage(&pool, &p).await.unwrap().keys, 0, "nothing written");
    }

    /// Seed a row directly (bypassing `set`'s own per-value cap) so a total
    /// near the 5 MiB principal limit can be set up without five separate
    /// 1 MiB values.
    async fn seed_row(pool: &SqlitePool, principal: &Principal, key: &str, size_bytes: u64) {
        sqlx::query(
            "INSERT INTO page_storage (principal, key, value_json, size_bytes, updated_at) \
             VALUES (?, ?, '\"x\"', ?, ?)",
        )
        .bind(principal.key())
        .bind(key)
        .bind(size_bytes as i64)
        .bind(now_iso8601())
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn five_mib_total_is_enforced_across_keys() {
        let pool = pool().await;
        let enc = Encryption::off();
        let p = art("a4");
        seed_row(&pool, &p, "big", MAX_TOTAL_BYTES - 50).await;
        let before = usage(&pool, &p).await.unwrap();
        let err = set(&pool, &enc, &p, "k4", &json!("x".repeat(100)))
            .await
            .unwrap_err();
        assert!(matches!(err, PageStorageError::Quota(_)));
        let after = usage(&pool, &p).await.unwrap();
        assert_eq!(before, after, "a refused write changes nothing");
    }

    #[tokio::test]
    async fn replacing_a_key_counts_new_minus_old_not_new_plus_old() {
        let pool = pool().await;
        let enc = Encryption::off();
        let p = art("a5");
        set(&pool, &enc, &p, "k", &json!("x".repeat(1000)))
            .await
            .unwrap();
        let first = usage(&pool, &p).await.unwrap();
        assert_eq!(first.keys, 1);
        set(&pool, &enc, &p, "k", &json!("y".repeat(10)))
            .await
            .unwrap();
        let second = usage(&pool, &p).await.unwrap();
        assert_eq!(second.keys, 1, "still one key");
        assert!(
            second.bytes < first.bytes,
            "the smaller replacement shrinks usage"
        );
    }

    #[tokio::test]
    async fn ten_thousand_keys_is_the_cap() {
        let pool = pool().await;
        let p = art("a6");
        {
            let mut tx = pool.begin().await.unwrap();
            for i in 0..MAX_KEYS {
                sqlx::query(
                    "INSERT INTO page_storage (principal, key, value_json, size_bytes, updated_at) \
                     VALUES (?, ?, '1', 1, ?)",
                )
                .bind(p.key())
                .bind(format!("k{i:05}"))
                .bind(now_iso8601())
                .execute(&mut *tx)
                .await
                .unwrap();
            }
            tx.commit().await.unwrap();
        }
        let enc = Encryption::off();
        // Replacing an existing key is still fine at the cap.
        set(&pool, &enc, &p, "k00000", &json!(2)).await.unwrap();
        // A genuinely new key is not.
        let err = set(&pool, &enc, &p, "brand-new", &json!(1))
            .await
            .unwrap_err();
        assert!(matches!(err, PageStorageError::Quota(_)));
        assert_eq!(usage(&pool, &p).await.unwrap().keys, MAX_KEYS);
    }

    #[tokio::test]
    async fn keys_are_sorted_and_filtered_by_prefix() {
        let pool = pool().await;
        let enc = Encryption::off();
        let p = art("a7");
        for k in ["b", "a", "prefix:2", "prefix:1"] {
            set(&pool, &enc, &p, k, &json!(null)).await.unwrap();
        }
        assert_eq!(
            keys(&pool, &p, None).await.unwrap(),
            vec!["a", "b", "prefix:1", "prefix:2"]
        );
        assert_eq!(
            keys(&pool, &p, Some("prefix:")).await.unwrap(),
            vec!["prefix:1", "prefix:2"]
        );
    }

    #[tokio::test]
    async fn clear_removes_everything_for_the_principal_only() {
        let pool = pool().await;
        let enc = Encryption::off();
        let p1 = art("a8");
        let p2 = art("a9");
        set(&pool, &enc, &p1, "k", &json!(1)).await.unwrap();
        set(&pool, &enc, &p2, "k", &json!(1)).await.unwrap();
        clear(&pool, &p1).await.unwrap();
        assert_eq!(usage(&pool, &p1).await.unwrap().keys, 0);
        assert_eq!(
            usage(&pool, &p2).await.unwrap().keys,
            1,
            "the other principal is untouched"
        );
    }

    #[tokio::test]
    async fn copy_carries_rows_to_a_new_principal() {
        let pool = pool().await;
        let enc = Encryption::off();
        let from = art("a10");
        let to = Principal::app("app-a10");
        set(&pool, &enc, &from, "k1", &json!(1)).await.unwrap();
        set(&pool, &enc, &from, "k2", &json!(2)).await.unwrap();
        copy(&pool, &from, &to).await.unwrap();
        assert_eq!(keys(&pool, &to, None).await.unwrap(), vec!["k1", "k2"]);
        assert_eq!(get(&pool, &enc, &to, "k1").await.unwrap(), Some(json!(1)));
        assert_eq!(
            keys(&pool, &from, None).await.unwrap(),
            vec!["k1", "k2"],
            "copy doesn't remove the source"
        );
    }

    #[tokio::test]
    async fn writes_past_the_per_minute_cap_are_rate_limited() {
        let pool = pool().await;
        let enc = Encryption::off();
        let p = art("a11");
        for i in 0..MAX_WRITES_PER_MINUTE {
            set(&pool, &enc, &p, &format!("k{i}"), &json!(1))
                .await
                .unwrap();
        }
        let err = set(&pool, &enc, &p, "one-too-many", &json!(1))
            .await
            .unwrap_err();
        assert!(matches!(err, PageStorageError::RateLimited(_)));
    }

    #[test]
    fn error_display_matches_the_bridge_error_code_prefixes() {
        assert_eq!(
            PageStorageError::Invalid("x".into()).to_string(),
            "invalid: x"
        );
        assert_eq!(PageStorageError::Quota("x".into()).to_string(), "quota: x");
        assert_eq!(
            PageStorageError::RateLimited("x".into()).to_string(),
            "rate_limited: x"
        );
    }
}
