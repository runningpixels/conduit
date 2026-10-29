//! Projects: a folder's settings, read from the chat's folder at send time.
mod common;

use conduit_desktop::db::repository::{conversations, knowledge, projects};
use conduit_desktop::encryption::{generate_key, Encryption};
use sqlx::SqlitePool;

async fn collection(pool: &SqlitePool, name: &str) -> String {
    knowledge::create_collection(
        pool,
        knowledge::NewCollection {
            name: name.into(),
            provider_id: "fake".into(),
            embedding_model: "fake-embed".into(),
            embedding_dimensions: 4,
        },
    )
    .await
    .unwrap()
    .id
}

#[tokio::test]
async fn a_chat_in_no_folder_has_no_project() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, Some("Loose")).await.unwrap();
    let project = projects::for_conversation(&pool, &Encryption::off(), &conv.id)
        .await
        .unwrap();
    assert!(project.is_none());
}

#[tokio::test]
async fn a_plain_folder_is_a_project_with_no_settings() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, Some("Chat")).await.unwrap();
    let folder = conversations::create_folder(&pool, "Ferry").await.unwrap();
    conversations::set_folder(&pool, &conv.id, Some(&folder.id))
        .await
        .unwrap();

    let project = projects::for_conversation(&pool, &Encryption::off(), &conv.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(project.name, "Ferry");
    assert_eq!(project.settings.folder_id, folder.id);
    assert_eq!(project.settings.user_instructions, None);
    assert!(project.settings.skill_ids.is_empty());
    assert!(project.settings.collection_ids.is_empty());
}

#[tokio::test]
async fn settings_round_trip_and_blank_values_clear() {
    let pool = common::setup_pool().await;
    let enc = Encryption::off();
    let folder = conversations::create_folder(&pool, "Ferry").await.unwrap();
    let docs = collection(&pool, "Ferry docs").await;

    projects::set_settings(
        &pool,
        &enc,
        &folder.id,
        Some("  Answer in British English. "),
        Some("C:/ferry"),
    )
    .await
    .unwrap();
    projects::set_skills(
        &pool,
        &folder.id,
        &["conduit:pdf".into(), "conduit:pdf".into(), " ".into()],
    )
    .await
    .unwrap();
    projects::set_collections(&pool, &folder.id, std::slice::from_ref(&docs))
        .await
        .unwrap();

    let got = projects::get_settings(&pool, &enc, &folder.id)
        .await
        .unwrap();
    assert_eq!(
        got.user_instructions.as_deref(),
        Some("Answer in British English.")
    );
    assert_eq!(got.workspace_root.as_deref(), Some("C:/ferry"));
    assert_eq!(got.skill_ids, vec!["conduit:pdf".to_string()]);
    assert_eq!(got.collection_ids, vec![docs]);

    projects::set_settings(&pool, &enc, &folder.id, Some("   "), None)
        .await
        .unwrap();
    let cleared = projects::get_settings(&pool, &enc, &folder.id)
        .await
        .unwrap();
    assert_eq!(cleared.user_instructions, None);
    assert_eq!(cleared.workspace_root, None);
}

#[tokio::test]
async fn instructions_are_encrypted_at_rest() {
    let pool = common::setup_pool().await;
    let enc = Encryption::on_with_key(generate_key(), 1);
    let folder = conversations::create_folder(&pool, "Secret").await.unwrap();
    projects::set_settings(
        &pool,
        &enc,
        &folder.id,
        Some("The launch is on Friday."),
        None,
    )
    .await
    .unwrap();

    let (stored,): (String,) =
        sqlx::query_as("SELECT user_instructions FROM project_settings WHERE folder_id = ?")
            .bind(&folder.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(!stored.contains("Friday"));
    let got = projects::get_settings(&pool, &enc, &folder.id)
        .await
        .unwrap();
    assert_eq!(
        got.user_instructions.as_deref(),
        Some("The launch is on Friday.")
    );
}

#[tokio::test]
async fn setters_refuse_an_unknown_folder_or_a_bad_skill_id() {
    let pool = common::setup_pool().await;
    let enc = Encryption::off();
    assert!(projects::set_settings(&pool, &enc, "nope", Some("x"), None)
        .await
        .is_err());
    let folder = conversations::create_folder(&pool, "Ferry").await.unwrap();
    assert!(
        projects::set_skills(&pool, &folder.id, &["not a skill id".into()])
            .await
            .is_err()
    );
    assert!(
        projects::set_collections(&pool, &folder.id, &["missing-collection".into()])
            .await
            .is_err()
    );
}

#[tokio::test]
async fn deleting_the_folder_deletes_its_settings() {
    let pool = common::setup_pool().await;
    let enc = Encryption::off();
    let folder = conversations::create_folder(&pool, "Ferry").await.unwrap();
    let docs = collection(&pool, "Ferry docs").await;
    projects::set_settings(&pool, &enc, &folder.id, Some("x"), None)
        .await
        .unwrap();
    projects::set_skills(&pool, &folder.id, &["conduit:pdf".into()])
        .await
        .unwrap();
    projects::set_collections(&pool, &folder.id, &[docs])
        .await
        .unwrap();

    conversations::delete_folder(&pool, &folder.id)
        .await
        .unwrap();

    for table in ["project_settings", "project_skills", "project_collections"] {
        let (n,): (i64,) = sqlx::query_as(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(n, 0, "{table} kept rows of a deleted folder");
    }
}

#[tokio::test]
async fn a_chat_searches_its_own_collections_then_its_projects() {
    let pool = common::setup_pool().await;
    let conv = conversations::create(&pool, Some("Chat")).await.unwrap();
    let folder = conversations::create_folder(&pool, "Ferry").await.unwrap();
    let own = collection(&pool, "Own").await;
    let shared = collection(&pool, "Shared").await;
    knowledge::set_enabled(&pool, &conv.id, std::slice::from_ref(&own))
        .await
        .unwrap();
    projects::set_collections(&pool, &folder.id, &[shared.clone(), own.clone()])
        .await
        .unwrap();

    // Not in the folder yet: only its own.
    assert_eq!(
        projects::effective_collections(&pool, &conv.id)
            .await
            .unwrap(),
        vec![own.clone()]
    );

    conversations::set_folder(&pool, &conv.id, Some(&folder.id))
        .await
        .unwrap();
    assert_eq!(
        projects::effective_collections(&pool, &conv.id)
            .await
            .unwrap(),
        vec![own.clone(), shared]
    );

    // Moving it out takes the project's away again.
    conversations::set_folder(&pool, &conv.id, None)
        .await
        .unwrap();
    assert_eq!(
        projects::effective_collections(&pool, &conv.id)
            .await
            .unwrap(),
        vec![own]
    );
}
