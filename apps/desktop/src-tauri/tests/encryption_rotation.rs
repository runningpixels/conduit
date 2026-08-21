//! M6: key rotation — v1→v2 re-encrypts every targeted inline row, stamps
//! `enc_key_version = 2`, and the new key decrypts the rows (the old key no
//! longer can).

mod common;

use conduit_desktop::{
    db::repository::{artifacts, conversations, licenses, tenant_cache},
    encryption::{self, Encryption},
};
use serde_json::json;

fn license(seat: &str) -> licenses::License {
    licenses::License {
        id: format!("t:{seat}"),
        tenant_id: "t".into(),
        seat_id: seat.into(),
        tier: "pro".into(),
        token: "jwt-secret-token".into(),
        exp: 2_000_000_000,
        config_version: "v1".into(),
        key_set_version: Some("ks1".into()),
        feature_flags: Some(json!(["a"])),
        offline_grace_deadline: Some(2_000_008_640),
        issued_at: Some(1_700_000_000),
        last_seen_server_time: Some(1_000),
        created_at: "2026-06-22T00:00:00Z".into(),
    }
}

#[tokio::test]
async fn rotate_v1_to_v2_rekeys_all_inline_rows() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let v1 = Encryption::on_with_key(encryption::generate_key(), 1);

    // Seed one row in each targeted table, encrypted under v1. Two artifacts
    // (one text, one json) exercise both inline artifact columns.
    let conv = conversations::create(&pool, None).await.unwrap();
    let art_text = artifacts::create(&pool, &conv.id, "document", Some("d1"), None)
        .await
        .unwrap();
    artifacts::set_content(
        &pool,
        dir.path(),
        &v1,
        &art_text.id,
        Some("text/markdown"),
        &artifacts::ArtifactContent::Text {
            text: "v0 body".into(),
        },
    )
    .await
    .unwrap();
    let art_json = artifacts::create(&pool, &conv.id, "json", Some("d2"), None)
        .await
        .unwrap();
    artifacts::set_content(
        &pool,
        dir.path(),
        &v1,
        &art_json.id,
        Some("application/json"),
        &artifacts::ArtifactContent::Json {
            json: json!({"k": "v"}),
        },
    )
    .await
    .unwrap();

    tenant_cache::upsert_tenant_config(
        &pool,
        &v1,
        &tenant_cache::TenantConfigCache {
            id: "t1".into(),
            version: "v1".into(),
            config_json: json!({"tier": "pro"}),
            fetched_at: "2026-06-22T00:00:00Z".into(),
            expires_at: Some("2099-01-01T00:00:00Z".into()),
        },
    )
    .await
    .unwrap();

    licenses::upsert_license(&pool, &v1, &license("s1"))
        .await
        .unwrap();

    // All seeded rows are at version 1.
    let v1_rows: (i64,) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM artifacts WHERE enc_key_version = 1) \
         + (SELECT COUNT(*) FROM tenant_config_cache WHERE enc_key_version = 1) \
         + (SELECT COUNT(*) FROM licenses WHERE enc_key_version = 1)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(v1_rows.0, 4);

    // Rotate to a new key at version 2.
    let v2 = Encryption::on_with_key(encryption::generate_key(), 2);
    let rekeyed = encryption::rotate(&pool, &v1, &v2).await.unwrap();
    assert_eq!(rekeyed, 4, "all four rows re-keyed");

    // Every targeted row is now stamped at version 2; none remain at 1.
    let v2_rows: (i64,) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM artifacts WHERE enc_key_version = 2) \
         + (SELECT COUNT(*) FROM tenant_config_cache WHERE enc_key_version = 2) \
         + (SELECT COUNT(*) FROM licenses WHERE enc_key_version = 2)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(v2_rows.0, 4, "all rows at version 2");
    let v1_remaining: (i64,) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM artifacts WHERE enc_key_version = 1) \
         + (SELECT COUNT(*) FROM tenant_config_cache WHERE enc_key_version = 1) \
         + (SELECT COUNT(*) FROM licenses WHERE enc_key_version = 1)",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(v1_remaining.0, 0, "no rows left at version 1");

    // The v2 key decrypts every row back to the original plaintext.
    let got_text = artifacts::get(&pool, &v2, &art_text.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got_text.content_text.as_deref(), Some("v0 body"));
    let got_json = artifacts::get(&pool, &v2, &art_json.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got_json.content_json, Some(json!({"k": "v"})));

    let cfg = tenant_cache::get_tenant_config(&pool, &v2, "t1")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(cfg.config_json, json!({"tier": "pro"}));

    let lic = licenses::get_active_license(&pool, &v2)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(lic.token, "jwt-secret-token");

    // The old v1 key can no longer decrypt the rotated rows (the stored values
    // were re-encrypted under v2).
    let stale = artifacts::get(&pool, &v1, &art_text.id).await;
    assert!(stale.is_err(), "v1 key cannot read v2 rows");
}
