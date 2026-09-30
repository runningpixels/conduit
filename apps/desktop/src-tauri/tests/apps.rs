//! Saved mini-apps (Apps phase 1): an app is a copy that outlives its chat,
//! and network grants carry over only when the user chose them.

#[path = "common/mod.rs"]
mod common;

use conduit_desktop::db::repository::{
    app_inputs,
    apps::{self, AppMeta},
    artifact_network::{self as grants, Principal},
    artifacts::{self, ArtifactContent},
    conversations, page_storage,
};
use conduit_desktop::starter_apps;
use provider_core::schema::{AppCategory, AppInput, AppInputKind, AppOrigin};
use serde_json::{json, Map};

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
        false,
        vec![],
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
        false,
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
        false,
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
    let app = apps::save_from_artifact(
        &pool,
        dir.path(),
        &enc,
        &art,
        meta("W"),
        vec![],
        false,
        vec![],
        &[],
    )
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
        false,
        vec![],
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
    let app = apps::save_from_artifact(
        &pool,
        dir.path(),
        &enc,
        &art,
        meta("W"),
        vec![],
        false,
        vec![],
        &[],
    )
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

#[tokio::test]
async fn saving_a_page_that_declares_storage_copies_it_and_the_app_keeps_it_after_the_chat_is_deleted(
) {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let art = html_artifact(&pool, dir.path(), &conv.id, PAGE_V1).await;
    let page = Principal::artifact(&art);
    page_storage::set(&pool, &enc, &page, "count", &serde_json::json!(1))
        .await
        .unwrap();

    let app = apps::save_from_artifact(
        &pool,
        dir.path(),
        &enc,
        &art,
        meta("Tracker"),
        vec![],
        true,
        vec![],
        &[],
    )
    .await
    .unwrap();
    assert!(app.storage, "the manifest declares storage");

    let app_p = Principal::app(&app.id);
    assert_eq!(
        page_storage::get(&pool, &enc, &app_p, "count")
            .await
            .unwrap(),
        Some(serde_json::json!(1)),
        "the app's storage starts as a copy of the page's"
    );

    conversations::delete(&pool, &conv.id).await.unwrap();
    assert_eq!(
        page_storage::get(&pool, &enc, &app_p, "count")
            .await
            .unwrap(),
        Some(serde_json::json!(1)),
        "the app's storage survives the chat"
    );
    assert_eq!(
        page_storage::get(&pool, &enc, &page, "count")
            .await
            .unwrap(),
        None,
        "the artifact's storage went with the chat (the 0027 trigger)"
    );
}

#[tokio::test]
async fn a_page_that_does_not_declare_storage_copies_nothing() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let art = html_artifact(&pool, dir.path(), &conv.id, PAGE_V1).await;
    let page = Principal::artifact(&art);
    page_storage::set(&pool, &enc, &page, "count", &serde_json::json!(1))
        .await
        .unwrap();

    let app = apps::save_from_artifact(
        &pool,
        dir.path(),
        &enc,
        &art,
        meta("Tracker"),
        vec![],
        false,
        vec![],
        &[],
    )
    .await
    .unwrap();
    assert!(!app.storage, "the manifest doesn't declare storage");
    assert_eq!(
        page_storage::usage(&pool, &Principal::app(&app.id))
            .await
            .unwrap()
            .keys,
        0,
        "nothing was copied"
    );
}

#[tokio::test]
async fn deleting_an_app_deletes_its_storage() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let art = html_artifact(&pool, dir.path(), &conv.id, PAGE_V1).await;
    let app = apps::save_from_artifact(
        &pool,
        dir.path(),
        &enc,
        &art,
        meta("W"),
        vec![],
        true,
        vec![],
        &[],
    )
    .await
    .unwrap();
    let app_p = Principal::app(&app.id);
    page_storage::set(&pool, &enc, &app_p, "k", &serde_json::json!(1))
        .await
        .unwrap();

    apps::delete(&pool, &app.id).await.unwrap();
    assert_eq!(page_storage::usage(&pool, &app_p).await.unwrap().keys, 0);
}

#[tokio::test]
async fn deleting_an_artifact_deletes_its_storage() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let art = html_artifact(&pool, dir.path(), &conv.id, PAGE_V1).await;
    let page = Principal::artifact(&art);
    page_storage::set(&pool, &enc, &page, "k", &serde_json::json!(1))
        .await
        .unwrap();

    sqlx::query("DELETE FROM artifacts WHERE id = ?")
        .bind(&art)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        page_storage::usage(&pool, &page).await.unwrap().keys,
        0,
        "the trigger clears the artifact's storage"
    );
}

#[test]
fn an_unknown_declared_capability_is_refused() {
    assert!(apps::validate_capabilities(&["storage".to_string()]).unwrap());
    assert!(!apps::validate_capabilities(&[]).unwrap());
    let err = apps::validate_capabilities(&["flux-capacitor".to_string()]).unwrap_err();
    assert!(err.starts_with("invalid:"), "{err}");
}

// ── Launch inputs (ADR-013) ─────────────────────────────────────────────────

fn city_input() -> AppInput {
    AppInput {
        id: "city".to_string(),
        label: "City".to_string(),
        kind: AppInputKind::String,
        required: true,
        default: Some(json!("Paris")),
        options: None,
    }
}

fn units_input() -> AppInput {
    AppInput {
        id: "units".to_string(),
        label: "Units".to_string(),
        kind: AppInputKind::Enum,
        required: false,
        default: Some(json!("metric")),
        options: Some(vec!["metric".to_string(), "imperial".to_string()]),
    }
}

/// A required input with no default, so `inputs_missing` starts `true`.
fn note_input() -> AppInput {
    AppInput {
        id: "note".to_string(),
        label: "Note".to_string(),
        kind: AppInputKind::String,
        required: true,
        default: None,
        options: None,
    }
}

async fn save_with_inputs(
    pool: &sqlx::SqlitePool,
    dir: &std::path::Path,
    enc: &conduit_desktop::encryption::Encryption,
    conv: &str,
    inputs: Vec<AppInput>,
) -> provider_core::schema::AppSummary {
    let art = html_artifact(pool, dir, conv, PAGE_V1).await;
    apps::save_from_artifact(
        pool,
        dir,
        enc,
        &art,
        meta("Weather"),
        vec![],
        false,
        inputs,
        &[],
    )
    .await
    .unwrap()
}

#[tokio::test]
async fn saving_with_declared_inputs_then_get_app_inputs_returns_the_defaults() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let app = save_with_inputs(
        &pool,
        dir.path(),
        &enc,
        &conv.id,
        vec![city_input(), units_input()],
    )
    .await;
    assert_eq!(app.inputs.len(), 2);
    assert!(!app.inputs_missing, "both inputs have defaults");

    let values = app_inputs::get_values(&pool, &enc, &app.id, &app.inputs)
        .await
        .unwrap();
    assert_eq!(values.get("city"), Some(&json!("Paris")));
    assert_eq!(values.get("units"), Some(&json!("metric")));
}

#[tokio::test]
async fn set_app_inputs_accepts_valid_rejects_invalid_and_undeclared() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let app = save_with_inputs(
        &pool,
        dir.path(),
        &enc,
        &conv.id,
        vec![city_input(), units_input()],
    )
    .await;

    // A valid value for a declared input.
    let mut valid = Map::new();
    valid.insert("city".to_string(), json!("Lisbon"));
    let values = app_inputs::set_values(&pool, &enc, &app.id, &app.inputs, valid)
        .await
        .unwrap();
    assert_eq!(values.get("city"), Some(&json!("Lisbon")));

    // An invalid value for a declared input (not one of the enum's options).
    let mut invalid = Map::new();
    invalid.insert("units".to_string(), json!("kelvin"));
    let err = app_inputs::set_values(&pool, &enc, &app.id, &app.inputs, invalid)
        .await
        .unwrap_err();
    assert!(err.to_string().starts_with("invalid:"), "{err}");

    // An id that isn't declared at all.
    let mut undeclared = Map::new();
    undeclared.insert("bogus".to_string(), json!("x"));
    let err = app_inputs::set_values(&pool, &enc, &app.id, &app.inputs, undeclared)
        .await
        .unwrap_err();
    assert!(err.to_string().starts_with("invalid:"), "{err}");

    // Neither refused write changed the stored value.
    let values = app_inputs::get_values(&pool, &enc, &app.id, &app.inputs)
        .await
        .unwrap();
    assert_eq!(values.get("city"), Some(&json!("Lisbon")));
}

#[tokio::test]
async fn a_null_value_clears_an_input_back_to_its_default() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let app = save_with_inputs(&pool, dir.path(), &enc, &conv.id, vec![city_input()]).await;

    let mut edit = Map::new();
    edit.insert("city".to_string(), json!("Lisbon"));
    app_inputs::set_values(&pool, &enc, &app.id, &app.inputs, edit)
        .await
        .unwrap();

    let mut clear = Map::new();
    clear.insert("city".to_string(), serde_json::Value::Null);
    let values = app_inputs::set_values(&pool, &enc, &app.id, &app.inputs, clear)
        .await
        .unwrap();
    assert_eq!(
        values.get("city"),
        Some(&json!("Paris")),
        "back to the default"
    );
}

#[tokio::test]
async fn updating_from_source_drops_removed_inputs_and_keeps_the_rest() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let art = html_artifact(&pool, dir.path(), &conv.id, PAGE_V1).await;
    let app = apps::save_from_artifact(
        &pool,
        dir.path(),
        &enc,
        &art,
        meta("Weather"),
        vec![],
        false,
        vec![city_input(), units_input()],
        &[],
    )
    .await
    .unwrap();

    let mut edits = Map::new();
    edits.insert("city".to_string(), json!("Lisbon"));
    edits.insert("units".to_string(), json!("imperial"));
    app_inputs::set_values(&pool, &enc, &app.id, &app.inputs, edits)
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

    // The updated page only declares `city`; `units` is dropped.
    let updated = apps::update_from_artifact(
        &pool,
        dir.path(),
        &enc,
        &app.id,
        vec![],
        false,
        vec![city_input()],
    )
    .await
    .unwrap();
    assert_eq!(updated.inputs.len(), 1);

    let values = app_inputs::get_values(&pool, &enc, &app.id, &updated.inputs)
        .await
        .unwrap();
    assert_eq!(values.get("city"), Some(&json!("Lisbon")), "kept");
    assert_eq!(values.get("units"), None, "no longer declared, so dropped");
}

#[tokio::test]
async fn deleting_the_app_deletes_its_input_values() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let app = save_with_inputs(&pool, dir.path(), &enc, &conv.id, vec![city_input()]).await;

    let mut edit = Map::new();
    edit.insert("city".to_string(), json!("Lisbon"));
    app_inputs::set_values(&pool, &enc, &app.id, &app.inputs, edit)
        .await
        .unwrap();

    apps::delete(&pool, &app.id).await.unwrap();

    let (count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM app_inputs WHERE app_id = ?")
        .bind(&app.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0, "the app's stored input values are gone");
}

#[tokio::test]
async fn inputs_missing_is_true_until_a_required_input_with_no_default_is_set() {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let app = save_with_inputs(&pool, dir.path(), &enc, &conv.id, vec![note_input()]).await;
    assert!(
        app.inputs_missing,
        "a required input with no default and no value is missing"
    );

    let mut edit = Map::new();
    edit.insert("note".to_string(), json!("Remember the milk"));
    app_inputs::set_values(&pool, &enc, &app.id, &app.inputs, edit)
        .await
        .unwrap();

    let refetched = apps::get_summary(&pool, &enc, &app.id)
        .await
        .unwrap()
        .unwrap();
    assert!(!refetched.inputs_missing, "a value has now been set");
}
