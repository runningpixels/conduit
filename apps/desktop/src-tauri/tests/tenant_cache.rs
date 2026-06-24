//! M5: tenant config cache — upsert, stale → None, invalidate.

mod common;

use conduit_desktop::db::repository::tenant_cache::{self, TenantConfigCache};
use serde_json::json;

fn entry(id: &str, expires_at: Option<&str>) -> TenantConfigCache {
    TenantConfigCache {
        id: id.into(),
        version: "v1".into(),
        config_json: json!({"tier": "pro", "features": ["a"]}),
        fetched_at: "2026-06-22T00:00:00Z".into(),
        expires_at: expires_at.map(|s| s.to_string()),
    }
}

#[tokio::test]
async fn fresh_cache_returns_config() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    tenant_cache::upsert_tenant_config(&pool, &enc, &entry("t1", Some("2099-01-01T00:00:00Z")))
        .await
        .unwrap();

    let cached = tenant_cache::get_tenant_config(&pool, &enc, "t1")
        .await
        .unwrap();
    assert!(cached.is_some());
    assert_eq!(cached.unwrap().version, "v1");
}

#[tokio::test]
async fn stale_cache_returns_none() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    tenant_cache::upsert_tenant_config(&pool, &enc, &entry("t2", Some("2020-01-01T00:00:00Z")))
        .await
        .unwrap();

    assert!(
        tenant_cache::get_tenant_config(&pool, &enc, "t2")
            .await
            .unwrap()
            .is_none(),
        "expired cache is stale → None"
    );
}

#[tokio::test]
async fn null_expires_at_is_non_expiring() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    tenant_cache::upsert_tenant_config(&pool, &enc, &entry("t3", None))
        .await
        .unwrap();
    assert!(tenant_cache::get_tenant_config(&pool, &enc, "t3")
        .await
        .unwrap()
        .is_some());
}

#[tokio::test]
async fn invalidate_forces_refetch() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    tenant_cache::upsert_tenant_config(&pool, &enc, &entry("t4", Some("2099-01-01T00:00:00Z")))
        .await
        .unwrap();
    assert!(tenant_cache::get_tenant_config(&pool, &enc, "t4")
        .await
        .unwrap()
        .is_some());
    tenant_cache::invalidate(&pool, "t4").await.unwrap();
    assert!(
        tenant_cache::get_tenant_config(&pool, &enc, "t4")
            .await
            .unwrap()
            .is_none(),
        "invalidate drops the cache"
    );
}
