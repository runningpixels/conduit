mod common;

use conduit_desktop::{
    agent_tools::{self, AgentToolContext, EDIT_TEXT_TOOL, EXPORT_DOCUMENT_TOOL, WRITE_HTML_TOOL},
    db::repository::{artifacts, conversations},
};
use serde_json::json;

#[tokio::test]
async fn write_html_document_creates_artifact() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let artifacts_dir = tempfile::tempdir().unwrap();
    let exports_dir = tempfile::tempdir().unwrap();
    let conv = conversations::create(&pool, None).await.unwrap();
    let ctx = AgentToolContext {
        db: &pool,
        artifacts_dir: artifacts_dir.path(),
        exports_dir: exports_dir.path(),
        encryption: &enc,
        conversation_id: &conv.id,
        source_message_id: None,
    };

    let result = agent_tools::execute_builtin_tool(
        &ctx,
        "tool-call-1",
        "req-1",
        WRITE_HTML_TOOL,
        &json!({
          "title": "Landing Page",
          "html": "<!doctype html><html><body>Hello</body></html>"
        }),
    )
    .await
    .expect("tool runs");

    let artifact_id = result
        .output
        .get("artifact_id")
        .and_then(|v| v.as_str())
        .expect("artifact id");
    let artifact = artifacts::get(&pool, &enc, artifact_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(artifact.kind, "html");
    assert_eq!(artifact.mime_type.as_deref(), Some("text/html"));
    assert_eq!(
        artifact.content_text.as_deref(),
        Some("<!doctype html><html><body>Hello</body></html>")
    );
    assert_eq!(result.output.get("created"), Some(&json!(true)));
}

#[tokio::test]
async fn write_html_document_creates_when_artifact_id_unknown() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let artifacts_dir = tempfile::tempdir().unwrap();
    let exports_dir = tempfile::tempdir().unwrap();
    let conv = conversations::create(&pool, None).await.unwrap();
    let ctx = AgentToolContext {
        db: &pool,
        artifacts_dir: artifacts_dir.path(),
        exports_dir: exports_dir.path(),
        encryption: &enc,
        conversation_id: &conv.id,
        source_message_id: None,
    };

    let result = agent_tools::execute_builtin_tool(
        &ctx,
        "tool-call-slug",
        "req-slug",
        WRITE_HTML_TOOL,
        &json!({
          "artifact_id": "ancient_rome_history",
          "title": "History of Ancient Rome",
          "filename": "ancient-rome-history.html",
          "html": "<!doctype html><html><body>Rome</body></html>"
        }),
    )
    .await
    .expect("tool runs");

    assert!(!result.is_error);
    let artifact_id = result
        .output
        .get("artifact_id")
        .and_then(|v| v.as_str())
        .expect("artifact id");
    assert_ne!(artifact_id, "ancient_rome_history");
    assert_eq!(result.output.get("created"), Some(&json!(true)));
}

#[tokio::test]
async fn edit_text_document_updates_existing() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let artifacts_dir = tempfile::tempdir().unwrap();
    let exports_dir = tempfile::tempdir().unwrap();
    let conv = conversations::create(&pool, None).await.unwrap();
    let art = artifacts::create(&pool, &conv.id, "text", Some("Notes"), None)
        .await
        .unwrap();
    artifacts::set_content(
        &pool,
        artifacts_dir.path(),
        &enc,
        &art.id,
        Some("text/plain"),
        &artifacts::ArtifactContent::Text {
            text: "old".to_string(),
        },
    )
    .await
    .unwrap();

    let ctx = AgentToolContext {
        db: &pool,
        artifacts_dir: artifacts_dir.path(),
        exports_dir: exports_dir.path(),
        encryption: &enc,
        conversation_id: &conv.id,
        source_message_id: None,
    };
    let result = agent_tools::execute_builtin_tool(
        &ctx,
        "tool-call-2",
        "req-2",
        EDIT_TEXT_TOOL,
        &json!({
          "artifact_id": art.id,
          "updated_text": "new"
        }),
    )
    .await
    .expect("tool runs");

    let updated = artifacts::get(&pool, &enc, &art.id).await.unwrap().unwrap();
    assert_eq!(updated.content_text.as_deref(), Some("new"));
    assert_eq!(result.output.get("updated"), Some(&json!(true)));
}

#[tokio::test]
async fn export_document_writes_file() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let artifacts_dir = tempfile::tempdir().unwrap();
    let exports_dir = tempfile::tempdir().unwrap();
    let conv = conversations::create(&pool, None).await.unwrap();
    let art = artifacts::create(&pool, &conv.id, "text", Some("Notes"), None)
        .await
        .unwrap();
    artifacts::set_content(
        &pool,
        artifacts_dir.path(),
        &enc,
        &art.id,
        Some("text/plain"),
        &artifacts::ArtifactContent::Text {
            text: "export me".to_string(),
        },
    )
    .await
    .unwrap();

    let ctx = AgentToolContext {
        db: &pool,
        artifacts_dir: artifacts_dir.path(),
        exports_dir: exports_dir.path(),
        encryption: &enc,
        conversation_id: &conv.id,
        source_message_id: None,
    };
    let result = agent_tools::execute_builtin_tool(
        &ctx,
        "tool-call-3",
        "req-3",
        EXPORT_DOCUMENT_TOOL,
        &json!({
          "artifact_id": art.id,
          "include_metadata_sidecar": false
        }),
    )
    .await
    .expect("tool runs");

    let path = result
        .output
        .get("exported_path")
        .and_then(|v| v.as_str())
        .expect("export path");
    assert!(std::path::Path::new(path).exists());
}
