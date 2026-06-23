//! M4: artifact version append + ordering + restore.

mod common;

use conduit_desktop::db::repository::{
    artifacts::{self, FileState, VersionContent},
    conversations,
};
use serde_json::json;

#[tokio::test]
async fn append_three_versions_in_order_and_restore() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let dir = tempfile::tempdir().unwrap();
    let artifacts_dir = dir.path().to_path_buf();
    let conv = conversations::create(&pool, None).await.unwrap();

    let art = artifacts::create(&pool, &conv.id, "document", Some("Notes"), None)
        .await
        .unwrap();
    assert_eq!(art.current_version_id, "", "no versions yet");

    let v0 = artifacts::add_version(
        &pool,
        &artifacts_dir,
        &enc,
        &art.id,
        Some("text/markdown"),
        &VersionContent::Text {
            text: "v0 body".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(v0.index, 0);

    let v1 = artifacts::add_version(
        &pool,
        &artifacts_dir,
        &enc,
        &art.id,
        Some("text/markdown"),
        &VersionContent::Text {
            text: "v1 body".into(),
        },
    )
    .await
    .unwrap();
    assert_eq!(v1.index, 1);

    let v2 = artifacts::add_version(
        &pool,
        &artifacts_dir,
        &enc,
        &art.id,
        Some("application/json"),
        &VersionContent::Json { json: json!({"v": 2}) },
    )
    .await
    .unwrap();
    assert_eq!(v2.index, 2);

    // Versions are returned in ordinal order.
    let versions = artifacts::get_versions(&pool, &enc, &art.id).await.unwrap();
    assert_eq!(versions.len(), 3);
    assert_eq!(versions[0].id, v0.id);
    assert_eq!(versions[1].id, v1.id);
    assert_eq!(versions[2].id, v2.id);

    // current_version_id tracks the latest append.
    let listed = artifacts::list(&pool, &conv.id).await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].current_version_id, v2.id);

    // Restore v0: current re-points, history unchanged.
    artifacts::restore_version(&pool, &art.id, &v0.id)
        .await
        .unwrap();
    let listed = artifacts::list(&pool, &conv.id).await.unwrap();
    assert_eq!(listed[0].current_version_id, v0.id);
    let versions_after = artifacts::get_versions(&pool, &enc, &art.id).await.unwrap();
    assert_eq!(versions_after.len(), 3, "restore does not mutate history");

    // Restoring a foreign version id is rejected.
    let bad = artifacts::restore_version(&pool, &art.id, "not-a-version").await;
    assert!(bad.is_err());

    // Inline versions report NoFileContent.
    assert_eq!(
        artifacts::check_file_state(&pool, &artifacts_dir, &enc, &art.id)
            .await
            .unwrap(),
        FileState::NoFileContent
    );
}