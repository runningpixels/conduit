//! First-run examples: added once to a new profile, in its language, and
//! removable all at once.

mod common;

use std::path::Path;

use conduit_desktop::{
    db::repository::{artifact_network, conversations, workflows as repo},
    first_run_examples::{self as examples, SeedRequest},
    paths::AppPaths,
    state::AppState,
};
use serde_json::json;

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

/// The briefing starter's shape, enough for the seed (its inputs get the
/// language's defaults).
fn request(locale: &str) -> SeedRequest {
    SeedRequest {
        locale: locale.to_string(),
        theme_name: "ink".to_string(),
        theme_css: ".deck, .slide { --bg: #000; }".to_string(),
        briefing_definition: json!({
            "inputs": [
                { "id": "site_one", "label": "First site", "default": "https://news.ycombinator.com" },
                { "id": "site_two", "label": "Second site", "default": "https://www.theverge.com" },
                { "id": "interests", "label": "What I care about", "default": "x" },
                { "id": "language", "label": "Language", "default": "English" }
            ],
            "steps": [{ "id": "doc", "type": "template", "template": "{{inputs.language}}" }]
        }),
    }
}

async fn state() -> (AppState, tempfile::TempDir) {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    (AppState::test_instance(pool, test_paths(dir.path())), dir)
}

async fn count(state: &AppState, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(&state.db).await.unwrap()
}

#[tokio::test]
async fn a_new_profile_gets_the_examples_once_in_its_language() {
    let (state, _dir) = state().await;
    let outcome = examples::seed(&state, &request("ja")).await.unwrap();
    assert!(outcome.seeded);
    let kinds: Vec<&str> = outcome.items.iter().map(|i| i.kind.as_str()).collect();
    assert_eq!(kinds, ["app", "chat", "deck", "chat", "workflow"]);
    assert!(state.settings().unwrap().examples_seeded);

    // The app is World weather, named in Japanese, with its weather sites allowed.
    let app_id = &outcome.items[0].item_id;
    let (name, starter): (String, Option<String>) =
        sqlx::query_as("SELECT name, starter_id FROM apps WHERE id = ?")
            .bind(app_id)
            .fetch_one(&state.db)
            .await
            .unwrap();
    assert_eq!(starter.as_deref(), Some(examples::WEATHER_STARTER));
    assert_eq!(name, examples::content("ja").unwrap().weather.name);
    let grants = artifact_network::list(&state.db, Some(&artifact_network::Principal::app(app_id)))
        .await
        .unwrap();
    assert_eq!(grants.len(), 2, "{grants:?}");

    // Two chats in the sidebar, each with a question, an answer and its document.
    let chats = conversations::list(&state.db).await.unwrap();
    assert_eq!(chats.len(), 2);
    for chat in &chats {
        let messages: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE conversation_id = ?")
                .bind(&chat.id)
                .fetch_one(&state.db)
                .await
                .unwrap();
        assert_eq!(messages, 2);
        let documents: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM artifacts WHERE conversation_id = ? AND source_message_id IS NOT NULL",
        )
        .bind(&chat.id)
        .fetch_one(&state.db)
        .await
        .unwrap();
        assert_eq!(documents, 1);
    }

    // The deck has its eight slides, in the slides stage, with its chat.
    let deck = &outcome.items[2].item_id;
    assert_eq!(
        count(
            &state,
            &format!("SELECT COUNT(*) FROM deck_slides WHERE deck_id = '{deck}'")
        )
        .await,
        8
    );
    let stage: String = sqlx::query_scalar("SELECT stage FROM decks WHERE id = ?")
        .bind(deck)
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(stage, "slides");

    // The briefing: Japanese defaults, and one unread result dated when it ran.
    let workflow_id = &outcome.items[4].item_id;
    let workflow = repo::get(&state.db, &state.encryption, workflow_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(workflow.definition["inputs"][3]["default"], "日本語");
    let results = repo::list_results(&state.db, &state.encryption, None, true, 10)
        .await
        .unwrap();
    assert_eq!(results.len(), 1);
    let content = examples::content("ja").unwrap();
    assert_eq!(results[0].run.started_at, content.briefing.run_started_at);
    let outputs = results[0].run.outputs.as_ref().unwrap();
    assert_eq!(outputs[0].title, content.briefing.document_title);
    assert_eq!(repo::unread_result_count(&state.db).await.unwrap(), 1);

    // Only once.
    let again = examples::seed(&state, &request("ja")).await.unwrap();
    assert!(!again.seeded);
    assert_eq!(count(&state, "SELECT COUNT(*) FROM apps").await, 1);
    assert_eq!(examples::list(&state.db).await.unwrap().len(), 5);
}

#[tokio::test]
async fn a_profile_with_anything_in_it_gets_no_examples_and_never_will() {
    let (state, _dir) = state().await;
    conversations::create(&state.db, Some("Mine"))
        .await
        .unwrap();
    let outcome = examples::seed(&state, &request("en")).await.unwrap();
    assert!(!outcome.seeded);
    assert!(state.settings().unwrap().examples_seeded);
    // Even once the profile is empty again.
    sqlx::query("DELETE FROM conversations")
        .execute(&state.db)
        .await
        .unwrap();
    assert!(!examples::seed(&state, &request("en")).await.unwrap().seeded);
    assert_eq!(count(&state, "SELECT COUNT(*) FROM apps").await, 0);
}

#[tokio::test]
async fn removing_all_examples_leaves_nothing_behind() {
    let (state, dir) = state().await;
    let outcome = examples::seed(&state, &request("pt-BR")).await.unwrap();
    // One example deleted the usual way first.
    let chat = outcome.items.iter().find(|i| i.kind == "chat").unwrap();
    conversations::delete(&state.db, &chat.item_id)
        .await
        .unwrap();
    assert_eq!(examples::list(&state.db).await.unwrap().len(), 4);

    assert_eq!(examples::remove_all(&state).await.unwrap(), 4);
    for table in [
        "apps",
        "conversations",
        "decks",
        "deck_slides",
        "workflows",
        "workflow_runs",
        "messages",
        "artifacts",
        "principal_grants",
        "example_items",
    ] {
        assert_eq!(
            count(&state, &format!("SELECT COUNT(*) FROM {table}")).await,
            0,
            "{table}"
        );
    }
    // Saved document files are gone too.
    let artifacts_dir = dir.path().join("artifacts");
    let left = std::fs::read_dir(&artifacts_dir)
        .map(|entries| entries.count())
        .unwrap_or(0);
    assert_eq!(left, 0);
}
