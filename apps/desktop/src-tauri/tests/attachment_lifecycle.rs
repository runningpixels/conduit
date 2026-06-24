//! M4: attachment save → list → soft-delete → GC, with integrity verification.

mod common;

use conduit_desktop::db::{
    cleanup::gc_orphan_blobs,
    repository::{attachments, conversations},
};

#[tokio::test]
async fn save_list_soft_delete_and_gc() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let dir = tempfile::tempdir().unwrap();
    let attachments_dir = dir.path().to_path_buf();
    let conv = conversations::create(&pool, None).await.unwrap();

    let bytes = b"hello attachment bytes".to_vec();
    let att = attachments::save(
        &pool,
        &attachments_dir,
        &enc,
        &conv.id,
        &bytes,
        "text/plain",
        Some("chat-paste"),
    )
    .await
    .unwrap();

    // The blob is on disk at the content-addressed path.
    let blob = attachments::resolve_blob_path(&attachments_dir, &att.path);
    assert!(blob.exists(), "blob written");
    assert_eq!(att.size_bytes, bytes.len() as i64);
    assert!(att.hash.is_some());

    // Integrity: re-hash matches.
    assert!(
        attachments::verify_integrity(&pool, &attachments_dir, &enc, &att.id)
            .await
            .unwrap(),
        "integrity ok before delete"
    );

    // List reflects the conversation.
    let listed = attachments::list_for_conversation(&pool, &conv.id)
        .await
        .unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, att.id);
    assert_eq!(listed[0].retention_state, "active");

    // Soft delete keeps the file.
    attachments::set_retention(&pool, &att.id, "deleted")
        .await
        .unwrap();
    assert!(blob.exists(), "blob kept after soft delete");

    // GC reclaims the blob (no other row references the hash).
    let report = gc_orphan_blobs(&pool, &attachments_dir).await.unwrap();
    assert_eq!(report.blobs_deleted, 1);
    assert!(!blob.exists(), "blob removed by GC");
}

#[tokio::test]
async fn attachment_dedupes_on_identical_content() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let dir = tempfile::tempdir().unwrap();
    let attachments_dir = dir.path().to_path_buf();
    let conv = conversations::create(&pool, None).await.unwrap();

    let bytes = b"duplicate-content".to_vec();
    let a = attachments::save(
        &pool,
        &attachments_dir,
        &enc,
        &conv.id,
        &bytes,
        "text/plain",
        None,
    )
    .await
    .unwrap();
    let b = attachments::save(
        &pool,
        &attachments_dir,
        &enc,
        &conv.id,
        &bytes,
        "text/plain",
        None,
    )
    .await
    .unwrap();

    // Two distinct metadata rows, one shared blob, identical hash + path.
    assert_ne!(a.id, b.id);
    assert_eq!(a.path, b.path);
    assert_eq!(a.hash, b.hash);

    // Only one blob file exists on disk.
    let blob = attachments::resolve_blob_path(&attachments_dir, &a.path);
    assert!(blob.exists());

    // Soft-deleting one does NOT let GC remove the shared blob (the other row
    // still references the hash).
    attachments::set_retention(&pool, &a.id, "deleted")
        .await
        .unwrap();
    let report = gc_orphan_blobs(&pool, &attachments_dir).await.unwrap();
    assert_eq!(report.blobs_deleted, 0, "shared blob kept");
    assert_eq!(report.blobs_kept_shared, 1);
    assert!(blob.exists());

    // Soft-deleting the other releases the blob.
    attachments::set_retention(&pool, &b.id, "deleted")
        .await
        .unwrap();
    let report = gc_orphan_blobs(&pool, &attachments_dir).await.unwrap();
    assert_eq!(report.blobs_deleted, 1);
    assert!(!blob.exists());
}

#[tokio::test]
async fn external_modification_breaks_integrity() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let dir = tempfile::tempdir().unwrap();
    let attachments_dir = dir.path().to_path_buf();
    let conv = conversations::create(&pool, None).await.unwrap();

    let att = attachments::save(
        &pool,
        &attachments_dir,
        &enc,
        &conv.id,
        b"original",
        "text/plain",
        None,
    )
    .await
    .unwrap();

    assert!(
        attachments::verify_integrity(&pool, &attachments_dir, &enc, &att.id)
            .await
            .unwrap()
    );

    // Tamper with the blob on disk.
    let blob = attachments::resolve_blob_path(&attachments_dir, &att.path);
    std::fs::write(&blob, b"tampered").unwrap();
    assert!(
        !attachments::verify_integrity(&pool, &attachments_dir, &enc, &att.id)
            .await
            .unwrap(),
        "integrity fails after external modification"
    );

    // Delete the blob file entirely.
    std::fs::remove_file(&blob).unwrap();
    assert!(
        !attachments::verify_integrity(&pool, &attachments_dir, &enc, &att.id)
            .await
            .unwrap(),
        "integrity fails when blob is missing"
    );
}
