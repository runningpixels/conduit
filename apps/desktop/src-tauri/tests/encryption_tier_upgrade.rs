//! M6: tier upgrade — rows written while tier is Off (plaintext, NULL
//! `enc_key_version`) are encrypted in place by `encrypt_existing_plaintext`
//! once tier flips to On, and decrypt round-trips.

mod common;

use conduit_desktop::{
    db::repository::{artifacts, conversations, licenses, tenant_cache},
    encryption::{self, Encryption},
};
use serde_json::json;
use sqlx;

#[tokio::test]
async fn off_data_encrypted_when_tier_flips_on() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let off = common::setup_encryption();

    // Write rows while Off: stored inline columns are plaintext, enc_key_version NULL.
    let conv = conversations::create(&pool, None).await.unwrap();
    let art = artifacts::create(&pool, &conv.id, "document", Some("d"), None)
        .await
        .unwrap();
    artifacts::add_version(
        &pool,
        dir.path(),
        &off,
        &art.id,
        Some("text/markdown"),
        &artifacts::VersionContent::Text { text: "plain body".into() },
    )
    .await
    .unwrap();

    tenant_cache::upsert_tenant_config(
        &pool,
        &off,
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

    // Sanity: nothing is encrypted yet, and the stored content is plaintext.
    assert!(
        !encryption::encrypted_data_exists(&pool, dir.path(), dir.path())
            .await
            .unwrap()
    );
    let raw_text: (Option<String>,) = sqlx::query_as(
        "SELECT content_text FROM artifact_versions WHERE artifact_id = ?",
    )
    .bind(&art.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(raw_text.0.as_deref(), Some("plain body"), "Off stores plaintext");

    // Flip tier to On and migrate existing plaintext into the current key.
    let on = Encryption::on_with_key(encryption::generate_key(), 1);
    let rekeyed = encryption::encrypt_existing_plaintext(&pool, &on).await.unwrap();
    assert_eq!(rekeyed, 2, "artifact + tenant rows re-keyed");

    // Now encrypted data exists, rows are stamped at version 1, and the on-disk
    // inline columns are no longer the plaintext.
    assert!(
        encryption::encrypted_data_exists(&pool, dir.path(), dir.path())
            .await
            .unwrap()
    );
    let stamped: (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM artifact_versions WHERE enc_key_version = 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stamped.0, 1);
    let raw_text: (Option<String>,) = sqlx::query_as(
        "SELECT content_text FROM artifact_versions WHERE artifact_id = ?",
    )
    .bind(&art.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_ne!(
        raw_text.0.as_deref(),
        Some("plain body"),
        "stored value is now ciphertext"
    );
    assert!(
        raw_text.0.as_deref().unwrap().starts_with("enc:v1:"),
        "stored value carries the encryption prefix"
    );

    // The On key decrypts back to the original plaintext.
    let versions = artifacts::get_versions(&pool, &on, &art.id).await.unwrap();
    assert_eq!(versions[0].content_text.as_deref(), Some("plain body"));
    let cfg = tenant_cache::get_tenant_config(&pool, &on, "t1").await.unwrap().unwrap();
    assert_eq!(cfg.config_json, json!({"tier": "pro"}));

    // Idempotent: a second pass finds no NULL-version rows.
    let again = encryption::encrypt_existing_plaintext(&pool, &on).await.unwrap();
    assert_eq!(again, 0, "migration is idempotent");
}

#[tokio::test]
async fn encrypt_existing_is_noop_when_off() {
    let pool = common::setup_pool().await;
    let off = common::setup_encryption();
    // encrypt_existing_plaintext with an Off encryption is a no-op (returns 0),
    // even if rows exist — Off has no key to encrypt to.
    let _conv = conversations::create(&pool, None).await.unwrap();
    licenses::upsert_license(
        &pool,
        &off,
        &licenses::License {
            id: "t:s1".into(),
            tenant_id: "t".into(),
            seat_id: "s1".into(),
            tier: "pro".into(),
            token: "tok".into(),
            exp: 2_000_000_000,
            config_version: "v1".into(),
            key_set_version: None,
            feature_flags: None,
            offline_grace_deadline: None,
            issued_at: None,
            last_seen_server_time: None,
            created_at: "2026-06-22T00:00:00Z".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(
        encryption::encrypt_existing_plaintext(&pool, &off).await.unwrap(),
        0
    );
}