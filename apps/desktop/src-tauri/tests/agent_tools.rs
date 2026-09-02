mod common;

use conduit_desktop::{
    agent_tools::{
        self, AgentToolContext, EDIT_TEXT_TOOL, EXPORT_DOCUMENT_TOOL, WRITE_BRAND_THEME_TOOL,
        WRITE_HTML_TOOL,
    },
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
        workspace: None,
        search: Default::default(),
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
        workspace: None,
        search: Default::default(),
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
        workspace: None,
        search: Default::default(),
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
        workspace: None,
        search: Default::default(),
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

// -------------------------------------------------------------------------
// write_brand_theme
// -------------------------------------------------------------------------
//
// Mirrors `crates/provider-core/src/brand.rs`'s `VALID_FIXTURE`, but built
// as camelCase JSON directly (the tool's wire shape) rather than TOML
// frontmatter, since this tool never touches `brand.md` -- see
// `write_brand_theme`'s doc comment in `agent_tools.rs`.

fn valid_dark_palette() -> serde_json::Value {
    json!({
        "bg": "#0F1115", "bgSide": "#0B0D11", "card": "#161A21", "cardHi": "#1D222B",
        "line": "#252B36", "lineSoft": "#1D222B", "lineHi": "#2E3542",
        "ink": "#E8EAED", "ink2": "#A8AEB8", "ink3": "#8790A0",
        "hue": "#E4572E", "hueText": "#FF8A61", "hueSolid": "#B8441F", "onHue": "#FFFFFF",
        "ok": "#3FB950", "warn": "#D29922", "err": "#F85149", "link": "#58A6FF"
    })
}

fn valid_light_palette() -> serde_json::Value {
    json!({
        "bg": "#FBFAF8", "bgSide": "#F3F1EC", "card": "#FFFFFF", "cardHi": "#F3F1EC",
        "line": "#E4E0D8", "lineSoft": "#EDEAE2", "lineHi": "#CFC9BC",
        "ink": "#1E1B16", "ink2": "#4A4438", "ink3": "#6E6656",
        "hue": "#B8441F", "hueText": "#9A3A1B", "hueSolid": "#B8441F", "onHue": "#FFFFFF",
        "ok": "#1A7F37", "warn": "#9A6700", "err": "#CF222E", "link": "#0969DA"
    })
}

/// A palette with only hex-valid but low-contrast colours: `ink`/`ink2`/`ink3`
/// sit right next to every surface, and `onHue` equals `hueSolid`. Every
/// value still passes the hex grammar, so this trips only
/// [`provider_core::brand::Severity::Warning`], never an error.
fn low_contrast_palette() -> serde_json::Value {
    json!({
        "bg": "#808080", "bgSide": "#808080", "card": "#808080", "cardHi": "#808080",
        "line": "#808080", "lineSoft": "#808080", "lineHi": "#808080",
        "ink": "#888888", "ink2": "#888888", "ink3": "#888888",
        "hue": "#E4572E", "hueText": "#FF8A61", "hueSolid": "#E4572E", "onHue": "#E4572E",
        "ok": "#3FB950", "warn": "#D29922", "err": "#F85149", "link": "#58A6FF"
    })
}

#[tokio::test]
async fn write_brand_theme_creates_parseable_artifact() {
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
        workspace: None,
        search: Default::default(),
    };

    let result = agent_tools::execute_builtin_tool(
        &ctx,
        "tool-call-brand-1",
        "req-brand-1",
        WRITE_BRAND_THEME_TOOL,
        &json!({
            "appName": "Northwind",
            "displayName": "Northwind AI",
            "tagline": "Message Northwind...",
            "notes": "Warm, editorial, low-contrast. Burnt orange accent.",
            "dark": valid_dark_palette(),
            "light": valid_light_palette(),
        }),
    )
    .await
    .expect("tool runs");

    assert!(!result.is_error, "unexpected error: {:?}", result.output);
    assert_eq!(result.output.get("ok"), Some(&json!(true)));
    assert_eq!(
        result.output.get("warnings"),
        Some(&json!([])),
        "a clean fixture should clear AA with no warnings"
    );

    let artifact_id = result
        .output
        .get("artifact_id")
        .and_then(|v| v.as_str())
        .expect("artifact id");
    let artifact = artifacts::get(&pool, &enc, artifact_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(artifact.kind, "markdown");
    assert_eq!(artifact.mime_type.as_deref(), Some("text/markdown"));

    let content = artifact.content_text.expect("markdown content");
    let (config, warnings) =
        provider_core::brand::parse(&content).expect("rendered brand.md round-trips through parse");
    assert_eq!(config.identity.app_name, "Northwind");
    assert_eq!(config.identity.display_name, "Northwind AI");
    assert!(warnings.is_empty());
    assert!(config.palette.is_some());
}

#[tokio::test]
async fn write_brand_theme_rejects_bad_hex_naming_the_field() {
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
        workspace: None,
        search: Default::default(),
    };

    let mut dark = valid_dark_palette();
    dark["bg"] = json!("not-a-hex-color");

    let result = agent_tools::execute_builtin_tool(
        &ctx,
        "tool-call-brand-2",
        "req-brand-2",
        WRITE_BRAND_THEME_TOOL,
        &json!({
            "appName": "Northwind",
            "displayName": "Northwind AI",
            "dark": dark,
            "light": valid_light_palette(),
        }),
    )
    .await
    .expect("tool runs (fails as a tool error, not a Rust error)");

    assert!(result.is_error);
    let message = result
        .output
        .get("error")
        .and_then(|v| v.as_str())
        .expect("error message");
    assert!(
        message.contains("palette.dark.bg"),
        "error should name the offending field: {message}"
    );
}

#[tokio::test]
async fn write_brand_theme_rejects_missing_light_palette() {
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
        workspace: None,
        search: Default::default(),
    };

    let result = agent_tools::execute_builtin_tool(
        &ctx,
        "tool-call-brand-3",
        "req-brand-3",
        WRITE_BRAND_THEME_TOOL,
        &json!({
            "appName": "Northwind",
            "displayName": "Northwind AI",
            "dark": valid_dark_palette(),
            // "light" omitted entirely.
        }),
    )
    .await;

    let err = result.expect_err("missing required `light` should fail argument parsing");
    assert!(
        err.contains("light"),
        "error should name the missing field: {err}"
    );
}

#[tokio::test]
async fn write_brand_theme_surfaces_contrast_warnings_without_failing() {
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
        workspace: None,
        search: Default::default(),
    };

    let result = agent_tools::execute_builtin_tool(
        &ctx,
        "tool-call-brand-4",
        "req-brand-4",
        WRITE_BRAND_THEME_TOOL,
        &json!({
            "appName": "Lowcon",
            "displayName": "Lowcon",
            "dark": low_contrast_palette(),
            "light": low_contrast_palette(),
        }),
    )
    .await
    .expect("tool runs");

    assert!(
        !result.is_error,
        "contrast issues are warnings, not errors: {:?}",
        result.output
    );
    assert_eq!(result.output.get("ok"), Some(&json!(true)));
    let warnings = result
        .output
        .get("warnings")
        .and_then(|v| v.as_array())
        .expect("warnings array");
    assert!(
        !warnings.is_empty(),
        "low-contrast palette should surface AA warnings"
    );
    assert!(result
        .output
        .get("artifact_id")
        .and_then(|v| v.as_str())
        .is_some());
}
