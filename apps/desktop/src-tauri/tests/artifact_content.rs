//! Phase 5: single-payload artifact model — `set_content` overwrites in place
//! (no append, no version rows), and `get` reads the current payload back.

mod common;

use conduit_desktop::db::repository::{
    artifacts::{self, ArtifactContent, FileState},
    conversations,
};
use serde_json::json;

#[tokio::test]
async fn set_content_overwrites_in_place() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let dir = tempfile::tempdir().unwrap();
    let artifacts_dir = dir.path().to_path_buf();
    let conv = conversations::create(&pool, None).await.unwrap();

    let art = artifacts::create(&pool, &conv.id, "document", Some("Notes"), None)
        .await
        .unwrap();

    // No payload yet.
    let empty = artifacts::get(&pool, &enc, &art.id).await.unwrap().unwrap();
    assert!(empty.content_text.is_none());
    assert!(empty.updated_at.is_none());

    // First write.
    let after_first = artifacts::set_content(
        &pool,
        &artifacts_dir,
        &enc,
        &art.id,
        Some("text/markdown"),
        &ArtifactContent::Text {
            text: "first body".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(after_first.content_text.as_deref(), Some("first body"));
    assert!(after_first.updated_at.is_some());

    // Overwrite: the payload is replaced, not appended. There is still exactly
    // one artifact row and its content is the latest write.
    let after_second = artifacts::set_content(
        &pool,
        &artifacts_dir,
        &enc,
        &art.id,
        Some("text/markdown"),
        &ArtifactContent::Text {
            text: "second body".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(after_second.content_text.as_deref(), Some("second body"));

    let got = artifacts::get(&pool, &enc, &art.id).await.unwrap().unwrap();
    assert_eq!(
        got.content_text.as_deref(),
        Some("second body"),
        "get returns the latest payload"
    );

    // One artifact in the conversation, still current (no version history).
    let listed = artifacts::list(&pool, &conv.id).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, art.id);

    // Inline payloads report NoFileContent.
    assert_eq!(
        artifacts::check_file_state(&pool, &artifacts_dir, &enc, &art.id)
            .await
            .unwrap(),
        FileState::NoFileContent
    );
}

#[tokio::test]
async fn set_content_json_round_trips() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let dir = tempfile::tempdir().unwrap();
    let artifacts_dir = dir.path().to_path_buf();
    let conv = conversations::create(&pool, None).await.unwrap();

    let art = artifacts::create(&pool, &conv.id, "json", None, None)
        .await
        .unwrap();
    artifacts::set_content(
        &pool,
        &artifacts_dir,
        &enc,
        &art.id,
        Some("application/json"),
        &ArtifactContent::Json {
            json: json!({"v": 2, "nested": {"a": [1, 2]}}),
        },
    )
    .await
    .unwrap();

    let got = artifacts::get(&pool, &enc, &art.id).await.unwrap().unwrap();
    assert_eq!(
        got.content_json,
        Some(json!({"v": 2, "nested": {"a": [1, 2]}}))
    );
    assert!(got.content_text.is_none());
}

#[tokio::test]
async fn set_content_file_writes_blob_and_hashes() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let dir = tempfile::tempdir().unwrap();
    let artifacts_dir = dir.path().to_path_buf();
    let conv = conversations::create(&pool, None).await.unwrap();

    let art = artifacts::create(&pool, &conv.id, "image", None, None)
        .await
        .unwrap();
    let after = artifacts::set_content(
        &pool,
        &artifacts_dir,
        &enc,
        &art.id,
        Some("image/png"),
        &ArtifactContent::File {
            bytes: b"\x89PNG\r\n\x1a\n fake png bytes".to_vec(),
            filename: "render.png".into(),
        },
    )
    .await
    .unwrap();

    // The blob lives at artifacts/<artifact_id>/<filename> (no version segment).
    let blob =
        artifacts::resolve_artifact_path(&artifacts_dir, after.content_path.as_deref().unwrap());
    assert!(blob.exists());
    assert_eq!(
        after.content_path.as_deref().unwrap(),
        format!("{}/render.png", art.id)
    );

    // File-state is Ok: the decrypted blob hashes to the stored content_hash.
    assert_eq!(
        artifacts::check_file_state(&pool, &artifacts_dir, &enc, &art.id)
            .await
            .unwrap(),
        FileState::Ok
    );
}

#[tokio::test]
async fn set_content_replaces_previous_file_blob() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let dir = tempfile::tempdir().unwrap();
    let artifacts_dir = dir.path().to_path_buf();
    let conv = conversations::create(&pool, None).await.unwrap();

    let art = artifacts::create(&pool, &conv.id, "image", None, None)
        .await
        .unwrap();
    let first = artifacts::set_content(
        &pool,
        &artifacts_dir,
        &enc,
        &art.id,
        Some("image/png"),
        &ArtifactContent::File {
            bytes: b"first".to_vec(),
            filename: "a.png".into(),
        },
    )
    .await
    .unwrap();
    let first_blob =
        artifacts::resolve_artifact_path(&artifacts_dir, first.content_path.as_deref().unwrap());
    assert!(first_blob.exists());

    // Overwrite with a different filename: the old blob is removed.
    artifacts::set_content(
        &pool,
        &artifacts_dir,
        &enc,
        &art.id,
        Some("image/png"),
        &ArtifactContent::File {
            bytes: b"second".to_vec(),
            filename: "b.png".into(),
        },
    )
    .await
    .unwrap();
    assert!(!first_blob.exists(), "previous blob was cleaned up");
}

#[tokio::test]
async fn set_content_rejects_unknown_artifact() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let dir = tempfile::tempdir().unwrap();
    let artifacts_dir = dir.path().to_path_buf();

    let err = artifacts::set_content(
        &pool,
        &artifacts_dir,
        &enc,
        "not-a-real-artifact",
        None,
        &ArtifactContent::Text { text: "x".into() },
    )
    .await;
    assert!(err.is_err());
}

#[tokio::test]
async fn read_content_bytes_round_trips() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let dir = tempfile::tempdir().unwrap();
    let artifacts_dir = dir.path().to_path_buf();
    let conv = conversations::create(&pool, None).await.unwrap();

    let art = artifacts::create(&pool, &conv.id, "image", None, None)
        .await
        .unwrap();
    let payload = b"file payload bytes".to_vec();
    artifacts::set_content(
        &pool,
        &artifacts_dir,
        &enc,
        &art.id,
        Some("application/octet-stream"),
        &ArtifactContent::File {
            bytes: payload.clone(),
            filename: "bin.dat".into(),
        },
    )
    .await
    .unwrap();

    let bytes = artifacts::read_content_bytes(&pool, &artifacts_dir, &enc, &art.id)
        .await
        .unwrap();
    assert_eq!(bytes, payload);
}
