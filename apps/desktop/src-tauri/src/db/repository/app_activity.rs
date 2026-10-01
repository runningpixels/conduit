//! What a saved app did, for its Settings page: model calls, site requests
//! and storage writes (see migration 0029). Metadata only — providers, models,
//! token counts, origins, status codes and bridge error codes. Never prompts,
//! replies, URL paths or stored values.
//!
//! Days are the user's **local** calendar days (`YYYY-MM-DD`), because "today's
//! allowance" and "resets at midnight" are about the user's clock. Timestamps
//! (`at`) are UTC RFC 3339 like every other `*_at` column, so they sort.
//!
//! Model and fetch calls are one row each, at most [`MAX_ROWS_PER_DAY`] per app
//! per day (further ones are dropped). Storage writes roll up to one row per
//! app per day, which is always counted. Rows older than the
//! [`RETENTION_DAYS`]-day window (today and the six days before it) are deleted
//! whenever a row is inserted.
//!
//! Every recorder here is a no-op for a non-app principal, and failures are
//! logged and swallowed: activity logging must never fail the call it
//! describes.

use chrono::{DateTime, Days, Local, NaiveDate};
use provider_core::schema::{AppActivityEntry, AppActivityKind, AppUsageDay};
use sqlx::SqlitePool;

use super::artifact_network::Principal;
use crate::{db::DbError, time::now_iso8601};

/// Model + fetch rows kept per app per local day.
pub const MAX_ROWS_PER_DAY: i64 = 1_000;
/// How many local days (including today) activity and usage cover.
pub const RETENTION_DAYS: u64 = 7;
pub const DEFAULT_LIST_LIMIT: u32 = 200;
pub const MAX_LIST_LIMIT: u32 = 1_000;

/// One model call, as logged.
#[derive(Debug, Clone, Default)]
pub struct ModelCall<'a> {
    pub provider_id: Option<&'a str>,
    pub model: Option<&'a str>,
    /// Whether the provider was a cloud one (counts against the daily cap).
    pub cloud: bool,
    pub ok: bool,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    /// A bridge error code (`quota`, `not_granted`, `unavailable`, …).
    pub error: Option<&'a str>,
}

/// One site request, as logged.
#[derive(Debug, Clone)]
pub struct FetchCall<'a> {
    pub host: &'a str,
    pub method: &'a str,
    pub status: Option<u16>,
    pub error: Option<&'a str>,
    pub ok: bool,
}

pub fn day_string(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// The local day `now` falls on.
pub fn local_day(now: DateTime<Local>) -> String {
    day_string(now.date_naive())
}

/// The oldest local day still inside the retention window.
fn oldest_kept_day(now: DateTime<Local>) -> String {
    let date = now
        .date_naive()
        .checked_sub_days(Days::new(RETENTION_DAYS - 1))
        .unwrap_or_else(|| now.date_naive());
    day_string(date)
}

fn app_id(principal: &Principal) -> Option<&str> {
    match principal {
        Principal::App(id) => Some(id),
        Principal::Artifact(_) => None,
    }
}

async fn prune(pool: &SqlitePool, app: &str, now: DateTime<Local>) -> Result<(), DbError> {
    sqlx::query("DELETE FROM app_activity WHERE app_id = ? AND day < ?")
        .bind(app)
        .bind(oldest_kept_day(now))
        .execute(pool)
        .await?;
    Ok(())
}

// ── Writes ───────────────────────────────────────────────────────────────────

pub async fn insert_model_at(
    pool: &SqlitePool,
    app: &str,
    now: DateTime<Local>,
    call: &ModelCall<'_>,
) -> Result<(), DbError> {
    prune(pool, app, now).await?;
    let day = local_day(now);
    if !has_room(pool, app, &day).await? {
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO app_activity \
         (app_id, at, day, kind, ok, provider_id, model, cloud, input_tokens, output_tokens, error) \
         VALUES (?, ?, ?, 'model', ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(app)
    .bind(now_iso8601())
    .bind(day)
    .bind(call.ok)
    .bind(call.provider_id)
    .bind(call.model)
    .bind(call.cloud)
    .bind(call.input_tokens.map(|n| n as i64))
    .bind(call.output_tokens.map(|n| n as i64))
    .bind(call.error)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn insert_fetch_at(
    pool: &SqlitePool,
    app: &str,
    now: DateTime<Local>,
    call: &FetchCall<'_>,
) -> Result<(), DbError> {
    prune(pool, app, now).await?;
    let day = local_day(now);
    if !has_room(pool, app, &day).await? {
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO app_activity (app_id, at, day, kind, ok, host, method, status, error) \
         VALUES (?, ?, ?, 'fetch', ?, ?, ?, ?, ?)",
    )
    .bind(app)
    .bind(now_iso8601())
    .bind(day)
    .bind(call.ok)
    .bind(call.host)
    .bind(call.method)
    .bind(call.status.map(i64::from))
    .bind(call.error)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn bump_storage_at(
    pool: &SqlitePool,
    app: &str,
    now: DateTime<Local>,
) -> Result<(), DbError> {
    prune(pool, app, now).await?;
    sqlx::query(
        "INSERT INTO app_activity (app_id, at, day, kind, ok, count) \
         VALUES (?, ?, ?, 'storage', 1, 1) \
         ON CONFLICT(app_id, day) WHERE kind = 'storage' DO UPDATE SET \
           count = count + 1, at = excluded.at",
    )
    .bind(app)
    .bind(now_iso8601())
    .bind(local_day(now))
    .execute(pool)
    .await?;
    Ok(())
}

async fn has_room(pool: &SqlitePool, app: &str, day: &str) -> Result<bool, DbError> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM app_activity \
         WHERE app_id = ? AND day = ? AND kind IN ('model', 'fetch')",
    )
    .bind(app)
    .bind(day)
    .fetch_one(pool)
    .await?;
    Ok(n < MAX_ROWS_PER_DAY)
}

fn swallow(what: &str, result: Result<(), DbError>) {
    if let Err(err) = result {
        tracing::warn!(error = %err, "app_activity: could not record {what}");
    }
}

/// Log a model call for an app principal; a no-op for any other principal.
pub async fn record_model(pool: &SqlitePool, principal: &Principal, call: &ModelCall<'_>) {
    if let Some(app) = app_id(principal) {
        swallow(
            "model call",
            insert_model_at(pool, app, Local::now(), call).await,
        );
    }
}

/// Log a site request for an app principal; a no-op for any other principal.
pub async fn record_fetch(pool: &SqlitePool, principal: &Principal, call: &FetchCall<'_>) {
    if let Some(app) = app_id(principal) {
        swallow(
            "site request",
            insert_fetch_at(pool, app, Local::now(), call).await,
        );
    }
}

/// Count one storage write for an app principal; a no-op for any other.
pub async fn record_storage_write(pool: &SqlitePool, principal: &Principal) {
    if let Some(app) = app_id(principal) {
        swallow(
            "storage write",
            bump_storage_at(pool, app, Local::now()).await,
        );
    }
}

// ── Reads ────────────────────────────────────────────────────────────────────

type ActivityRow = (
    String,
    String,
    i64,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<i64>,
    Option<String>,
    i64,
);

/// The app's activity inside the retention window, newest first.
pub async fn list_at(
    pool: &SqlitePool,
    app: &str,
    now: DateTime<Local>,
    limit: Option<u32>,
) -> Result<Vec<AppActivityEntry>, DbError> {
    let limit = limit.unwrap_or(DEFAULT_LIST_LIMIT).clamp(1, MAX_LIST_LIMIT);
    let rows: Vec<ActivityRow> = sqlx::query_as(
        "SELECT at, kind, ok, provider_id, model, input_tokens, output_tokens, \
                host, method, status, error, count \
         FROM app_activity WHERE app_id = ? AND day >= ? \
         ORDER BY at DESC, id DESC LIMIT ?",
    )
    .bind(app)
    .bind(oldest_kept_day(now))
    .bind(i64::from(limit))
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(
                at,
                kind,
                ok,
                provider_id,
                model,
                input_tokens,
                output_tokens,
                host,
                method,
                status,
                error,
                count,
            )| AppActivityEntry {
                at,
                kind: match kind.as_str() {
                    "model" => AppActivityKind::Model,
                    "fetch" => AppActivityKind::Fetch,
                    _ => AppActivityKind::Storage,
                },
                ok: ok != 0,
                provider_id,
                model,
                input_tokens: input_tokens.map(|n| n.max(0) as u64),
                output_tokens: output_tokens.map(|n| n.max(0) as u64),
                host,
                method,
                status: status.and_then(|s| u16::try_from(s).ok()),
                error,
                count: count.max(0) as u32,
            },
        )
        .collect())
}

pub async fn list(
    pool: &SqlitePool,
    app: &str,
    limit: Option<u32>,
) -> Result<Vec<AppActivityEntry>, DbError> {
    list_at(pool, app, Local::now(), limit).await
}

/// Per-day model usage for the last [`RETENTION_DAYS`] local days, oldest
/// first, with days without use as zeros. `calls` counts successful calls.
pub async fn usage_at(
    pool: &SqlitePool,
    app: &str,
    now: DateTime<Local>,
) -> Result<Vec<AppUsageDay>, DbError> {
    let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT day, COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0), \
                SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) \
         FROM app_activity WHERE app_id = ? AND kind = 'model' AND day >= ? GROUP BY day",
    )
    .bind(app)
    .bind(oldest_kept_day(now))
    .fetch_all(pool)
    .await?;
    let today = now.date_naive();
    Ok((0..RETENTION_DAYS)
        .rev()
        .map(|back| {
            let day = day_string(today.checked_sub_days(Days::new(back)).unwrap_or(today));
            match rows.iter().find(|(d, ..)| *d == day) {
                Some((_, input, output, calls)) => AppUsageDay {
                    day,
                    input_tokens: (*input).max(0) as u64,
                    output_tokens: (*output).max(0) as u64,
                    calls: (*calls).max(0) as u32,
                },
                None => AppUsageDay {
                    day,
                    input_tokens: 0,
                    output_tokens: 0,
                    calls: 0,
                },
            }
        })
        .collect())
}

/// Cloud-model input + output tokens the app used on the local day of `now`.
pub async fn cloud_tokens_today_at(
    pool: &SqlitePool,
    app: &str,
    now: DateTime<Local>,
) -> Result<u64, DbError> {
    let (total,): (i64,) = sqlx::query_as(
        "SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) \
         FROM app_activity WHERE app_id = ? AND kind = 'model' AND cloud = 1 AND day = ?",
    )
    .bind(app)
    .bind(local_day(now))
    .fetch_one(pool)
    .await?;
    Ok(total.max(0) as u64)
}

pub async fn cloud_tokens_today(pool: &SqlitePool, app: &str) -> Result<u64, DbError> {
    cloud_tokens_today_at(pool, app, Local::now()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool_with_app(id: &str) -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::MIGRATOR.run(&pool).await.unwrap();
        add_app(&pool, id).await;
        pool
    }

    async fn add_app(pool: &SqlitePool, id: &str) {
        sqlx::query(
            "INSERT INTO apps (id, name, category, version, origin, manifest_json, payload, \
             content_hash, created_at, updated_at) \
             VALUES (?, 'T', 'tools', '1.0.0', 'saved', '{}', '', 'h', 'x', 'x')",
        )
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    }

    fn days_ago(n: u64) -> DateTime<Local> {
        let now = Local::now();
        now.checked_sub_days(Days::new(n)).unwrap()
    }

    fn model(cloud: bool, input: u64, output: u64) -> ModelCall<'static> {
        ModelCall {
            provider_id: Some("anthropic"),
            model: Some("m"),
            cloud,
            ok: true,
            input_tokens: Some(input),
            output_tokens: Some(output),
            error: None,
        }
    }

    #[tokio::test]
    async fn model_and_fetch_rows_list_newest_first() {
        let pool = pool_with_app("a1").await;
        insert_model_at(&pool, "a1", Local::now(), &model(true, 5, 7))
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        insert_fetch_at(
            &pool,
            "a1",
            Local::now(),
            &FetchCall {
                host: "https://api.example.com",
                method: "GET",
                status: Some(200),
                error: None,
                ok: true,
            },
        )
        .await
        .unwrap();
        let rows = list(&pool, "a1", None).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].kind, AppActivityKind::Fetch);
        assert_eq!(rows[0].host.as_deref(), Some("https://api.example.com"));
        assert_eq!(rows[0].status, Some(200));
        assert_eq!(rows[1].kind, AppActivityKind::Model);
        assert_eq!(rows[1].input_tokens, Some(5));
        assert_eq!(list(&pool, "a1", Some(1)).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn storage_writes_roll_up_to_one_row_per_day() {
        let pool = pool_with_app("a2").await;
        for _ in 0..3 {
            bump_storage_at(&pool, "a2", Local::now()).await.unwrap();
        }
        bump_storage_at(&pool, "a2", days_ago(1)).await.unwrap();
        let rows = list(&pool, "a2", None).await.unwrap();
        let storage: Vec<_> = rows
            .iter()
            .filter(|r| r.kind == AppActivityKind::Storage)
            .collect();
        assert_eq!(storage.len(), 2, "one row per local day");
        let mut counts: Vec<u32> = storage.iter().map(|r| r.count).collect();
        counts.sort_unstable();
        assert_eq!(counts, [1, 3], "today counted three writes, yesterday one");
    }

    #[tokio::test]
    async fn model_and_fetch_rows_are_capped_per_day_but_storage_still_counts() {
        let pool = pool_with_app("a3").await;
        let day = local_day(Local::now());
        // Seed the cap directly instead of 1,000 round trips.
        sqlx::query(
            "INSERT INTO app_activity (app_id, at, day, kind, ok) \
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) \
             SELECT 'a3', '2026-01-01T00:00:00.000Z', ?, 'model', 1 FROM n",
        )
        .bind(&day)
        .execute(&pool)
        .await
        .unwrap();
        insert_model_at(&pool, "a3", Local::now(), &model(true, 1, 1))
            .await
            .unwrap();
        insert_fetch_at(
            &pool,
            "a3",
            Local::now(),
            &FetchCall {
                host: "h",
                method: "GET",
                status: Some(200),
                error: None,
                ok: true,
            },
        )
        .await
        .unwrap();
        bump_storage_at(&pool, "a3", Local::now()).await.unwrap();
        let (rows,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM app_activity WHERE app_id = 'a3' AND kind IN ('model','fetch')",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(rows, 1_000, "the 1,001st row is dropped");
        let (storage,): (i64,) = sqlx::query_as(
            "SELECT COUNT(*) FROM app_activity WHERE app_id = 'a3' AND kind = 'storage'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(storage, 1);
    }

    #[tokio::test]
    async fn rows_older_than_seven_days_are_deleted_on_insert() {
        let pool = pool_with_app("a4").await;
        insert_model_at(&pool, "a4", days_ago(7), &model(true, 1, 1))
            .await
            .unwrap();
        insert_model_at(&pool, "a4", days_ago(6), &model(true, 1, 1))
            .await
            .unwrap();
        // A row for another app is never touched.
        add_app(&pool, "other").await;
        insert_model_at(&pool, "other", days_ago(7), &model(true, 1, 1))
            .await
            .unwrap();
        insert_model_at(&pool, "a4", Local::now(), &model(true, 1, 1))
            .await
            .unwrap();
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM app_activity WHERE app_id = 'a4'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 2, "the 7-days-ago row went; 6 days ago and today stay");
        let (other,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM app_activity WHERE app_id = 'other'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(other, 1);
    }

    #[tokio::test]
    async fn usage_is_seven_days_oldest_first_and_zero_filled() {
        let pool = pool_with_app("a5").await;
        insert_model_at(&pool, "a5", Local::now(), &model(true, 10, 20))
            .await
            .unwrap();
        insert_model_at(&pool, "a5", Local::now(), &model(false, 1, 2))
            .await
            .unwrap();
        insert_model_at(&pool, "a5", days_ago(2), &model(true, 4, 6))
            .await
            .unwrap();
        let usage = usage_at(&pool, "a5", Local::now()).await.unwrap();
        assert_eq!(usage.len(), 7);
        assert_eq!(usage[6].day, local_day(Local::now()));
        assert_eq!(usage[0].day, local_day(days_ago(6)));
        assert_eq!(
            (
                usage[6].input_tokens,
                usage[6].output_tokens,
                usage[6].calls
            ),
            (11, 22, 2)
        );
        assert_eq!((usage[4].input_tokens, usage[4].calls), (4, 1));
        assert_eq!(usage[5].calls, 0, "yesterday is zero-filled");
        assert_eq!(
            cloud_tokens_today_at(&pool, "a5", Local::now())
                .await
                .unwrap(),
            30,
            "only cloud rows count against the cap"
        );
    }

    #[tokio::test]
    async fn recorders_ignore_artifact_principals() {
        let pool = pool_with_app("a6").await;
        record_model(&pool, &Principal::artifact("a6"), &model(true, 1, 1)).await;
        record_storage_write(&pool, &Principal::artifact("a6")).await;
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM app_activity")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0);
        record_storage_write(&pool, &Principal::app("a6")).await;
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM app_activity")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 1);
    }

    #[tokio::test]
    async fn deleting_the_app_cascades_activity() {
        let pool = pool_with_app("a7").await;
        insert_model_at(&pool, "a7", Local::now(), &model(true, 1, 1))
            .await
            .unwrap();
        crate::db::repository::apps::delete(&pool, "a7")
            .await
            .unwrap();
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM app_activity")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }
}
