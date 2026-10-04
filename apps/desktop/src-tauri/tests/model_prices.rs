//! Model price resolution through `AppState`: user overrides (validated and
//! persisted through `update_settings`), prices a provider reported in its model
//! listing, and the bundled snapshot underneath both.

use conduit_desktop::{paths::AppPaths, state::AppState};
use provider_core::schema::{
    ModelInfo, ModelPrice, ModelPriceOverride, PriceSource, SettingsPatch,
};
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

async fn state_at(root: &Path) -> AppState {
    let paths = test_paths(root);
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
    AppState::load_with_paths(paths, "Conduit-test")
        .await
        .expect("load state")
}

fn price(input: f64, output: f64) -> ModelPrice {
    ModelPrice {
        input_per_mtok: input,
        output_per_mtok: output,
        cache_read_per_mtok: None,
        cache_write_per_mtok: None,
    }
}

fn overrides(entries: Vec<ModelPriceOverride>) -> SettingsPatch {
    let mut patch: SettingsPatch = serde_json::from_str("{}").expect("an empty patch deserializes");
    patch.model_price_overrides = Some(entries);
    patch
}

fn entry(provider: &str, model: &str, p: ModelPrice) -> ModelPriceOverride {
    ModelPriceOverride {
        provider_id: provider.into(),
        model_id: model.into(),
        price: p,
    }
}

#[tokio::test]
async fn an_override_prices_a_custom_endpoint_and_survives_a_restart() {
    let root = tempfile::tempdir().unwrap();
    let state = state_at(root.path()).await;
    assert!(state
        .resolve_model_price("openai_compat", "my-model")
        .is_none());

    state
        .update_settings(overrides(vec![entry(
            "openai_compat",
            " my-model ",
            price(0.5, 1.5),
        )]))
        .expect("valid override saves");

    let resolved = state
        .resolve_model_price("openai_compat", "my-model")
        .expect("override applies");
    assert_eq!(resolved.source, PriceSource::Override);
    assert_eq!(resolved.price, price(0.5, 1.5));

    drop(state);
    let reloaded = state_at(root.path()).await;
    let resolved = reloaded
        .resolve_model_price("openai_compat", "my-model")
        .expect("override persisted");
    assert_eq!(resolved.source, PriceSource::Override);
}

#[tokio::test]
async fn invalid_overrides_are_rejected_whole() {
    let root = tempfile::tempdir().unwrap();
    let state = state_at(root.path()).await;

    for bad in [
        entry("openai", "gpt-4o", price(-1.0, 1.0)),
        entry("openai", "gpt-4o", price(f64::INFINITY, 1.0)),
        entry("openai", "", price(1.0, 1.0)),
        entry("", "gpt-4o", price(1.0, 1.0)),
    ] {
        let good = entry("openai", "gpt-4o-mini", price(1.0, 1.0));
        assert!(
            state.update_settings(overrides(vec![good, bad])).is_err(),
            "a bad entry must reject the whole update"
        );
    }
    assert!(state.settings().unwrap().model_price_overrides.is_empty());
}

#[tokio::test]
async fn a_later_override_for_the_same_model_replaces_the_earlier() {
    let root = tempfile::tempdir().unwrap();
    let state = state_at(root.path()).await;
    state
        .update_settings(overrides(vec![
            entry("openai", "gpt-4o", price(1.0, 1.0)),
            entry("openai", "gpt-4o", price(2.0, 2.0)),
        ]))
        .unwrap();
    let saved = state.settings().unwrap().model_price_overrides;
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].price, price(2.0, 2.0));
}

#[tokio::test]
async fn a_listed_price_beats_the_snapshot_but_not_an_override() {
    let root = tempfile::tempdir().unwrap();
    let state = state_at(root.path()).await;
    let model = "brand-new/model-released-today";
    assert!(state.resolve_model_price("openrouter", model).is_none());

    state.record_listed_prices(
        "openrouter",
        &[ModelInfo {
            id: model.into(),
            display_name: None,
            price: Some(price(0.2, 0.8)),
        }],
    );
    let resolved = state.resolve_model_price("openrouter", model).unwrap();
    assert_eq!(resolved.source, PriceSource::Provider);
    // Another provider's model of the same id is unaffected.
    assert!(state.resolve_model_price("together", model).is_none());

    state
        .update_settings(overrides(vec![entry("openrouter", model, price(9.0, 9.0))]))
        .unwrap();
    let resolved = state.resolve_model_price("openrouter", model).unwrap();
    assert_eq!(resolved.source, PriceSource::Override);
}
