//! Phase 5 M5: `artifacts::export` writes the current payload to a directory,
//! with an optional curated `.conduit.json` metadata sidecar.

mod common;

use conduit_desktop::db::repository::{
    artifacts::{self, ArtifactContent},
    conversations,
};
use serde_json::Value;
use std::fs;

#[tokio::test]
async fn export_inline_text_writes_payload_with_kind_extension() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let work = tempfile::tempdir().unwrap();
    let artifacts_dir = work.path().join("artifacts");
    fs::create_dir_all(&artifacts_dir).unwrap();
    let out_dir = work.path().join("exports");
    let conv = conversations::create(&pool, None).await.unwrap();

    let art = artifacts::create(&pool, &conv.id, "markdown", Some("Notes"), Some("msg-1"))
        .await
        .unwrap();
    artifacts::set_content(
        &pool,
        &artifacts_dir,
        &enc,
        &art.id,
        Some("text/markdown"),
        &ArtifactContent::Text {
            text: "# Hello\n\nworld".into(),
        },
    )
    .await
    .unwrap();

    let result = artifacts::export(&pool, &artifacts_dir, &enc, &art.id, &out_dir, false)
        .await
        .unwrap();

    assert!(
        result.exported_to.ends_with("Notes.md"),
        "exported_to = {}",
        result.exported_to
    );
    assert_eq!(result.bytes_written, "# Hello\n\nworld".len() as i64);
    let written = fs::read_to_string(&result.exported_to).unwrap();
    assert_eq!(written, "# Hello\n\nworld");
    // No sidecar without include_metadata.
    assert!(!result.exported_to.ends_with(".conduit.json"));
    assert_eq!(fs::read_dir(&out_dir).unwrap().count(), 1);
}

#[tokio::test]
async fn export_json_serializes_payload() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let work = tempfile::tempdir().unwrap();
    let artifacts_dir = work.path().join("artifacts");
    fs::create_dir_all(&artifacts_dir).unwrap();
    let out_dir = work.path().join("exports");
    let conv = conversations::create(&pool, None).await.unwrap();

    let art = artifacts::create(&pool, &conv.id, "json", Some("Config"), None)
        .await
        .unwrap();
    let payload = serde_json::json!({"v": 2, "nested": {"a": [1, 2]}});
    artifacts::set_content(
        &pool,
        &artifacts_dir,
        &enc,
        &art.id,
        Some("application/json"),
        &ArtifactContent::Json {
            json: payload.clone(),
        },
    )
    .await
    .unwrap();

    let result = artifacts::export(&pool, &artifacts_dir, &enc, &art.id, &out_dir, false)
        .await
        .unwrap();
    assert!(
        result.exported_to.ends_with("Config.json"),
        "exported_to = {}",
        result.exported_to
    );
    let written: Value =
        serde_json::from_str(&fs::read_to_string(&result.exported_to).unwrap()).unwrap();
    assert_eq!(written, payload);
}

#[tokio::test]
async fn export_file_content_uses_original_filename_and_decrypts() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let work = tempfile::tempdir().unwrap();
    let artifacts_dir = work.path().join("artifacts");
    fs::create_dir_all(&artifacts_dir).unwrap();
    let out_dir = work.path().join("exports");
    let conv = conversations::create(&pool, None).await.unwrap();

    let art = artifacts::create(&pool, &conv.id, "image", None, None)
        .await
        .unwrap();
    let payload = b"\x89PNG\r\n\x1a\n fake png bytes".to_vec();
    artifacts::set_content(
        &pool,
        &artifacts_dir,
        &enc,
        &art.id,
        Some("image/png"),
        &ArtifactContent::File {
            bytes: payload.clone(),
            filename: "render.png".into(),
        },
    )
    .await
    .unwrap();

    let result = artifacts::export(&pool, &artifacts_dir, &enc, &art.id, &out_dir, false)
        .await
        .unwrap();
    assert!(
        result.exported_to.ends_with("render.png"),
        "exported_to = {}",
        result.exported_to
    );
    let written = fs::read(&result.exported_to).unwrap();
    assert_eq!(written, payload);
}

#[tokio::test]
async fn export_with_metadata_writes_curated_sidecar() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let work = tempfile::tempdir().unwrap();
    let artifacts_dir = work.path().join("artifacts");
    fs::create_dir_all(&artifacts_dir).unwrap();
    let out_dir = work.path().join("exports");
    let conv = conversations::create(&pool, None).await.unwrap();

    let art = artifacts::create(&pool, &conv.id, "markdown", Some("Notes"), Some("msg-1"))
        .await
        .unwrap();
    artifacts::set_content(
        &pool,
        &artifacts_dir,
        &enc,
        &art.id,
        Some("text/markdown"),
        &ArtifactContent::Text {
            text: "body".into(),
        },
    )
    .await
    .unwrap();

    let result = artifacts::export(&pool, &artifacts_dir, &enc, &art.id, &out_dir, true)
        .await
        .unwrap();

    let sidecar_path = format!("{}.conduit.json", result.exported_to);
    let sidecar: Value = serde_json::from_str(&fs::read_to_string(&sidecar_path).unwrap()).unwrap();
    let obj = sidecar.as_object().unwrap();
    // Curated includes:
    assert_eq!(
        obj.get("artifactId").and_then(|v| v.as_str()),
        Some(art.id.as_str())
    );
    assert_eq!(obj.get("title").and_then(|v| v.as_str()), Some("Notes"));
    assert_eq!(obj.get("kind").and_then(|v| v.as_str()), Some("markdown"));
    assert_eq!(
        obj.get("mimeType").and_then(|v| v.as_str()),
        Some("text/markdown")
    );
    assert!(obj.get("contentHash").is_some());
    assert!(obj.get("sizeBytes").is_some());
    assert!(obj.get("createdAt").is_some());
    assert_eq!(
        obj.get("sourceMessageId").and_then(|v| v.as_str()),
        Some("msg-1")
    );
    // Excluded:
    assert!(
        !obj.contains_key("cloudShareId"),
        "sidecar must not include cloudShareId"
    );
    assert!(
        !obj.contains_key("encKeyVersion"),
        "sidecar must not include encKeyVersion"
    );
    assert!(
        !obj.contains_key("metadata"),
        "sidecar must not include freeform metadata"
    );

    // Two files in the export dir: the payload + the sidecar.
    assert_eq!(fs::read_dir(&out_dir).unwrap().count(), 2);
}

#[tokio::test]
async fn export_avoids_filename_collisions() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let work = tempfile::tempdir().unwrap();
    let artifacts_dir = work.path().join("artifacts");
    fs::create_dir_all(&artifacts_dir).unwrap();
    let out_dir = work.path().join("exports");
    let conv = conversations::create(&pool, None).await.unwrap();

    let art = artifacts::create(&pool, &conv.id, "markdown", Some("Notes"), None)
        .await
        .unwrap();
    artifacts::set_content(
        &pool,
        &artifacts_dir,
        &enc,
        &art.id,
        Some("text/markdown"),
        &ArtifactContent::Text {
            text: "first".into(),
        },
    )
    .await
    .unwrap();

    let r1 = artifacts::export(&pool, &artifacts_dir, &enc, &art.id, &out_dir, false)
        .await
        .unwrap();
    let r2 = artifacts::export(&pool, &artifacts_dir, &enc, &art.id, &out_dir, false)
        .await
        .unwrap();
    assert_ne!(r1.exported_to, r2.exported_to);
    assert!(
        r2.exported_to.ends_with("Notes-2.md"),
        "second export = {}",
        r2.exported_to
    );
    assert_eq!(fs::read_to_string(&r1.exported_to).unwrap(), "first");
    assert_eq!(fs::read_to_string(&r2.exported_to).unwrap(), "first");
}

#[tokio::test]
async fn export_errors_on_missing_artifact_and_missing_blob() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let work = tempfile::tempdir().unwrap();
    let artifacts_dir = work.path().join("artifacts");
    fs::create_dir_all(&artifacts_dir).unwrap();
    let out_dir = work.path().join("exports");

    // Unknown artifact id.
    let err = artifacts::export(
        &pool,
        &artifacts_dir,
        &enc,
        "no-such-artifact",
        &out_dir,
        false,
    )
    .await;
    assert!(err.is_err());

    // File-content artifact whose blob has been removed from disk.
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
            bytes: b"payload".to_vec(),
            filename: "x.png".into(),
        },
    )
    .await
    .unwrap();
    let blob =
        artifacts::resolve_artifact_path(&artifacts_dir, after.content_path.as_deref().unwrap());
    fs::remove_file(&blob).unwrap();

    let err = artifacts::export(&pool, &artifacts_dir, &enc, &art.id, &out_dir, false).await;
    assert!(err.is_err(), "exporting a missing-blob artifact must error");
}
