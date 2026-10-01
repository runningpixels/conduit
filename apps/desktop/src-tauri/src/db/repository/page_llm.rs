//! "Always allow" model-access grants (ADR-014), per principal.
//!
//! A principal is what a page belongs to: an artifact in a chat
//! (`artifact:<id>`) or a saved mini-app (`app:<id>`). One row per principal
//! and provider id, in `principal_grants` with capability `llm`. Session-only
//! grants ("Allow this time") are not stored here; see `page_llm` (the
//! top-level module) for those.
//!
//! Switching the active provider asks again by construction: a grant's
//! `target` is the provider id it was given for, so a lookup against a
//! different provider simply finds nothing.

use sqlx::SqlitePool;

use super::artifact_network::Principal;
use crate::{db::DbError, time::now_iso8601};

const LLM: &str = "llm";

/// Record that the user always allows `provider_id` to answer for `principal`.
/// Idempotent.
pub async fn grant(
    pool: &SqlitePool,
    principal: &Principal,
    provider_id: &str,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO principal_grants (principal, capability, target, granted_at) \
         VALUES (?, ?, ?, ?) ON CONFLICT(principal, capability, target) DO NOTHING",
    )
    .bind(principal.key())
    .bind(LLM)
    .bind(provider_id)
    .bind(now_iso8601())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn is_granted(
    pool: &SqlitePool,
    principal: &Principal,
    provider_id: &str,
) -> Result<bool, DbError> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM principal_grants WHERE principal = ? AND capability = ? AND target = ?",
    )
    .bind(principal.key())
    .bind(LLM)
    .bind(provider_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Forget every stored model-access grant for `principal`, whichever provider
/// it was given for. The caller also clears the in-memory session grant
/// (`page_llm::revoke_session`) — this only reaches the persisted half.
pub async fn revoke(pool: &SqlitePool, principal: &Principal) -> Result<(), DbError> {
    sqlx::query("DELETE FROM principal_grants WHERE principal = ? AND capability = ?")
        .bind(principal.key())
        .bind(LLM)
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
        pool
    }

    #[tokio::test]
    async fn grant_is_idempotent_and_scoped_to_the_provider() {
        let pool = pool().await;
        let p = Principal::artifact("a1");
        assert!(!is_granted(&pool, &p, "anthropic").await.unwrap());
        grant(&pool, &p, "anthropic").await.unwrap();
        grant(&pool, &p, "anthropic").await.unwrap(); // idempotent
        assert!(is_granted(&pool, &p, "anthropic").await.unwrap());
        assert!(
            !is_granted(&pool, &p, "openai").await.unwrap(),
            "a grant for one provider doesn't cover another"
        );
    }

    #[tokio::test]
    async fn revoke_clears_every_provider_for_the_principal_only() {
        let pool = pool().await;
        let p1 = Principal::artifact("a2");
        let p2 = Principal::app("a2");
        grant(&pool, &p1, "anthropic").await.unwrap();
        grant(&pool, &p1, "openai").await.unwrap();
        grant(&pool, &p2, "anthropic").await.unwrap();
        revoke(&pool, &p1).await.unwrap();
        assert!(!is_granted(&pool, &p1, "anthropic").await.unwrap());
        assert!(!is_granted(&pool, &p1, "openai").await.unwrap());
        assert!(
            is_granted(&pool, &p2, "anthropic").await.unwrap(),
            "the other principal is untouched"
        );
    }
}
