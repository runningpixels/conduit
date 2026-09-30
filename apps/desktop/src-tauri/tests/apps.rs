//! Saved mini-apps (Apps phase 1): an app is a copy that outlives its chat,
//! and network grants carry over only when the user chose them.

#[path = "common/mod.rs"]
mod common;

use conduit_desktop::db::repository::{
    apps::{self, AppMeta},
    artifact_network::{self as grants, Principal},
    artifacts::{self, ArtifactContent},
    conversations,
};
use conduit_desktop::starter_apps;
use provider_core::schema::{AppCategory, AppOrigin};

const PAGE_V1: &str = "<!doctype html><title>Weather</title><p>v1</p>";
const PAGE_V2: &str = "<!doctype html><title>Weather</title><p>v2</p>";

fn meta(name: &str) -> AppMeta {
    AppMeta {
        name: name.to_string(),
        description: Some("Seven days for one city".to_string()),
        icon: Some("☀️".to_string()),
        category: AppCategory::LiveData,
    }
}

async fn html_artifact(
    pool: &sqlx::SqlitePool,
    dir: &std::path::Path,
    conv: &str,
    html: &str,
) -> String {
    let enc = common::setup_encryption();
    let art = artifacts::create(pool, conv, "html", Some("Weather"), None)
        .await
        .unwrap();
    artifacts::set_content(
        pool,
        dir,
        &enc,
        &art.id,
        Some("text/html"),
        &ArtifactContent::Text {
            text: html.to_string(),
        },
    )
    .await
    .unwrap();
    art.id
}

#[tokio::test]
async fn an_app_outlives_its_chat_and_keeps_only_the_grants_the_user_chose() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let art = html_artifact(&pool, dir.path(), &conv.id, PAGE_V1).await;
    let page = Principal::artifact(&art);
    grants::grant(&pool, &page, "https://api.open-meteo.com")
        .await
        .unwrap();
    grants::grant(&pool, &page, "https://api.github.com")
        .await
        .unwrap();

    let app = apps::save_from_artifact(
        &pool,
        dir.path(),
        &enc,
        &art,
        meta("Weather"),
        vec!["https://geocoding-api.open-meteo.com".to_string()],
        &["https://api.open-meteo.com".to_string()],
    )
    .await
    .unwrap();
    assert_eq!(app.version, "1.0.0");
    assert_eq!(app.source_artifact_id.as_deref(), Some(art.as_str()));
    assert!(!app.source_changed);
    assert_eq!(
        app.hosts,
        vec![
            "https://api.open-meteo.com".to_string(),
            "https://geocoding-api.open-meteo.com".to_string()
        ],
        "declared hosts plus the kept grant; the grant not kept is not declared"
    );

    let app_p = Principal::app(&app.id);
    let app_grants: Vec<String> = grants::list(&pool, Some(&app_p))
        .await
        .unwrap()
        .into_iter()
        .map(|g| g.host)
        .collect();
    assert_eq!(app_grants, vec!["https://api.open-meteo.com".to_string()]);
    let listed = grants::list(&pool, None).await.unwrap();
    assert!(listed
        .iter()
        .any(|g| g.kind == "app" && g.title.as_deref() == Some("Weather")));

    conversations::delete(&pool, &conv.id).await.unwrap();

    let opened = apps::open(&pool, &enc, &app.id).await.unwrap().unwrap();
    assert_eq!(opened.html, PAGE_V1, "the app is a copy, not a link");
    assert!(opened.summary.last_opened_at.is_some());
    assert!(
        !opened.summary.source_changed,
        "a deleted source is not a change"
    );
    assert!(
        grants::is_granted(&pool, &app_p, "https://api.open-meteo.com")
            .await
            .unwrap(),
        "the app's grant survives the chat"
    );
    assert!(
        !grants::is_granted(&pool, &page, "https://api.open-meteo.com")
            .await
            .unwrap(),
        "the artifact's grants went with the chat"
    );
}

#[tokio::test]
async fn keeping_a_host_the_page_was_never_granted_is_refused() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let art = html_artifact(&pool, dir.path(), &conv.id, PAGE_V1).await;

    let refused = apps::save_from_artifact(
        &pool,
        dir.path(),
        &enc,
        &art,
        meta("Weather"),
        vec![],
        &["https://evil.example".to_string()],
    )
    .await;
    assert!(refused.is_err());
    assert!(apps::list(&pool, &enc).await.unwrap().is_empty());
}

#[tokio::test]
async fn only_html_pages_become_apps() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let notes = artifacts::create(&pool, &conv.id, "markdown", Some("Notes"), None)
        .await
        .unwrap();
    artifacts::set_content(
        &pool,
        dir.path(),
        &enc,
        &notes.id,
        Some("text/markdown"),
        &ArtifactContent::Text {
            text: "# Notes".to_string(),
        },
    )
    .await
    .unwrap();
    assert!(apps::save_from_artifact(
        &pool,
        dir.path(),
        &enc,
        &notes.id,
        meta("Notes"),
        vec![],
        &[]
    )
    .await
    .is_err());
}

#[tokio::test]
async fn a_changed_source_offers_an_update_that_bumps_the_version() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let art = html_artifact(&pool, dir.path(), &conv.id, PAGE_V1).await;
    let app = apps::save_from_artifact(&pool, dir.path(), &enc, &art, meta("W"), vec![], &[])
        .await
        .unwrap();
    grants::grant(
        &pool,
        &Principal::app(&app.id),
        "https://api.open-meteo.com",
    )
    .await
    .unwrap();

    artifacts::set_content(
        &pool,
        dir.path(),
        &enc,
        &art,
        Some("text/html"),
        &ArtifactContent::Text {
            text: PAGE_V2.to_string(),
        },
    )
    .await
    .unwrap();
    let listed = apps::list(&pool, &enc).await.unwrap();
    assert!(listed[0].source_changed);

    let updated = apps::update_from_artifact(
        &pool,
        dir.path(),
        &enc,
        &app.id,
        vec!["https://api.github.com".to_string()],
    )
    .await
    .unwrap();
    assert_eq!(updated.version, "1.1.0");
    assert!(!updated.source_changed);
    assert_eq!(
        updated.hosts,
        vec![
            "https://api.github.com".to_string(),
            "https://api.open-meteo.com".to_string()
        ]
    );
    assert!(
        !grants::is_granted(&pool, &Principal::app(&app.id), "https://api.github.com")
            .await
            .unwrap(),
        "a newly declared host is not granted by an update"
    );
    let opened = apps::open(&pool, &enc, &app.id).await.unwrap().unwrap();
    assert_eq!(opened.html, PAGE_V2);
}

#[tokio::test]
async fn editing_and_deleting_an_app() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let art = html_artifact(&pool, dir.path(), &conv.id, PAGE_V1).await;
    let app = apps::save_from_artifact(&pool, dir.path(), &enc, &art, meta("W"), vec![], &[])
        .await
        .unwrap();
    grants::grant(
        &pool,
        &Principal::app(&app.id),
        "https://api.open-meteo.com",
    )
    .await
    .unwrap();

    let renamed = apps::update_meta(
        &pool,
        &enc,
        &app.id,
        AppMeta {
            name: "Lisbon weather".to_string(),
            description: None,
            icon: Some("🌤".to_string()),
            category: AppCategory::Tools,
        },
    )
    .await
    .unwrap();
    assert_eq!(renamed.name, "Lisbon weather");
    assert_eq!(renamed.category, AppCategory::Tools);
    assert_eq!(
        renamed.version, "1.0.0",
        "editing details isn't a new version"
    );

    apps::delete(&pool, &app.id).await.unwrap();
    assert!(apps::list(&pool, &enc).await.unwrap().is_empty());
    assert!(
        grants::list(&pool, None).await.unwrap().is_empty(),
        "deleting an app deletes its grants"
    );
}

#[tokio::test]
async fn a_starter_app_is_added_once_and_granted_nothing() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let starter = starter_apps::find("weather-dashboard").unwrap();
    let first = apps::install_starter(&pool, &enc, starter, meta("Weather dashboard"))
        .await
        .unwrap();
    assert_eq!(first.origin, AppOrigin::Starter);
    assert_eq!(first.starter_id.as_deref(), Some("weather-dashboard"));
    assert_eq!(first.source_artifact_id, None);
    assert!(!first.source_changed);
    assert_eq!(
        first.hosts,
        vec![
            "https://api.open-meteo.com".to_string(),
            "https://geocoding-api.open-meteo.com".to_string()
        ]
    );
    let again = apps::install_starter(&pool, &enc, starter, meta("Weather dashboard"))
        .await
        .unwrap();
    assert_eq!(again.id, first.id, "adding it twice opens the same copy");
    assert_eq!(apps::list(&pool, &enc).await.unwrap().len(), 1);
    assert!(
        grants::list(&pool, None).await.unwrap().is_empty(),
        "a starter's sites still ask on first use"
    );
    let opened = apps::open(&pool, &enc, &first.id).await.unwrap().unwrap();
    assert_eq!(opened.html, starter.html);
    assert_eq!(
        apps::installed_starters(&pool)
            .await
            .unwrap()
            .get("weather-dashboard"),
        Some(&first.id)
    );
}

#[tokio::test]
async fn an_added_starter_follows_the_page_this_build_ships() {
    let pool = common::setup_pool().await;
    let enc = common::setup_encryption();
    let starter = starter_apps::find("snake").unwrap();
    let app = apps::install_starter(&pool, &enc, starter, meta("Snake"))
        .await
        .unwrap();
    // As if it had been added from an older build's page.
    sqlx::query("UPDATE apps SET payload = '<p>old</p>', content_hash = 'old' WHERE id = ?")
        .bind(&app.id)
        .execute(&pool)
        .await
        .unwrap();
    let opened = apps::open(&pool, &enc, &app.id).await.unwrap().unwrap();
    assert_eq!(opened.html, starter.html);
    assert_eq!(opened.summary.version, "1.1.0");
    let again = apps::open(&pool, &enc, &app.id).await.unwrap().unwrap();
    assert_eq!(
        again.summary.version, "1.1.0",
        "an up-to-date copy is left alone"
    );
}
