//! Per-app settings (migration 0029): the two model slots and the daily
//! cloud-token limit. One row per app, created on first write; no row means
//! every default. Deleting the app cascades the row away.

use provider_core::schema::{AppLlmSlot, AppModelChoice, AppModelSlots};
use sqlx::SqlitePool;

use crate::{db::DbError, time::now_iso8601};

pub const DEFAULT_DAILY_TOKEN_CAP: u64 = 100_000;
pub const MIN_DAILY_TOKEN_CAP: u64 = 1_000;
pub const MAX_DAILY_TOKEN_CAP: u64 = 10_000_000;
pub const MAX_MODEL_CHARS: usize = 200;

/// What is stored for an app: the slot mappings and the user's own cap.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StoredAppSettings {
    pub slots: AppModelSlots,
    pub daily_token_cap: Option<u64>,
}

impl StoredAppSettings {
    pub fn effective_cap(&self) -> u64 {
        self.daily_token_cap.unwrap_or(DEFAULT_DAILY_TOKEN_CAP)
    }
}

type Row = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<i64>,
);

fn choice(provider: Option<String>, model: Option<String>) -> Option<AppModelChoice> {
    match (provider, model) {
        (Some(provider_id), Some(model)) => Some(AppModelChoice { provider_id, model }),
        _ => None,
    }
}

pub async fn app_exists(pool: &SqlitePool, app_id: &str) -> Result<bool, DbError> {
    let row: Option<(i64,)> = sqlx::query_as("SELECT 1 FROM apps WHERE id = ?")
        .bind(app_id)
        .fetch_optional(pool)
        .await?;
    Ok(row.is_some())
}

pub async fn get(pool: &SqlitePool, app_id: &str) -> Result<StoredAppSettings, DbError> {
    let row: Option<Row> = sqlx::query_as(
        "SELECT default_provider, default_model, quick_provider, quick_model, daily_token_cap \
         FROM app_settings WHERE app_id = ?",
    )
    .bind(app_id)
    .fetch_optional(pool)
    .await?;
    Ok(match row {
        None => StoredAppSettings::default(),
        Some((dp, dm, qp, qm, cap)) => StoredAppSettings {
            slots: AppModelSlots {
                default: choice(dp, dm),
                quick: choice(qp, qm),
            },
            daily_token_cap: cap.map(|c| c.max(0) as u64),
        },
    })
}

/// Map `slot` to `choice`, or back to following the fallback with `None`.
pub async fn set_slot(
    pool: &SqlitePool,
    app_id: &str,
    slot: AppLlmSlot,
    choice: Option<&AppModelChoice>,
) -> Result<(), DbError> {
    let (provider_col, model_col) = match slot {
        AppLlmSlot::Default => ("default_provider", "default_model"),
        AppLlmSlot::Quick => ("quick_provider", "quick_model"),
    };
    let sql = format!(
        "INSERT INTO app_settings (app_id, {provider_col}, {model_col}, updated_at) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT(app_id) DO UPDATE SET \
           {provider_col} = excluded.{provider_col}, \
           {model_col} = excluded.{model_col}, \
           updated_at = excluded.updated_at"
    );
    sqlx::query(&sql)
        .bind(app_id)
        .bind(choice.map(|c| c.provider_id.as_str()))
        .bind(choice.map(|c| c.model.as_str()))
        .bind(now_iso8601())
        .execute(pool)
        .await?;
    Ok(())
}

/// Set the user's own daily limit, or `None` to go back to the default.
pub async fn set_cap(pool: &SqlitePool, app_id: &str, cap: Option<u64>) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO app_settings (app_id, daily_token_cap, updated_at) VALUES (?, ?, ?) \
         ON CONFLICT(app_id) DO UPDATE SET \
           daily_token_cap = excluded.daily_token_cap, \
           updated_at = excluded.updated_at",
    )
    .bind(app_id)
    .bind(cap.map(|c| c as i64))
    .bind(now_iso8601())
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        crate::db::migrations::MIGRATOR.run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO apps (id, name, category, version, origin, manifest_json, payload, \
             content_hash, created_at, updated_at) \
             VALUES ('a1', 'T', 'tools', '1.0.0', 'saved', '{}', '', 'h', 'x', 'x')",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    fn pick(provider: &str, model: &str) -> AppModelChoice {
        AppModelChoice {
            provider_id: provider.to_string(),
            model: model.to_string(),
        }
    }

    #[tokio::test]
    async fn no_row_means_every_default() {
        let pool = pool().await;
        let s = get(&pool, "a1").await.unwrap();
        assert_eq!(s, StoredAppSettings::default());
        assert_eq!(s.effective_cap(), DEFAULT_DAILY_TOKEN_CAP);
    }

    #[tokio::test]
    async fn slots_and_cap_are_independent() {
        let pool = pool().await;
        set_slot(&pool, "a1", AppLlmSlot::Quick, Some(&pick("openai", "m1")))
            .await
            .unwrap();
        set_cap(&pool, "a1", Some(5_000)).await.unwrap();
        set_slot(
            &pool,
            "a1",
            AppLlmSlot::Default,
            Some(&pick("ollama", "m2")),
        )
        .await
        .unwrap();
        let s = get(&pool, "a1").await.unwrap();
        assert_eq!(s.slots.quick, Some(pick("openai", "m1")));
        assert_eq!(s.slots.default, Some(pick("ollama", "m2")));
        assert_eq!(s.daily_token_cap, Some(5_000));
        set_slot(&pool, "a1", AppLlmSlot::Quick, None)
            .await
            .unwrap();
        set_cap(&pool, "a1", None).await.unwrap();
        let s = get(&pool, "a1").await.unwrap();
        assert_eq!(s.slots.quick, None);
        assert_eq!(s.slots.default, Some(pick("ollama", "m2")));
        assert_eq!(s.daily_token_cap, None);
    }

    #[tokio::test]
    async fn deleting_the_app_cascades_its_settings() {
        let pool = pool().await;
        set_cap(&pool, "a1", Some(2_000)).await.unwrap();
        crate::db::repository::apps::delete(&pool, "a1")
            .await
            .unwrap();
        let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM app_settings")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0);
    }
}
