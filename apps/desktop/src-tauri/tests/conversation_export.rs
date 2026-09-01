//! t0-4 conversation export: renderer + dialog `_impl` (no OS picker).
//!
//! The save dialog cannot be driven headlessly, so these tests hit
//! `prepare` / `export_to_path` and `export_conversation_dialog_impl` the
//! same way `tests/brand_dialog_commands.rs` covers brand export.

mod common;

use conduit_desktop::{
    commands::export_conversation_dialog_impl,
    conversation_export::{self, ExportFormat},
    db::repository::{conversations, messages},
    paths::AppPaths,
    state::AppState,
};
use provider_core::schema::{Message, MessagePart, MessagePartKind, MessageRole};
use std::{fs, path::Path};

fn test_paths(root: &Path) -> AppPaths {
    AppPaths {
        root: root.to_path_buf(),
        settings_file: root.join("settings.json"),
        database: root.join("conduit.sqlite"),
        attachments: root.join("attachments"),
        artifacts: root.join("artifacts"),
        logs: root.join("logs"),
        diagnostics: root.join("diagnostics"),
        updates: root.join("updates"),
        streams: root.join("streams"),
        connectors: root.join("connectors"),
        exports: root.join("exports"),
        branding: root.join("branding"),
    }
}

fn create_subdirs(paths: &AppPaths) {
    for sub in [
        &paths.attachments,
        &paths.artifacts,
        &paths.logs,
        &paths.diagnostics,
        &paths.updates,
        &paths.streams,
        &paths.connectors,
        &paths.exports,
        &paths.branding,
    ] {
        fs::create_dir_all(sub).unwrap();
    }
}

async fn state_at(root: &Path) -> AppState {
    let paths = test_paths(root);
    create_subdirs(&paths);
    AppState::load_with_paths(paths, "Conduit-test")
        .await
        .expect("load state")
}

fn text_message(
    conversation_id: &str,
    id: &str,
    role: MessageRole,
    content: &str,
    at: &str,
) -> Message {
    Message {
        id: id.to_string(),
        conversation_id: conversation_id.to_string(),
        role,
        author_label: None,
        provider_message_id: None,
        request_id: None,
        interrupted_at: None,
        metadata: None,
        parts: vec![MessagePart {
            id: format!("{id}-p0"),
            message_id: id.to_string(),
            index: 0,
            kind: MessagePartKind::Text,
            content: Some(content.to_string()),
            mime_type: None,
            tool_call_id: None,
            artifact_id: None,
            attachment_id: None,
            blob_ref: None,
            metadata: None,
            created_at: at.to_string(),
        }],
        created_at: at.to_string(),
    }
}

#[tokio::test]
async fn prepare_markdown_and_json_round_trip() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, Some("Export me"))
        .await
        .unwrap();
    messages::insert_message(
        &pool,
        &text_message(
            &conv.id,
            "u1",
            MessageRole::User,
            "Hello from me",
            "2026-08-31T00:00:00.000Z",
        ),
    )
    .await
    .unwrap();
    messages::insert_message(
        &pool,
        &text_message(
            &conv.id,
            "a1",
            MessageRole::Assistant,
            "token=supersecret",
            "2026-08-31T00:01:00.000Z",
        ),
    )
    .await
    .unwrap();
    messages::insert_message(
        &pool,
        &text_message(
            &conv.id,
            "s1",
            MessageRole::System,
            "hidden system prompt",
            "2026-08-31T00:00:00.000Z",
        ),
    )
    .await
    .unwrap();

    let md = conversation_export::preview(&pool, &conv.id, ExportFormat::Markdown)
        .await
        .unwrap();
    assert!(md.contains("# Export me"));
    assert!(md.contains("Hello from me"));
    assert!(!md.contains("supersecret"), "got {md}");
    assert!(!md.contains("hidden system prompt"), "got {md}");

    let json = conversation_export::preview(&pool, &conv.id, ExportFormat::Json)
        .await
        .unwrap();
    assert!(json.contains("\"schemaVersion\": 1"));
    assert!(!json.contains("supersecret"), "got {json}");
    assert!(!json.contains("hidden system prompt"), "got {json}");
}

#[tokio::test]
async fn empty_conversation_is_a_user_safe_error() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, Some("Empty")).await.unwrap();
    let err = conversation_export::preview(&pool, &conv.id, ExportFormat::Markdown)
        .await
        .unwrap_err();
    assert!(err.contains("nothing to export"), "got {err}");
}

#[tokio::test]
async fn missing_conversation_is_a_user_safe_error() {
    let pool = common::setup_pool().await;
    let err = conversation_export::preview(&pool, "no-such-id", ExportFormat::Json)
        .await
        .unwrap_err();
    assert!(err.contains("not found"), "got {err}");
}

#[tokio::test]
async fn dialog_impl_cancel_is_success() {
    let root = tempfile::tempdir().unwrap();
    let state = state_at(root.path()).await;
    let conv = conversations::create(&state.db, Some("Cancel me"))
        .await
        .unwrap();
    messages::insert_message(
        &state.db,
        &text_message(
            &conv.id,
            "u1",
            MessageRole::User,
            "hi",
            "2026-08-31T00:00:00.000Z",
        ),
    )
    .await
    .unwrap();

    let result =
        export_conversation_dialog_impl(&state, &conv.id, ExportFormat::Markdown, false, None)
            .await
            .unwrap();
    assert!(result.is_none());
}

#[tokio::test]
async fn dialog_impl_writes_the_file() {
    let root = tempfile::tempdir().unwrap();
    let state = state_at(root.path()).await;
    let conv = conversations::create(&state.db, Some("Write me"))
        .await
        .unwrap();
    messages::insert_message(
        &state.db,
        &text_message(
            &conv.id,
            "u1",
            MessageRole::User,
            "api_key=abcd1234",
            "2026-08-31T00:00:00.000Z",
        ),
    )
    .await
    .unwrap();

    let dest = root.path().join("exports").join("chat.json");
    let result = export_conversation_dialog_impl(
        &state,
        &conv.id,
        ExportFormat::Json,
        false,
        Some(dest.clone()),
    )
    .await
    .unwrap()
    .expect("export should write");

    assert_eq!(result.exported_to, dest.display().to_string());
    let body = fs::read_to_string(&dest).unwrap();
    assert!(body.contains("\"schemaVersion\": 1"));
    assert!(!body.contains("abcd1234"), "got {body}");
    assert!(result.bytes_written > 0);
}

#[tokio::test]
async fn export_to_path_markdown_matches_preview() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, Some("Match")).await.unwrap();
    messages::insert_message(
        &pool,
        &text_message(
            &conv.id,
            "u1",
            MessageRole::User,
            "ping",
            "2026-08-31T00:00:00.000Z",
        ),
    )
    .await
    .unwrap();
    let preview = conversation_export::preview(&pool, &conv.id, ExportFormat::Markdown)
        .await
        .unwrap();
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("match.md");
    let enc = common::setup_encryption();
    conversation_export::export_to_path(
        &pool,
        dir.path(),
        &enc,
        &conv.id,
        ExportFormat::Markdown,
        false,
        &dest,
    )
    .await
    .unwrap();
    let written = fs::read_to_string(&dest).unwrap();
    fn strip_exported_at(s: &str) -> String {
        s.lines()
            .filter(|line| !line.starts_with("_Exported from Conduit on"))
            .collect::<Vec<_>>()
            .join("\n")
    }
    assert_eq!(strip_exported_at(&written), strip_exported_at(&preview));
    assert!(written.contains("## You"));
    assert!(written.contains("ping"));
}
