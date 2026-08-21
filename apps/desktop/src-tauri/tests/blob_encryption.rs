//! M6: blob files are encrypted on disk when tier is On — the file is not the
//! plaintext, yet read-back + integrity verification round-trip correctly.

mod common;

use conduit_desktop::{
    db::repository::{artifacts, attachments, conversations},
    encryption::Encryption,
};

#[tokio::test]
async fn attachment_blob_is_ciphertext_on_disk() {
    let pool = common::setup_pool().await;
    let on = Encryption::on_with_key(conduit_desktop::encryption::generate_key(), 1);
    let dir = tempfile::tempdir().unwrap();
    let attachments_dir = dir.path().to_path_buf();
    let conv = conversations::create(&pool, None).await.unwrap();

    let bytes = b"top-secret attachment payload".to_vec();
    let att = attachments::save(
        &pool,
        &attachments_dir,
        &on,
        &conv.id,
        &bytes,
        "text/plain",
        None,
    )
    .await
    .unwrap();

    // The blob file exists on disk but is NOT the plaintext — it carries the
    // CDENC1 magic header + ciphertext.
    let blob = attachments::resolve_blob_path(&attachments_dir, &att.path);
    assert!(blob.exists());
    let on_disk = std::fs::read(&blob).unwrap();
    assert_ne!(on_disk, bytes, "on-disk blob is not the plaintext");
    assert_eq!(
        &on_disk[..6],
        b"CDENC1",
        "blob carries the encryption magic"
    );
    assert!(
        !std::str::from_utf8(&on_disk)
            .map(|s| s.contains("top-secret"))
            .unwrap_or(false),
        "plaintext does not appear in the on-disk ciphertext"
    );

    // read_bytes decrypts back to the original plaintext.
    let decoded = attachments::read_bytes(&attachments_dir, &on, &att.path).unwrap();
    assert_eq!(decoded, bytes);

    // Integrity: re-hash of the decoded plaintext matches the stored hash.
    assert!(
        attachments::verify_integrity(&pool, &attachments_dir, &on, &att.id)
            .await
            .unwrap(),
        "integrity holds over the encrypted blob"
    );
}

#[tokio::test]
async fn artifact_file_blob_is_ciphertext_on_disk() {
    let pool = common::setup_pool().await;
    let on = Encryption::on_with_key(conduit_desktop::encryption::generate_key(), 1);
    let dir = tempfile::tempdir().unwrap();
    let artifacts_dir = dir.path().to_path_buf();
    let conv = conversations::create(&pool, None).await.unwrap();

    let art = artifacts::create(&pool, &conv.id, "image", None, None)
        .await
        .unwrap();
    let payload = b"\x89PNG\r\n\x1a\n secret render bytes".to_vec();
    let after = artifacts::set_content(
        &pool,
        &artifacts_dir,
        &on,
        &art.id,
        Some("image/png"),
        &artifacts::ArtifactContent::File {
            bytes: payload.clone(),
            filename: "render.png".into(),
        },
    )
    .await
    .unwrap();

    // The on-disk blob is ciphertext, not the plaintext payload.
    let blob =
        artifacts::resolve_artifact_path(&artifacts_dir, after.content_path.as_deref().unwrap());
    assert!(blob.exists());
    let on_disk = std::fs::read(&blob).unwrap();
    assert_ne!(on_disk, payload);
    assert_eq!(&on_disk[..6], b"CDENC1");

    // File-state is Ok: the decrypted blob hashes to the stored content_hash.
    assert_eq!(
        artifacts::check_file_state(&pool, &artifacts_dir, &on, &art.id)
            .await
            .unwrap(),
        artifacts::FileState::Ok
    );

    // Tampering the on-disk ciphertext (without re-encrypting) breaks integrity.
    std::fs::write(&blob, b"CDENC1 tampered").unwrap();
    assert_eq!(
        artifacts::check_file_state(&pool, &artifacts_dir, &on, &art.id)
            .await
            .unwrap(),
        artifacts::FileState::Modified,
        "tampered ciphertext is detected as Modified"
    );
}
