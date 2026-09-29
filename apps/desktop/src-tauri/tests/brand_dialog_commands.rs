//! White-label dialog-backed import/export: `commands::import_brand_file_dialog_impl`
//! / `commands::export_brand_config_dialog_impl`, the post-picker halves of
//! `import_brand_file_dialog`/`export_brand_config_dialog`.
//!
//! The OS file picker itself cannot be driven headlessly, so these tests
//! exercise exactly the part that *can* be exercised without one: given an
//! already-resolved `Option<PathBuf>` (what the picker would have handed
//! back), does cancelling (`None`) come through as `Ok(None)` rather than an
//! error, and does `Some(path)` delegate correctly to
//! `branding::import`/`branding::export`? Mirrors `tests/brand_logo.rs`'s
//! `_impl`-split approach for the same reason: `tauri::State` has no public
//! constructor outside a running `App`, so the real `#[tauri::command]`
//! functions (which also need a live `tauri::AppHandle` to open a dialog at
//! all) cannot be called directly from a test.

use conduit_desktop::{
    branding,
    commands::{export_brand_config_dialog_impl, import_brand_file_dialog_impl},
    paths::AppPaths,
    state::AppState,
};
use std::{fs, path::Path};

/// Same layout `paths::resolve` produces, matching
/// `tests/local_data_survival.rs::test_paths` / `tests/brand_logo.rs::test_paths`.
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

/// Same as [`state_at`], but with `brandingEnabled: true` already in
/// `settings.json` -- `branding_enabled` defaults to `false` (opt-in only,
/// see `AppSettings::branding_enabled`'s doc comment), and
/// `import_brand_file_dialog_impl` is now gated on it (see
/// `commands::branding::guard_write`), so every test exercising an actual
/// successful import needs this instead of [`state_at`]. Mirrors
/// `tests/brand_logo.rs::branded_state`.
async fn branded_state(root: &Path) -> AppState {
    let paths = test_paths(root);
    create_subdirs(&paths);
    fs::write(
        &paths.settings_file,
        r#"{
  "activeProvider": "anthropic",
  "activeModel": "claude-sonnet-4",
  "localOnly": true,
  "diagnosticsEnabled": false,
  "theme": "system",
  "providerEndpoints": {},
  "artifactRemoteAllowlist": [],
  "updateChannel": "stable",
  "updateCheckEnabled": false,
  "onboardingCompleted": true,
  "encryptionAtRest": false,
  "brandingEnabled": true
}"#,
    )
    .unwrap();

    AppState::load_with_paths(paths, "Conduit-test")
        .await
        .expect("load state")
}

const IDENTITY_ONLY_BRAND_MD: &str = "+++\nschemaVersion = 1\n\n[identity]\nappName     = \"Northwind\"\ndisplayName = \"Northwind AI\"\n+++\n";

// -------------------------------------------------------------------
// import_brand_file_dialog_impl
// -------------------------------------------------------------------

#[tokio::test]
async fn import_dialog_cancel_is_ok_none_not_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let state = state_at(dir.path()).await;

    let result = import_brand_file_dialog_impl(&state, None, true).expect("cancel must not be Err");
    assert!(result.is_none());
    assert!(
        !state.paths.branding.join("brand.md").exists(),
        "a cancelled import must write nothing"
    );
}

#[tokio::test]
async fn import_dialog_some_path_delegates_to_branding_import() {
    let dir = tempfile::tempdir().unwrap();
    let state = branded_state(dir.path()).await;

    let source_dir = tempfile::tempdir().unwrap();
    let source_path = source_dir.path().join("brand.md");
    fs::write(&source_path, IDENTITY_ONLY_BRAND_MD).unwrap();

    let result = import_brand_file_dialog_impl(&state, Some(source_path), true)
        .expect("a valid picked file should import")
        .expect("Some(path) must yield Some(config)");
    assert_eq!(result.identity.app_name, "Northwind");

    let on_disk = fs::read_to_string(state.paths.branding.join("brand.md")).unwrap();
    assert_eq!(on_disk, IDENTITY_ONLY_BRAND_MD);
}

#[tokio::test]
async fn import_dialog_invalid_source_is_a_real_error_not_none() {
    let dir = tempfile::tempdir().unwrap();
    let state = branded_state(dir.path()).await;

    let source_dir = tempfile::tempdir().unwrap();
    let source_path = source_dir.path().join("brand.md");
    fs::write(&source_path, "not a brand file at all").unwrap();

    let err = import_brand_file_dialog_impl(&state, Some(source_path), true).unwrap_err();
    assert!(err.contains("frontmatter"), "error: {err}");
    assert!(!state.paths.branding.join("brand.md").exists());
}

// -------------------------------------------------------------------
// Authorization: import via the dialog path is a write, so it is gated the
// same as `import_brand_file_impl`/`set_brand_config_impl` -- these are the
// dialog-flavored counterpart of the tests in `tests/brand_logo.rs`.
// -------------------------------------------------------------------

#[tokio::test]
async fn import_dialog_refuses_when_build_is_locked_even_with_branding_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let state = branded_state(dir.path()).await;

    let source_dir = tempfile::tempdir().unwrap();
    let source_path = source_dir.path().join("brand.md");
    fs::write(&source_path, IDENTITY_ONLY_BRAND_MD).unwrap();

    let err = import_brand_file_dialog_impl(&state, Some(source_path), false).unwrap_err();
    assert!(err.contains("does not permit"), "error: {err}");
    assert!(!state.paths.branding.join("brand.md").exists());
}

#[tokio::test]
async fn import_dialog_refuses_when_branding_disabled_even_if_build_allows_it() {
    let dir = tempfile::tempdir().unwrap();
    // `state_at`, not `branded_state`: `branding_enabled` stays at its
    // default (`false`).
    let state = state_at(dir.path()).await;

    let source_dir = tempfile::tempdir().unwrap();
    let source_path = source_dir.path().join("brand.md");
    fs::write(&source_path, IDENTITY_ONLY_BRAND_MD).unwrap();

    let err = import_brand_file_dialog_impl(&state, Some(source_path), true).unwrap_err();
    assert!(err.contains("disabled"), "error: {err}");
    assert!(!state.paths.branding.join("brand.md").exists());
}

#[tokio::test]
async fn import_dialog_cancel_bypasses_the_gate_entirely() {
    // Cancelling must stay `Ok(None)` even on a locked, disabled build --
    // there is nothing to refuse when nothing was picked.
    let dir = tempfile::tempdir().unwrap();
    let state = state_at(dir.path()).await;

    let result =
        import_brand_file_dialog_impl(&state, None, false).expect("cancel must not be Err");
    assert!(result.is_none());
}

// -------------------------------------------------------------------
// export_brand_config_dialog_impl
// -------------------------------------------------------------------

#[tokio::test]
async fn export_dialog_cancel_is_ok_none_not_an_error() {
    let dir = tempfile::tempdir().unwrap();
    let state = state_at(dir.path()).await;
    branding::set(&state.paths.branding, IDENTITY_ONLY_BRAND_MD).unwrap();

    let dest_dir = tempfile::tempdir().unwrap();
    let dest_path = dest_dir.path().join("brand.md");

    let result = export_brand_config_dialog_impl(&state, None).expect("cancel must not be Err");
    assert!(result.is_none());
    assert!(
        !dest_path.exists(),
        "a cancelled export must write nothing, even though a destination existed"
    );
}

#[tokio::test]
async fn export_dialog_some_path_delegates_to_branding_export() {
    let dir = tempfile::tempdir().unwrap();
    let state = state_at(dir.path()).await;
    branding::set(&state.paths.branding, IDENTITY_ONLY_BRAND_MD).unwrap();

    let dest_dir = tempfile::tempdir().unwrap();
    let dest_path = dest_dir.path().join("brand.md");

    let result = export_brand_config_dialog_impl(&state, Some(dest_path.clone()))
        .expect("export to a valid destination should succeed");
    assert_eq!(result, Some(()));
    assert_eq!(
        fs::read_to_string(&dest_path).unwrap(),
        IDENTITY_ONLY_BRAND_MD
    );
}

#[tokio::test]
async fn export_dialog_missing_parent_is_a_real_error_not_none() {
    let dir = tempfile::tempdir().unwrap();
    let state = state_at(dir.path()).await;
    branding::set(&state.paths.branding, IDENTITY_ONLY_BRAND_MD).unwrap();

    let dest_dir = tempfile::tempdir().unwrap();
    let dest_path = dest_dir.path().join("does-not-exist").join("brand.md");

    let err = export_brand_config_dialog_impl(&state, Some(dest_path)).unwrap_err();
    assert!(err.contains("does not exist"), "error: {err}");
}
