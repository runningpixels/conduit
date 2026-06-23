//! M4: the artifact file-state machine (spec §8.3) — Ok / Missing / Modified.

mod common;

use conduit_desktop::db::repository::{
    artifacts::{self, FileState, VersionContent},
    conversations,
};

#[tokio::test]
async fn file_state_ok_missing_modified() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let dir = tempfile::tempdir().unwrap();
    let artifacts_dir = dir.path().to_path_buf();
    let conv = conversations::create(&pool, None).await.unwrap();

    let art = artifacts::create(&pool, &conv.id, "image", None, None)
        .await
        .unwrap();
    let v = artifacts::add_version(
        &pool,
        &artifacts_dir,
        &enc,
        &art.id,
        Some("image/png"),
        &VersionContent::File {
            bytes: b"\x89PNG\r\n\x1a\n fake png bytes".to_vec(),
            filename: "render.png".into(),
        },
    )
    .await
    .unwrap();

    // The blob is on disk under artifacts/<artifact_id>/<version_id>/<filename>.
    let blob = artifacts::resolve_version_path(&artifacts_dir, v.content_path.as_deref().unwrap());
    assert!(blob.exists());

    // Ok: file present + hash matches.
    assert_eq!(
        artifacts::check_file_state(&pool, &artifacts_dir, &enc, &art.id)
            .await
            .unwrap(),
        FileState::Ok
    );

    // Modified: file present but content changed.
    std::fs::write(&blob, b"tampered content").unwrap();
    assert_eq!(
        artifacts::check_file_state(&pool, &artifacts_dir, &enc, &art.id)
            .await
            .unwrap(),
        FileState::Modified
    );

    // Missing: file removed.
    std::fs::remove_file(&blob).unwrap();
    assert_eq!(
        artifacts::check_file_state(&pool, &artifacts_dir, &enc, &art.id)
            .await
            .unwrap(),
        FileState::Missing
    );
}