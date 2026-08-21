//! Conversation history delete: per-conversation and bulk, with on-disk cleanup.
mod common;

use conduit_desktop::db::repository::{
    artifacts::{self, ArtifactContent},
    attachments, conversations,
};

#[tokio::test]
async fn delete_with_files_removes_artifact_blob() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let artifacts_dir = tempfile::tempdir().unwrap();
    let attachments_dir = tempfile::tempdir().unwrap();
    let conv = conversations::create(&pool, None).await.unwrap();

    let art = artifacts::create(&pool, &conv.id, "code", Some("Snippet"), None)
        .await
        .unwrap();
    let updated = artifacts::set_content(
        &pool,
        artifacts_dir.path(),
        &enc,
        &art.id,
        Some("text/plain"),
        &ArtifactContent::File {
            bytes: b"hello artifact".to_vec(),
            filename: "snippet.txt".into(),
        },
    )
    .await
    .unwrap();
    let rel_path = updated.content_path.expect("file-backed artifact");
    let abs = artifacts_dir.path().join(&rel_path);
    assert!(abs.exists(), "artifact blob should exist before delete");

    conversations::delete_with_files(
        &pool,
        artifacts_dir.path(),
        attachments_dir.path(),
        &conv.id,
    )
    .await
    .unwrap();

    assert!(conversations::get(&pool, &conv.id).await.unwrap().is_none());
    assert!(
        !abs.exists(),
        "artifact blob should be removed after delete"
    );
    assert!(
        !artifacts_dir.path().join(&art.id).exists(),
        "artifact directory should be removed after delete"
    );
}

#[tokio::test]
async fn delete_all_with_files_clears_conversations_but_preserves_settings() {
    let pool = common::setup_pool().await;
    let artifacts_dir = tempfile::tempdir().unwrap();
    let attachments_dir = tempfile::tempdir().unwrap();

    let _a = conversations::create(&pool, Some("One")).await.unwrap();
    let _b = conversations::create(&pool, Some("Two")).await.unwrap();
    assert_eq!(conversations::list(&pool).await.unwrap().len(), 2);

    sqlx::query("INSERT OR REPLACE INTO settings (key, value) VALUES ('theme', '\"dark\"')")
        .execute(&pool)
        .await
        .unwrap();

    conversations::delete_all_with_files(&pool, artifacts_dir.path(), attachments_dir.path())
        .await
        .unwrap();

    assert!(conversations::list(&pool).await.unwrap().is_empty());

    let theme: (String,) = sqlx::query_as("SELECT value FROM settings WHERE key = 'theme'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(theme.0, "\"dark\"");
}

#[tokio::test]
async fn delete_with_files_removes_unshared_attachment_blob() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let artifacts_dir = tempfile::tempdir().unwrap();
    let attachments_dir = tempfile::tempdir().unwrap();
    let conv = conversations::create(&pool, None).await.unwrap();

    let att = attachments::save(
        &pool,
        attachments_dir.path(),
        &enc,
        &conv.id,
        b"attachment bytes",
        "text/plain",
        None,
    )
    .await
    .unwrap();
    let blob_abs = attachments_dir.path().join(&att.path);
    assert!(blob_abs.exists());

    conversations::delete_with_files(
        &pool,
        artifacts_dir.path(),
        attachments_dir.path(),
        &conv.id,
    )
    .await
    .unwrap();

    assert!(
        !blob_abs.exists(),
        "attachment blob should be removed when unreferenced"
    );
}
