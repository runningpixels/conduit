//! "Always allow" network grants (ADR-010), per principal.
//!
//! A principal is what a page belongs to: an artifact in a chat
//! (`artifact:<id>`) or a saved mini-app (`app:<id>`). One row per principal
//! and https origin, in `principal_grants` with capability `net`. Session-only
//! grants ("Allow this time") are not stored; see `artifact_network`.

use serde::Serialize;
use sqlx::SqlitePool;

use crate::{db::DbError, time::now_iso8601};

const NET: &str = "net";

/// Who a grant belongs to. Parsed from, and written as, `artifact:<id>` or
/// `app:<id>`. Anything else is refused: an unparsed string must never become
/// a grant key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Principal {
    Artifact(String),
    App(String),
}

impl Principal {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let (kind, id) = raw
            .split_once(':')
            .ok_or_else(|| format!("Not a page reference: {raw}"))?;
        let valid_id = !id.is_empty()
            && id.len() <= 64
            && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if !valid_id {
            return Err(format!("Not a page reference: {raw}"));
        }
        match kind {
            "artifact" => Ok(Self::Artifact(id.to_string())),
            "app" => Ok(Self::App(id.to_string())),
            _ => Err(format!("Not a page reference: {raw}")),
        }
    }

    pub fn artifact(id: &str) -> Self {
        Self::Artifact(id.to_string())
    }

    pub fn app(id: &str) -> Self {
        Self::App(id.to_string())
    }

    /// The stored form, also the key for session grants and rate limits.
    pub fn key(&self) -> String {
        match self {
            Self::Artifact(id) => format!("artifact:{id}"),
            Self::App(id) => format!("app:{id}"),
        }
    }

    pub fn kind(&self) -> &'static str {
        match self {
            Self::Artifact(_) => "artifact",
            Self::App(_) => "app",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkGrant {
    /// `artifact:<id>` or `app:<id>`.
    pub principal: String,
    /// `artifact` or `app`.
    pub kind: String,
    pub host: String,
    pub created_at: String,
    pub last_used_at: Option<String>,
    /// The artifact's title or the app's name, for the Settings list. `None`
    /// when untitled.
    pub title: Option<String>,
}

/// Record that the user always allows `host` for `principal`. Idempotent.
pub async fn grant(pool: &SqlitePool, principal: &Principal, host: &str) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO principal_grants (principal, capability, target, granted_at) \
         VALUES (?, ?, ?, ?) ON CONFLICT(principal, capability, target) DO NOTHING",
    )
    .bind(principal.key())
    .bind(NET)
    .bind(host)
    .bind(now_iso8601())
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn is_granted(
    pool: &SqlitePool,
    principal: &Principal,
    host: &str,
) -> Result<bool, DbError> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1 FROM principal_grants WHERE principal = ? AND capability = ? AND target = ?",
    )
    .bind(principal.key())
    .bind(NET)
    .bind(host)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

pub async fn touch(pool: &SqlitePool, principal: &Principal, host: &str) -> Result<(), DbError> {
    sqlx::query(
        "UPDATE principal_grants SET last_used_at = ? \
         WHERE principal = ? AND capability = ? AND target = ?",
    )
    .bind(now_iso8601())
    .bind(principal.key())
    .bind(NET)
    .bind(host)
    .execute(pool)
    .await?;
    Ok(())
}

/// `principal, host, created_at, last_used_at, title` as selected by [`list`].
type GrantRow = (String, String, String, Option<String>, Option<String>);

/// Grants for one principal, or for every principal when `principal` is `None`.
pub async fn list(
    pool: &SqlitePool,
    principal: Option<&Principal>,
) -> Result<Vec<NetworkGrant>, DbError> {
    let rows: Vec<GrantRow> = sqlx::query_as(
        "SELECT g.principal, g.target, g.granted_at, g.last_used_at, COALESCE(a.title, p.name) \
         FROM principal_grants g \
         LEFT JOIN artifacts a ON g.principal = 'artifact:' || a.id \
         LEFT JOIN apps p ON g.principal = 'app:' || p.id \
         WHERE g.capability = ?1 AND (?2 IS NULL OR g.principal = ?2) \
         ORDER BY COALESCE(g.last_used_at, g.granted_at) DESC",
    )
    .bind(NET)
    .bind(principal.map(Principal::key))
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(principal, host, created_at, last_used_at, title)| {
            let kind = principal
                .split_once(':')
                .map(|(k, _)| k.to_string())
                .unwrap_or_default();
            NetworkGrant {
                principal,
                kind,
                host,
                created_at,
                last_used_at,
                title,
            }
        })
        .collect())
}

pub async fn revoke(pool: &SqlitePool, principal: &Principal, host: &str) -> Result<(), DbError> {
    sqlx::query(
        "DELETE FROM principal_grants WHERE principal = ? AND capability = ? AND target = ?",
    )
    .bind(principal.key())
    .bind(NET)
    .bind(host)
    .execute(pool)
    .await?;
    Ok(())
}

/// Remove every network grant, or every one of one principal.
pub async fn clear(pool: &SqlitePool, principal: Option<&Principal>) -> Result<(), DbError> {
    sqlx::query(
        "DELETE FROM principal_grants WHERE capability = ?1 AND (?2 IS NULL OR principal = ?2)",
    )
    .bind(NET)
    .bind(principal.map(Principal::key))
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Principal;

    /// 0024 copies ADR-010's artifact grants into `principal_grants`, and the
    /// trigger that replaces the old foreign key still clears them.
    #[tokio::test]
    async fn existing_artifact_grants_survive_the_move_to_principals() {
        use crate::db::{
            migrations::MIGRATOR,
            repository::{artifacts, conversations},
        };
        use sqlx::migrate::Migrator;
        use std::borrow::Cow;

        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let before = Migrator {
            migrations: Cow::Owned(
                MIGRATOR
                    .iter()
                    .filter(|m| m.version <= 23)
                    .cloned()
                    .collect(),
            ),
            ..Migrator::DEFAULT
        };
        before.run(&pool).await.unwrap();
        let conv = conversations::create(&pool, None).await.unwrap();
        let art = artifacts::create(&pool, &conv.id, "html", Some("Weather"), None)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO artifact_network_grants (artifact_id, host, created_at, last_used_at)              VALUES (?, 'https://api.open-meteo.com', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z')",
        )
        .bind(&art.id)
        .execute(&pool)
        .await
        .unwrap();

        MIGRATOR.run(&pool).await.unwrap();

        let page = Principal::artifact(&art.id);
        let listed = super::list(&pool, Some(&page)).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].host, "https://api.open-meteo.com");
        assert_eq!(listed[0].created_at, "2026-09-01T00:00:00Z");
        assert_eq!(
            listed[0].last_used_at.as_deref(),
            Some("2026-09-02T00:00:00Z")
        );
        assert_eq!(listed[0].title.as_deref(), Some("Weather"));

        sqlx::query("DELETE FROM artifacts WHERE id = ?")
            .bind(&art.id)
            .execute(&pool)
            .await
            .unwrap();
        assert!(super::list(&pool, None).await.unwrap().is_empty());
    }

    #[test]
    fn principal_round_trips_and_refuses_anything_else() {
        let id = "3f1c2b7e-0000-4000-8000-000000000001";
        assert_eq!(
            Principal::parse(&format!("artifact:{id}")).unwrap(),
            Principal::artifact(id)
        );
        assert_eq!(
            Principal::parse(&format!("app:{id}")).unwrap().key(),
            format!("app:{id}")
        );
        for bad in [
            "",
            id,
            "app:",
            "workflow:abc",
            "app:a b",
            "app:../x",
            "app:x:y",
            "artifact:%",
        ] {
            assert!(Principal::parse(bad).is_err(), "{bad:?} should be refused");
        }
    }
}
