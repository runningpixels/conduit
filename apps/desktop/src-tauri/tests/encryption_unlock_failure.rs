//! M6: non-silent-downgrade policy — KeyUnavailable falls back to Off only
//! when no encrypted data exists; refuses when it does.

mod common;

use conduit_desktop::{
    db::repository::{artifacts, attachments, conversations},
    encryption::{self, Encryption, EncryptionInitError},
};

fn temp_blob_dirs() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

#[tokio::test]
async fn fallback_to_off_when_no_encrypted_data() {
    // A pool with rows, but none encrypted (all enc_key_version NULL / Off).
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let dir = temp_blob_dirs();
    let conv = conversations::create(&pool, None).await.unwrap();
    let art = artifacts::create(&pool, &conv.id, "document", Some("d"), None)
        .await
        .unwrap();
    artifacts::set_content(
        &pool,
        dir.path(),
        &enc,
        &art.id,
        Some("text/plain"),
        &artifacts::ArtifactContent::Text { text: "v0".into() },
    )
    .await
    .unwrap();

    assert!(
        !encryption::encrypted_data_exists(&pool, dir.path(), dir.path())
            .await
            .unwrap()
    );

    // KeyUnavailable + no encrypted data → fall back to Off with a diagnostic.
    let err = EncryptionInitError::KeyUnavailable("backend locked".into());
    let (fallback, diagnostic) =
        encryption::resolve_key_unavailable(err, false).expect("falls back to Off");
    assert!(!fallback.is_on(), "fallback is Off");
    assert!(diagnostic.contains("Starting unencrypted"));
}

#[tokio::test]
async fn refuses_when_encrypted_data_exists() {
    let pool = common::setup_pool().await;
    let on = Encryption::on_with_key(encryption::generate_key(), 1);
    let dir = temp_blob_dirs();
    let conv = conversations::create(&pool, None).await.unwrap();
    let art = artifacts::create(&pool, &conv.id, "document", Some("d"), None)
        .await
        .unwrap();
    artifacts::set_content(
        &pool,
        dir.path(),
        &on,
        &art.id,
        Some("text/plain"),
        &artifacts::ArtifactContent::Text { text: "v0".into() },
    )
    .await
    .unwrap();

    assert!(
        encryption::encrypted_data_exists(&pool, dir.path(), dir.path())
            .await
            .unwrap()
    );

    // KeyUnavailable + encrypted data exists → refuse (Err), never silently
    // downgrade to Off (which would orphan the encrypted rows).
    let err = EncryptionInitError::KeyUnavailable("backend locked".into());
    let refused = encryption::resolve_key_unavailable(err, true);
    assert!(
        refused.is_err(),
        "refuses to start when encrypted data exists"
    );
}

#[tokio::test]
async fn refuses_when_only_attachment_blobs_are_encrypted() {
    let pool = common::setup_pool().await;
    let on = Encryption::on_with_key(encryption::generate_key(), 1);
    let dir = temp_blob_dirs();
    let conv = conversations::create(&pool, None).await.unwrap();

    attachments::save(
        &pool,
        dir.path(),
        &on,
        &conv.id,
        b"secret attachment",
        "text/plain",
        None,
    )
    .await
    .unwrap();

    assert!(
        encryption::encrypted_data_exists(&pool, dir.path(), dir.path())
            .await
            .unwrap(),
        "encrypted attachment blobs block fallback to Off"
    );
}
