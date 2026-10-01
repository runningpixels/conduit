//! Per-app settings: the view, slot and cap validation, the stored-data
//! viewer, the export file and the storage rollup. Commands are driven through
//! their `_impl` bodies (`tauri::State` can't be built outside a running app).

#[path = "common/mod.rs"]
mod common;

use conduit_desktop::{
    commands::{
        export_app_data_impl, get_app_settings_impl, set_app_daily_token_cap_impl,
        set_app_model_slot_impl,
    },
    db::repository::{
        app_activity,
        apps::{self, AppMeta, DeclaredCapabilities},
        artifact_network::Principal,
        artifacts::{self, ArtifactContent},
        conversations, page_storage,
    },
    state::AppState,
    stream_manager::StreamManager,
};
use provider_core::schema::{AppActivityKind, AppCategory, AppLlmSlot, AppModelChoice};
use serde_json::json;

async fn state_with_app() -> (tempfile::TempDir, AppState, String) {
    let pool = common::setup_pool().await;
    let dir = tempfile::tempdir().unwrap();
    let paths = conduit_desktop::paths::resolve_in(dir.path()).unwrap();
    let enc = common::setup_encryption();
    let conv = conversations::create(&pool, None).await.unwrap();
    let art = artifacts::create(&pool, &conv.id, "html", Some("Weather"), None)
        .await
        .unwrap();
    artifacts::set_content(
        &pool,
        &paths.artifacts,
        &enc,
        &art.id,
        Some("text/html"),
        &ArtifactContent::Text {
            text: "<!doctype html><title>Weather</title>".to_string(),
        },
    )
    .await
    .unwrap();
    let app = apps::save_from_artifact(
        &pool,
        &paths.artifacts,
        &enc,
        &art.id,
        AppMeta {
            name: "Weather".to_string(),
            description: None,
            icon: None,
            category: AppCategory::LiveData,
        },
        Vec::new(),
        DeclaredCapabilities {
            storage: true,
            llm: true,
        },
        Vec::new(),
        &[],
    )
    .await
    .unwrap();
    let state = AppState::test_instance(pool, paths);
    (dir, state, app.id)
}

fn pick(provider: &str, model: &str) -> AppModelChoice {
    AppModelChoice {
        provider_id: provider.to_string(),
        model: model.to_string(),
    }
}

#[tokio::test]
async fn a_fresh_apps_settings_are_defaults_with_seven_zero_days() {
    let (_dir, state, id) = state_with_app().await;
    let view = get_app_settings_impl(&state, &id).await.unwrap();
    assert_eq!(view.slots.default, None);
    assert_eq!(view.slots.quick, None);
    assert_eq!(view.daily_token_cap, None);
    assert_eq!(view.default_daily_token_cap, 100_000);
    assert_eq!(view.cloud_tokens_today, 0);
    assert_eq!(view.usage.len(), 7);
    assert!(view
        .usage
        .iter()
        .all(|d| d.calls == 0 && d.input_tokens == 0));
    let days: Vec<_> = view.usage.iter().map(|d| d.day.clone()).collect();
    let mut sorted = days.clone();
    sorted.sort();
    assert_eq!(days, sorted, "oldest first");

    let err = get_app_settings_impl(&state, "nope").await.unwrap_err();
    assert!(err.starts_with("invalid:"), "{err}");
}

#[tokio::test]
async fn usage_shows_up_in_the_view() {
    let (_dir, state, id) = state_with_app().await;
    app_activity::record_model(
        &state.db,
        &Principal::app(&id),
        &app_activity::ModelCall {
            provider_id: Some("anthropic"),
            model: Some("m"),
            cloud: true,
            ok: true,
            input_tokens: Some(40),
            output_tokens: Some(2),
            error: None,
        },
    )
    .await;
    let view = get_app_settings_impl(&state, &id).await.unwrap();
    assert_eq!(view.cloud_tokens_today, 42);
    let today = view.usage.last().unwrap();
    assert_eq!(
        (today.input_tokens, today.output_tokens, today.calls),
        (40, 2, 1)
    );
}

#[tokio::test]
async fn setting_a_slot_validates_provider_and_model() {
    let (_dir, state, id) = state_with_app().await;
    let streams = StreamManager::new();
    let set = |slot, choice| set_app_model_slot_impl(&state, &streams, &id, slot, choice);

    let view = set(AppLlmSlot::Quick, Some(pick("ollama", "  llama3  ")))
        .await
        .unwrap();
    assert_eq!(view.slots.quick, Some(pick("ollama", "llama3")), "trimmed");
    assert_eq!(view.slots.default, None);

    let err = set(AppLlmSlot::Quick, Some(pick("no-such-provider", "m")))
        .await
        .unwrap_err();
    assert!(err.starts_with("invalid:"), "{err}");
    for model in ["", "   ", &"m".repeat(201)] {
        let err = set(AppLlmSlot::Default, Some(pick("ollama", model)))
            .await
            .unwrap_err();
        assert!(err.starts_with("invalid:"), "{err}");
    }
    assert!(
        set(AppLlmSlot::Default, Some(pick("ollama", &"m".repeat(200))))
            .await
            .is_ok()
    );

    let view = set(AppLlmSlot::Quick, None).await.unwrap();
    assert_eq!(view.slots.quick, None, "cleared back to following default");
    assert!(view.slots.default.is_some());

    let err = set_app_model_slot_impl(&state, &streams, "gone", AppLlmSlot::Quick, None)
        .await
        .unwrap_err();
    assert!(err.starts_with("invalid:"), "{err}");
}

#[tokio::test]
async fn the_daily_cap_is_bounded() {
    let (_dir, state, id) = state_with_app().await;
    for bad in [0, 999, 10_000_001] {
        let err = set_app_daily_token_cap_impl(&state, &id, Some(bad))
            .await
            .unwrap_err();
        assert!(err.starts_with("invalid:"), "{bad}: {err}");
    }
    for ok in [1_000, 10_000_000] {
        let view = set_app_daily_token_cap_impl(&state, &id, Some(ok))
            .await
            .unwrap();
        assert_eq!(view.daily_token_cap, Some(ok));
    }
    let view = set_app_daily_token_cap_impl(&state, &id, None)
        .await
        .unwrap();
    assert_eq!(view.daily_token_cap, None, "reset to default");
}

#[tokio::test]
async fn storage_entries_are_sorted_with_sizes_and_never_carry_values() {
    let (_dir, state, id) = state_with_app().await;
    let enc = common::setup_encryption();
    let p = Principal::app(&id);
    page_storage::set(&state.db, &enc, &p, "b", &json!("secret-value"))
        .await
        .unwrap();
    page_storage::set(&state.db, &enc, &p, "a", &json!(1))
        .await
        .unwrap();
    let entries = page_storage::entries(&state.db, &p).await.unwrap();
    let keys: Vec<_> = entries.iter().map(|e| e.key.as_str()).collect();
    assert_eq!(keys, ["a", "b"]);
    assert_eq!(entries[0].bytes, 1);
    assert_eq!(entries[1].bytes, "\"secret-value\"".len() as u64);
    assert!(!entries[0].updated_at.is_empty());
}

#[tokio::test]
async fn export_writes_pretty_json_and_cancelling_writes_nothing() {
    let (dir, state, id) = state_with_app().await;
    let enc = common::setup_encryption();
    let p = Principal::app(&id);
    page_storage::set(&state.db, &enc, &p, "city", &json!({"name": "Oslo"}))
        .await
        .unwrap();

    assert_eq!(export_app_data_impl(&state, &id, None).await.unwrap(), None);

    let target = dir.path().join("Weather-data.json");
    let saved = export_app_data_impl(&state, &id, Some(target.clone()))
        .await
        .unwrap();
    assert_eq!(saved.as_deref(), Some(target.to_string_lossy().as_ref()));
    let text = std::fs::read_to_string(&target).unwrap();
    assert!(text.contains("\n  \""), "pretty-printed");
    let doc: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(doc["app"]["id"], json!(id));
    assert_eq!(doc["app"]["name"], "Weather");
    assert_eq!(doc["app"]["version"], "1.0.0");
    assert!(doc["exportedAt"].as_str().is_some());
    assert!(doc["inputs"].is_object());
    assert_eq!(doc["storage"]["city"], json!({"name": "Oslo"}));
}

#[tokio::test]
async fn storage_writes_roll_up_and_deleting_the_app_removes_settings_and_activity() {
    let (_dir, state, id) = state_with_app().await;
    let p = Principal::app(&id);
    for _ in 0..4 {
        app_activity::record_storage_write(&state.db, &p).await;
    }
    app_activity::record_storage_write(&state.db, &Principal::artifact(&id)).await;
    set_app_daily_token_cap_impl(&state, &id, Some(5_000))
        .await
        .unwrap();
    let rows = app_activity::list(&state.db, &id, None).await.unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].kind, AppActivityKind::Storage);
    assert_eq!(rows[0].count, 4);

    apps::delete(&state.db, &id).await.unwrap();
    for table in ["app_settings", "app_activity"] {
        let (n,): (i64,) = sqlx::query_as(&format!("SELECT COUNT(*) FROM {table}"))
            .fetch_one(&state.db)
            .await
            .unwrap();
        assert_eq!(n, 0, "{table} is cascaded away");
    }
}
