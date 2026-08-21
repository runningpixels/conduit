//! Phase 6 M6.6: diagnostics export integration — the privacy guarantees.
//!
//! `diagnostics::export` is the support-bundle producer. Beyond the unit tests
//! in `diagnostics.rs` (gate + destination), this integration test asserts the
//! hard privacy invariants end-to-end against a real on-disk export: the bundle
//! is valid JSON under `paths.exports`, includes the `exports` path entry, and
//! NEVER contains provider base URLs, artifact allowlists, or anything
//! secret-shaped — even when the settings object carries those values.

use conduit_desktop::{diagnostics, paths::AppPaths, state::AppSettings};
use provider_core::schema::ProviderEndpointConfig;
use std::{collections::HashMap, fs, path::Path};

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
    }
}

#[test]
fn export_refuses_when_disabled() {
    let dir = tempfile::tempdir().unwrap();
    let paths = test_paths(dir.path());
    fs::create_dir_all(&paths.exports).unwrap();
    let settings = AppSettings {
        diagnostics_enabled: false,
        ..AppSettings::default()
    };
    let result = diagnostics::export(&paths, &settings);
    assert!(result.is_err(), "export must refuse when disabled");
    assert!(
        fs::read_dir(&paths.exports).unwrap().count() == 0,
        "no file written when disabled"
    );
}

#[test]
fn export_writes_safe_bundle_under_exports_dir() {
    let dir = tempfile::tempdir().unwrap();
    let paths = test_paths(dir.path());
    fs::create_dir_all(&paths.exports).unwrap();

    // Settings carry a base URL + an allowlist + a provider id. The export must
    // surface only the safe subset and omit the rest.
    let mut endpoints = HashMap::new();
    endpoints.insert(
        "anthropic".to_string(),
        ProviderEndpointConfig {
            base_url: Some("https://secret-gateway.example.internal".to_string()),
            display_name: None,
        },
    );
    let settings = AppSettings {
        active_provider: "anthropic".to_string(),
        active_model: "claude-sonnet-4".to_string(),
        local_only: true,
        diagnostics_enabled: true,
        provider_endpoints: endpoints,
        artifact_remote_allowlist: vec!["https://allowed.example.com".to_string()],
        ..AppSettings::default()
    };

    let result = diagnostics::export(&paths, &settings).expect("export succeeds when enabled");
    assert!(
        result.exported_to.contains("exports"),
        "exported_to should point at the exports dir: {}",
        result.exported_to
    );

    let written = fs::read_to_string(&result.exported_to).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&written).expect("valid JSON");

    // Includes the safe subset.
    let settings_obj = parsed.get("settings").expect("settings object");
    assert_eq!(
        settings_obj.get("active_provider").and_then(|v| v.as_str()),
        Some("anthropic")
    );
    assert_eq!(
        settings_obj
            .get("diagnostics_enabled")
            .and_then(|v| v.as_bool()),
        Some(true)
    );

    // Includes the exports path entry.
    let paths_obj = parsed.get("paths").expect("paths object");
    assert!(
        paths_obj.get("exports").is_some(),
        "payload must include the exports path entry"
    );

    // Hard privacy invariants: none of the sensitive values appear anywhere.
    assert!(
        !written.contains("secret-gateway.example.internal"),
        "bundle must NOT contain provider base URLs"
    );
    assert!(
        !written.contains("allowed.example.com"),
        "bundle must NOT contain artifact allowlist entries"
    );
    assert!(
        !written.contains("providerEndpoints") && !written.contains("provider_endpoints"),
        "bundle must NOT include the providerEndpoints map at all"
    );
    assert!(
        !written.contains("artifactRemoteAllowlist")
            && !written.contains("artifact_remote_allowlist"),
        "bundle must NOT include the artifact allowlist at all"
    );
}
