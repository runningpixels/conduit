//! t0-5: pin, archive, and one-level conversation folders.
mod common;

use conduit_desktop::db::repository::conversations;

#[tokio::test]
async fn pin_persists_and_does_not_bump_updated_at() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, Some("Pinned")).await.unwrap();
    let before = conversations::get(&pool, &conv.id)
        .await
        .unwrap()
        .unwrap()
        .updated_at;

    conversations::set_pinned(&pool, &conv.id, true)
        .await
        .unwrap();
    let listed = conversations::list(&pool).await.unwrap();
    assert!(listed[0].pinned_at.is_some());
    assert_eq!(listed[0].id, conv.id);

    let after = conversations::get(&pool, &conv.id)
        .await
        .unwrap()
        .unwrap()
        .updated_at;
    assert_eq!(before, after);

    conversations::set_pinned(&pool, &conv.id, false)
        .await
        .unwrap();
    let listed = conversations::list(&pool).await.unwrap();
    assert!(listed[0].pinned_at.is_none());
}

#[tokio::test]
async fn archive_and_restore() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, Some("Old")).await.unwrap();
    conversations::set_archived(&pool, &conv.id, true)
        .await
        .unwrap();
    let listed = conversations::list(&pool).await.unwrap();
    assert!(listed[0].archived_at.is_some());

    conversations::set_archived(&pool, &conv.id, false)
        .await
        .unwrap();
    let listed = conversations::list(&pool).await.unwrap();
    assert!(listed[0].archived_at.is_none());
}

#[tokio::test]
async fn pin_restores_an_archived_chat() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, Some("Both")).await.unwrap();
    conversations::set_archived(&pool, &conv.id, true)
        .await
        .unwrap();
    conversations::set_pinned(&pool, &conv.id, true)
        .await
        .unwrap();
    let listed = conversations::list(&pool).await.unwrap();
    assert!(listed[0].pinned_at.is_some());
    assert!(listed[0].archived_at.is_none());
}

#[tokio::test]
async fn folders_crud_and_move() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, Some("Filed")).await.unwrap();
    let folder = conversations::create_folder(&pool, "  Work  ")
        .await
        .unwrap();
    assert_eq!(folder.name, "Work");

    conversations::set_folder(&pool, &conv.id, Some(&folder.id))
        .await
        .unwrap();
    let listed = conversations::list(&pool).await.unwrap();
    assert_eq!(listed[0].folder_id.as_deref(), Some(folder.id.as_str()));
    assert_eq!(listed[0].folder_name.as_deref(), Some("Work"));

    let renamed = conversations::rename_folder(&pool, &folder.id, "Client A")
        .await
        .unwrap();
    assert_eq!(renamed.name, "Client A");
    let listed = conversations::list(&pool).await.unwrap();
    assert_eq!(listed[0].folder_name.as_deref(), Some("Client A"));

    conversations::delete_folder(&pool, &folder.id)
        .await
        .unwrap();
    let listed = conversations::list(&pool).await.unwrap();
    assert!(listed[0].folder_id.is_none());
    assert!(listed[0].folder_name.is_none());
    assert!(conversations::list_folders(&pool).await.unwrap().is_empty());
}

#[tokio::test]
async fn folder_names_are_unique_ignoring_case() {
    let pool = common::setup_pool().await;
    conversations::create_folder(&pool, "Work").await.unwrap();
    let err = conversations::create_folder(&pool, "work")
        .await
        .unwrap_err();
    assert!(err.to_string().contains("already exists"));
}

#[tokio::test]
async fn empty_folder_name_is_rejected() {
    let pool = common::setup_pool().await;
    let err = conversations::create_folder(&pool, "   ")
        .await
        .unwrap_err();
    assert!(err.to_string().contains("empty"));
}

#[tokio::test]
async fn missing_folder_id_is_an_error() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, Some("X")).await.unwrap();
    let err = conversations::set_folder(&pool, &conv.id, Some("no-such"))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("folder not found"));
}

#[tokio::test]
async fn filing_restores_an_archived_chat() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, Some("Archived"))
        .await
        .unwrap();
    let folder = conversations::create_folder(&pool, "Inbox").await.unwrap();
    conversations::set_archived(&pool, &conv.id, true)
        .await
        .unwrap();
    conversations::set_folder(&pool, &conv.id, Some(&folder.id))
        .await
        .unwrap();
    let listed = conversations::list(&pool).await.unwrap();
    assert!(listed[0].archived_at.is_none());
    assert_eq!(listed[0].folder_id.as_deref(), Some(folder.id.as_str()));
}

#[tokio::test]
async fn fork_inherits_folder_not_pin_or_archive() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, Some("Source")).await.unwrap();
    let folder = conversations::create_folder(&pool, "Project")
        .await
        .unwrap();
    conversations::set_folder(&pool, &conv.id, Some(&folder.id))
        .await
        .unwrap();
    conversations::set_pinned(&pool, &conv.id, true)
        .await
        .unwrap();

    use conduit_desktop::db::repository::messages;
    use provider_core::schema::{Message, MessagePart, MessagePartKind, MessageRole};

    let msg = Message {
        id: "m1".into(),
        conversation_id: conv.id.clone(),
        role: MessageRole::User,
        author_label: None,
        provider_message_id: None,
        request_id: None,
        interrupted_at: None,
        metadata: None,
        parts: vec![MessagePart {
            id: "m1-p0".into(),
            message_id: "m1".into(),
            index: 0,
            kind: MessagePartKind::Text,
            content: Some("hello".into()),
            mime_type: None,
            tool_call_id: None,
            artifact_id: None,
            attachment_id: None,
            blob_ref: None,
            metadata: None,
            created_at: "2026-09-02T00:00:00Z".into(),
        }],
        created_at: "2026-09-02T00:00:00Z".into(),
    };
    messages::insert_message(&pool, &msg).await.unwrap();

    let fork = conversations::fork_at(&pool, &conv.id, "m1", Some("Fork"))
        .await
        .unwrap();
    let listed = conversations::list(&pool).await.unwrap();
    let forked = listed.iter().find(|c| c.id == fork.id).unwrap();
    assert_eq!(forked.folder_id.as_deref(), Some(folder.id.as_str()));
    assert!(forked.pinned_at.is_none());
    assert!(forked.archived_at.is_none());
}
