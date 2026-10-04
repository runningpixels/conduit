//! `usage_summary` repository — per-message usage rows for fast period aggregation.
//! Each assistant message generates one row in this table, inserted asynchronously
//! after the stream completes. The data is used for the Usage Analytics settings tab.

use std::collections::{BTreeMap, HashMap};

use chrono::Datelike;
use sqlx::SqlitePool;
use uuid::Uuid;

use provider_core::pricing::{estimate_cost_cents, TokenCounts};
use provider_core::schema::ResolvedModelPrice;

use crate::time::now_iso8601;

/// Per-provider/model breakdown of usage for a given period.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageBreakdown {
    pub provider_id: String,
    pub model_id: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    /// `None` when the model has no price: unpriced, not free.
    pub cost_cents: Option<f64>,
    /// The price used, and where it came from; `None` when unpriced.
    pub price: Option<ResolvedModelPrice>,
}

/// Daily usage totals for chart display.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyUsage {
    pub date: String,
    /// Cost of the day's priced usage; unpriced models add nothing here.
    pub cost_cents: f64,
    pub input_tokens: i64,
    pub output_tokens: i64,
}

/// Response from `get_usage_summary`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummaryResponse {
    /// Cost of the period's priced usage, in cents.
    pub total_cost_cents: f64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    /// How many models in the period have no price, so the total is a floor.
    pub unpriced_models: u32,
    /// The date the bundled price snapshot was fetched (`YYYY-MM-DD`).
    pub prices_as_of: String,
    pub by_provider: Vec<ProviderUsageBreakdown>,
    pub daily_totals: Vec<DailyUsage>,
}

/// The token counts a cost is computed from, read off a provider's usage report.
pub fn token_counts(usage: &provider_core::schema::ProviderUsage) -> TokenCounts {
    TokenCounts {
        input: usage.input_tokens.unwrap_or(0),
        output: usage.output_tokens.unwrap_or(0),
        cache_read: usage.cache_read_tokens.unwrap_or(0),
        cache_write: usage.cache_write_tokens.unwrap_or(0),
    }
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
///
/// Cost is computed here from the stored token counts with `price_of`, not read
/// from the `cost_estimate` column. That column was written in the wrong unit
/// by builds before this change (dollars labelled as cents) and with a price
/// table that knew a dozen models; pricing at read time fixes every past row
/// without a migration, and lets a corrected price or a user override reach
/// history. Rows are grouped by provider, model and day before pricing, which
/// is exact because cost is linear in each token count.
pub async fn get_usage_summary(
    pool: &SqlitePool,
    period: &str,
    price_of: impl Fn(&str, &str) -> Option<ResolvedModelPrice>,
) -> Result<UsageSummaryResponse, sqlx::Error> {
    let since = period_start(period);

    let groups: Vec<(String, String, String, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT provider_id, model_id, SUBSTR(created_at, 1, 10) AS date,                 COALESCE(SUM(input_tokens), 0),                 COALESCE(SUM(output_tokens), 0),                 COALESCE(SUM(cache_read_tokens), 0),                 COALESCE(SUM(cache_write_tokens), 0)          FROM usage_summary WHERE created_at >= ?          GROUP BY provider_id, model_id, date ORDER BY date",
    )
    .bind(&since)
    .fetch_all(pool)
    .await?;

    let mut prices: HashMap<(String, String), Option<ResolvedModelPrice>> = HashMap::new();
    let mut by_model: Vec<ProviderUsageBreakdown> = Vec::new();
    let mut daily: BTreeMap<String, DailyUsage> = BTreeMap::new();
    let mut total_cost_cents = 0.0;
    let mut total_input_tokens = 0;
    let mut total_output_tokens = 0;

    for (provider_id, model_id, date, input, output, cache_read, cache_write) in groups {
        let key = (provider_id.clone(), model_id.clone());
        let price = *prices
            .entry(key)
            .or_insert_with(|| price_of(&provider_id, &model_id));
        let tokens = TokenCounts {
            input: input.max(0) as u64,
            output: output.max(0) as u64,
            cache_read: cache_read.max(0) as u64,
            cache_write: cache_write.max(0) as u64,
        };
        let cost = price.map(|p| estimate_cost_cents(&provider_id, tokens, &p.price));

        total_cost_cents += cost.unwrap_or(0.0);
        total_input_tokens += input;
        total_output_tokens += output;

        let day = daily.entry(date.clone()).or_insert_with(|| DailyUsage {
            date,
            cost_cents: 0.0,
            input_tokens: 0,
            output_tokens: 0,
        });
        day.cost_cents += cost.unwrap_or(0.0);
        day.input_tokens += input;
        day.output_tokens += output;

        match by_model
            .iter_mut()
            .find(|row| row.provider_id == provider_id && row.model_id == model_id)
        {
            Some(row) => {
                row.input_tokens += input;
                row.output_tokens += output;
                row.cache_read_tokens += cache_read;
                row.cache_write_tokens += cache_write;
                row.cost_cents = row.cost_cents.zip(cost).map(|(a, b)| a + b);
            }
            None => by_model.push(ProviderUsageBreakdown {
                provider_id,
                model_id,
                input_tokens: input,
                output_tokens: output,
                cache_read_tokens: cache_read,
                cache_write_tokens: cache_write,
                cost_cents: cost,
                price,
            }),
        }
    }

    // Most expensive first; unpriced models after priced ones, by tokens.
    by_model.sort_by(|a, b| {
        let cost = |r: &ProviderUsageBreakdown| r.cost_cents.unwrap_or(-1.0);
        cost(b)
            .total_cmp(&cost(a))
            .then((b.input_tokens + b.output_tokens).cmp(&(a.input_tokens + a.output_tokens)))
    });
    let unpriced_models = by_model.iter().filter(|r| r.price.is_none()).count() as u32;

    Ok(UsageSummaryResponse {
        total_cost_cents,
        total_input_tokens,
        total_output_tokens,
        unpriced_models,
        prices_as_of: provider_core::pricing::snapshot_fetched_at().to_string(),
        by_provider: by_model,
        daily_totals: daily.into_values().collect(),
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

        let summary = get_usage_summary(&pool, "all", snapshot_prices)
            .await
            .expect("query");
        assert_eq!(summary.total_input_tokens, 1000);
        assert_eq!(summary.total_output_tokens, 200);
        assert_eq!(summary.by_provider.len(), 1);
        assert_eq!(summary.by_provider[0].provider_id, "anthropic");
        // Priced from the token counts, not the stored (old-unit) estimate:
        // 1000 in at $3, 200 out at $15, 50 cache reads at $0.30 and 500 cache
        // writes at $3.75 = $0.003 + $0.003 + $0.000015 + $0.001875 = $0.00789,
        // i.e. 0.789 cents. (The stored "0.3200" is ignored.)
        assert!((summary.total_cost_cents - 0.789).abs() < 1e-9);
        assert_eq!(summary.unpriced_models, 0);
    }

    fn snapshot_prices(provider: &str, model: &str) -> Option<ResolvedModelPrice> {
        provider_core::pricing::resolve_price(provider, model, &[], None)
    }

    async fn insert(pool: &SqlitePool, provider: &str, model: &str, input: i64, output: i64) {
        insert_usage_summary(
            pool,
            UsageSummaryRow {
                message_id: "m",
                conversation_id: "c",
                provider_id: provider,
                model_id: model,
                input_tokens: input,
                output_tokens: output,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
                cost_estimate: None,
            },
        )
        .await
        .expect("insert");
    }

    #[sqlx::test]
    async fn unpriced_models_are_not_charted_as_free() {
        let pool = test_pool().await;
        insert(&pool, "openai_compat", "my-local-proxy-model", 1_000_000, 0).await;
        insert(&pool, "anthropic", "claude-sonnet-4", 1_000_000, 0).await;

        let summary = get_usage_summary(&pool, "all", snapshot_prices)
            .await
            .expect("query");
        assert_eq!(summary.unpriced_models, 1);
        // Only the priced model counts: 1M input at $3 = 300 cents.
        assert!((summary.total_cost_cents - 300.0).abs() < 1e-9);
        assert_eq!(summary.by_provider[0].model_id, "claude-sonnet-4");
        let unpriced = &summary.by_provider[1];
        assert_eq!(unpriced.cost_cents, None);
        assert!(unpriced.price.is_none());
    }

    #[sqlx::test]
    async fn a_price_supplied_at_read_time_reaches_history() {
        let pool = test_pool().await;
        insert(&pool, "openai_compat", "my-model", 2_000_000, 1_000_000).await;
        insert(&pool, "openai_compat", "my-model", 0, 1_000_000).await;

        let summary = get_usage_summary(&pool, "all", |_, _| {
            Some(ResolvedModelPrice {
                price: provider_core::schema::ModelPrice {
                    input_per_mtok: 1.0,
                    output_per_mtok: 2.0,
                    cache_read_per_mtok: None,
                    cache_write_per_mtok: None,
                },
                source: provider_core::schema::PriceSource::Override,
            })
        })
        .await
        .expect("query");
        // 2M in at $1 + 2M out at $2 = $6 = 600 cents, across both rows.
        assert!((summary.total_cost_cents - 600.0).abs() < 1e-9);
        assert_eq!(summary.by_provider.len(), 1);
        assert_eq!(summary.by_provider[0].cost_cents, Some(600.0));
        assert_eq!(summary.daily_totals.len(), 1);
        assert!((summary.daily_totals[0].cost_cents - 600.0).abs() < 1e-9);
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

        let summary = get_usage_summary(&pool, "all", snapshot_prices)
            .await
            .expect("query");
        assert_eq!(summary.total_input_tokens, 500);
        assert_eq!(summary.total_cost_cents, 0.0);
    }

    #[sqlx::test]
    async fn test_empty_db() {
        let pool = test_pool().await;
        let summary = get_usage_summary(&pool, "all", snapshot_prices)
            .await
            .expect("query");
        assert_eq!(summary.total_input_tokens, 0);
        assert_eq!(summary.total_output_tokens, 0);
        assert_eq!(summary.total_cost_cents, 0.0);
        assert!(summary.by_provider.is_empty());
        assert!(summary.daily_totals.is_empty());
    }
}
