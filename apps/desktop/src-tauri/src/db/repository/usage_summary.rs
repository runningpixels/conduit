//! `usage_summary` repository — per-message usage rows for fast period aggregation.
//! Each assistant message generates one row in this table, inserted asynchronously
//! after the stream completes. The data is used for the Usage Analytics settings tab.

use chrono::Datelike;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::time::now_iso8601;

/// Per-provider/model breakdown of usage for a given period.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageBreakdown {
    pub provider_id: String,
    pub model_id: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_cents: f64,
}

/// Daily usage totals for chart display.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsage {
    pub date: String,
    pub cost_cents: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

/// Response from `get_usage_summary`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryResponse {
    pub total_cost_cents: f64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub by_provider: Vec<ProviderUsageBreakdown>,
    pub daily_totals: Vec<DailyUsage>,
}

/// One usage row's worth of facts.
///
/// A struct rather than ten positional parameters: four of them are `i64`
/// token counts in a row, so a transposed pair would compile, persist and
/// silently misreport cost forever. Named fields make that mistake visible at
/// the call site.
pub struct UsageSummaryRow<'a> {
    pub message_id: &'a str,
    pub conversation_id: &'a str,
    pub provider_id: &'a str,
    pub model_id: &'a str,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub cost_estimate: Option<&'a str>,
}

/// Insert one usage summary row for a completed assistant message.
pub async fn insert_usage_summary(
    pool: &SqlitePool,
    row: UsageSummaryRow<'_>,
) -> Result<(), sqlx::Error> {
    let UsageSummaryRow {
        message_id,
        conversation_id,
        provider_id,
        model_id,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        cost_estimate,
    } = row;
    let id = Uuid::new_v4().to_string();
    let now = now_iso8601();
    sqlx::query(
        "INSERT INTO usage_summary \
         (id, message_id, conversation_id, provider_id, model_id, \
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, \
          cost_estimate, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(message_id)
    .bind(conversation_id)
    .bind(provider_id)
    .bind(model_id)
    .bind(input_tokens)
    .bind(output_tokens)
    .bind(cache_read_tokens)
    .bind(cache_write_tokens)
    .bind(cost_estimate)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(())
}

/// Convert a period string to an ISO-8601 start boundary.
fn period_start(period: &str) -> String {
    let now = chrono::Utc::now();
    match period {
        "today" => now.format("%Y-%m-%dT00:00:00.000Z").to_string(),
        "thisWeek" => {
            let dow = now.weekday().num_days_from_monday();
            (now - chrono::Duration::days(dow as i64))
                .format("%Y-%m-%dT00:00:00.000Z")
                .to_string()
        }
        "thisMonth" => now.format("%Y-%m-01T00:00:00.000Z").to_string(),
        _ => "0000-01-01T00:00:00.000Z".to_string(),
    }
}

/// Get aggregated usage summary for a given period.
/// `period` is one of: "today", "thisWeek", "thisMonth", "all".
pub async fn get_usage_summary(
    pool: &SqlitePool,
    period: &str,
) -> Result<UsageSummaryResponse, sqlx::Error> {
    let since = period_start(period);

    // Totals
    let total_row: Option<(i64, i64, f64)> = sqlx::query_as(
        "SELECT \
           COALESCE(SUM(input_tokens), 0), \
           COALESCE(SUM(output_tokens), 0), \
           COALESCE(SUM(CAST(cost_estimate AS REAL)), 0.0) \
         FROM usage_summary WHERE created_at >= ?",
    )
    .bind(&since)
    .fetch_optional(pool)
    .await?
    .map(|(a, b, c): (i64, i64, f64)| (a, b, c));

    let (total_input_tokens, total_output_tokens, total_cost_cents) =
        total_row.unwrap_or((0, 0, 0.0));

    // Per provider + model breakdown
    let by_provider_rows: Vec<(String, String, i64, i64, f64)> = sqlx::query_as(
        "SELECT provider_id, model_id, \
                COALESCE(SUM(input_tokens), 0), \
                COALESCE(SUM(output_tokens), 0), \
                COALESCE(SUM(CAST(cost_estimate AS REAL)), 0.0) \
         FROM usage_summary WHERE created_at >= ? \
         GROUP BY provider_id, model_id ORDER BY 5 DESC",
    )
    .bind(&since)
    .fetch_all(pool)
    .await?;

    let by_provider = by_provider_rows
        .into_iter()
        .map(
            |(provider_id, model_id, input_tokens, output_tokens, cost_cents)| {
                ProviderUsageBreakdown {
                    provider_id,
                    model_id,
                    input_tokens,
                    output_tokens,
                    cost_cents,
                }
            },
        )
        .collect();

    // Daily totals
    let daily_rows: Vec<(String, i64, i64, f64)> = sqlx::query_as(
        "SELECT SUBSTR(created_at, 1, 10) AS date, \
                COALESCE(SUM(input_tokens), 0), \
                COALESCE(SUM(output_tokens), 0), \
                COALESCE(SUM(CAST(cost_estimate AS REAL)), 0.0) \
         FROM usage_summary WHERE created_at >= ? \
         GROUP BY date ORDER BY date",
    )
    .bind(&since)
    .fetch_all(pool)
    .await?;

    let daily_totals = daily_rows
        .into_iter()
        .map(
            |(date, input_tokens, output_tokens, cost_cents)| DailyUsage {
                date,
                input_tokens,
                output_tokens,
                cost_cents,
            },
        )
        .collect();

    Ok(UsageSummaryResponse {
        total_cost_cents,
        total_input_tokens,
        total_output_tokens,
        by_provider,
        daily_totals,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect(":memory:")
            .await
            .expect("create in-memory pool");
        sqlx::query(
            "CREATE TABLE usage_summary (\
             id TEXT PRIMARY KEY, message_id TEXT, conversation_id TEXT, \
             provider_id TEXT, model_id TEXT, \
             input_tokens INTEGER, output_tokens INTEGER, \
             cache_read_tokens INTEGER, cache_write_tokens INTEGER, \
             cost_estimate TEXT, created_at TEXT)",
        )
        .execute(&pool)
        .await
        .expect("create table");
        pool
    }

    #[sqlx::test]
    async fn test_insert_and_query() {
        let pool = test_pool().await;

        insert_usage_summary(
            &pool,
            UsageSummaryRow {
                message_id: "msg-1",
                conversation_id: "conv-1",
                provider_id: "anthropic",
                model_id: "claude-sonnet-4",
                input_tokens: 1000,
                output_tokens: 200,
                cache_read_tokens: 50,
                cache_write_tokens: 500,
                cost_estimate: Some("0.3200"),
            },
        )
        .await
        .expect("insert");

        let summary = get_usage_summary(&pool, "all").await.expect("query");
        assert_eq!(summary.total_input_tokens, 1000);
        assert_eq!(summary.total_output_tokens, 200);
        assert!(summary.total_cost_cents > 0.0);
        assert_eq!(summary.by_provider.len(), 1);
        assert_eq!(summary.by_provider[0].provider_id, "anthropic");
    }

    #[sqlx::test]
    async fn test_zero_cost_providers() {
        let pool = test_pool().await;

        insert_usage_summary(
            &pool,
            UsageSummaryRow {
                message_id: "msg-2",
                conversation_id: "conv-1",
                provider_id: "ollama",
                model_id: "llama3",
                input_tokens: 500,
                output_tokens: 100,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                cost_estimate: None,
            },
        )
        .await
        .expect("insert");

        let summary = get_usage_summary(&pool, "all").await.expect("query");
        assert_eq!(summary.total_input_tokens, 500);
        assert_eq!(summary.total_cost_cents, 0.0);
    }

    #[sqlx::test]
    async fn test_empty_db() {
        let pool = test_pool().await;
        let summary = get_usage_summary(&pool, "all").await.expect("query");
        assert_eq!(summary.total_input_tokens, 0);
        assert_eq!(summary.total_output_tokens, 0);
        assert_eq!(summary.total_cost_cents, 0.0);
        assert!(summary.by_provider.is_empty());
        assert!(summary.daily_totals.is_empty());
    }
}
