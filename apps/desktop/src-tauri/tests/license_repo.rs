//! M5: license upsert-by-seat, key-set activation toggle, clock-rollback guard.

mod common;

use conduit_desktop::db::repository::licenses::{
    self, License, LicenseKeySet,
};
use serde_json::json;

fn license(seat: &str, exp: i64, last_seen: Option<i64>) -> License {
    License {
        id: format!("t:{seat}"),
        tenant_id: "t".into(),
        seat_id: seat.into(),
        tier: "pro".into(),
        token: "jwt-token".into(),
        exp,
        config_version: "v1".into(),
        key_set_version: Some("ks1".into()),
        feature_flags: Some(json!(["a", "b"])),
        offline_grace_deadline: Some(exp + 86_400),
        issued_at: Some(1_700_000_000),
        last_seen_server_time: last_seen,
        created_at: "2026-06-22T00:00:00Z".into(),
    }
}

#[tokio::test]
async fn upsert_license_by_seat_preserves_created_at() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    licenses::upsert_license(&pool, &enc, &license("s1", 2_000_000_000, Some(1_000)))
        .await
        .unwrap();

    // Re-issue for the same seat: upserts in place, created_at preserved.
    let mut renewed = license("s1", 2_100_000_000, Some(1_200));
    renewed.tier = "enterprise".into();
    renewed.created_at = "2026-06-23T00:00:00Z".into(); // ignored on update
    licenses::upsert_license(&pool, &enc, &renewed).await.unwrap();

    let active = licenses::get_active_license(&pool, &enc).await.unwrap().unwrap();
    assert_eq!(active.seat_id, "s1");
    assert_eq!(active.tier, "enterprise");
    assert_eq!(active.exp, 2_100_000_000);
    assert_eq!(active.last_seen_server_time, Some(1_200));
    assert_eq!(active.created_at, "2026-06-22T00:00:00Z", "created_at preserved");

    // Only one row for the seat.
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM licenses")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count.0, 1);
}

#[tokio::test]
async fn key_set_activation_toggles_exclusively() {
    let pool = common::setup_pool().await;
    // Key-set ops don't take &Encryption; the binding is here for parity with
    // the other tests and intentionally unused.
    let _enc = common::setup_encryption();

    let ks1 = LicenseKeySet {
        version: "ks1".into(),
        public_keys: json!([{ "kty": "OKP" }]),
        fetched_at: "2026-06-22T00:00:00Z".into(),
        is_active: true,
    };
    let ks2 = LicenseKeySet {
        version: "ks2".into(),
        public_keys: json!([{ "kty": "OKP" }]),
        fetched_at: "2026-06-22T00:00:00Z".into(),
        is_active: false,
    };
    licenses::upsert_key_set(&pool, &ks1).await.unwrap();
    licenses::upsert_key_set(&pool, &ks2).await.unwrap();

    // Activate ks2 → ks1 deactivated.
    licenses::set_active_key_set(&pool, "ks2").await.unwrap();
    let active = licenses::get_active_key_set(&pool).await.unwrap().unwrap();
    assert_eq!(active.version, "ks2");

    // Activate ks1 → ks2 deactivated (exclusive).
    licenses::set_active_key_set(&pool, "ks1").await.unwrap();
    let active = licenses::get_active_key_set(&pool).await.unwrap().unwrap();
    assert_eq!(active.version, "ks1");

    let active_count: (i64,) =
        sqlx::query_as("SELECT COUNT(*) FROM license_key_sets WHERE is_active = 1")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(active_count.0, 1, "exactly one active key set");
}

#[tokio::test]
async fn clock_rollback_guard() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    licenses::upsert_license(&pool, &enc, &license("s1", 2_000_000_000, Some(1_500)))
        .await
        .unwrap();

    // last_seen_server_time anchor is 1500.
    assert_eq!(
        licenses::last_seen_server_time(&pool).await.unwrap(),
        Some(1_500)
    );

    // A claim with a server time earlier than the anchor → rollback detected.
    assert!(
        licenses::refuse_clock_rollback(&pool, 1_400).await.unwrap(),
        "rollback detected when last_seen < anchor"
    );
    // A claim at or after the anchor → no rollback.
    assert!(
        !licenses::refuse_clock_rollback(&pool, 1_500).await.unwrap(),
        "no rollback at the anchor"
    );
}