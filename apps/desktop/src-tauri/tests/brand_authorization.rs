//! White-label authorization: the two flags a branding *write* must respect
//! -- `AppSettings.branding_enabled` (a user preference) and the Mode B
//! build-time lock (`commands::branding::ALLOW_USER_BRANDING`, baked in by
//! `build.rs` from `CONDUIT_ALLOW_USER_BRANDING`).
//!
//! Before this module existed, only the three *read* commands
//! (`get_brand_config`, `get_brand_warnings`, `get_brand_logo`) consulted
//! either flag; every write/removal command had no check at all, so a
//! Mode B build's `allowUserBranding = false` lock -- the one flag meant to
//! be unbypassable short of rebuilding the app -- could be defeated entirely
//! through the ordinary Settings/DocumentPanel Apply UI. These tests fail
//! without `commands::branding::guard_write`/`guard_removal` in place, and
//! exercise both the standalone gate logic (`commands::branding`'s own
//! `#[cfg(test)] mod guard_tests` covers that in isolation) wired into every
//! affected command, plus the read/write symmetry the two together are
//! supposed to have.
//!
//! `tauri::State` has no public constructor outside a running `App`, so
//! every command here is exercised through its `_impl` body with a plain
//! `&AppState`, the same pattern `tests/brand_logo.rs` and
//! `tests/brand_dialog_commands.rs` already use. `allow_user_branding` is
//! passed explicitly to each `_impl` (rather than reading the compiled-in
//! `ALLOW_USER_BRANDING` constant) precisely so both the locked and
//! unlocked case can be exercised in the same test binary -- `option_env!`
//! only ever resolves to whatever *this* binary was actually built with.

use conduit_desktop::{
    branding,
    commands::{
        apply_brand_edits_impl, clear_brand_config_impl, get_brand_config_impl,
        import_brand_file_impl, set_brand_config_impl,
    },
    paths::AppPaths,
    state::AppState,
};
use std::{fs, path::Path};

/// Same layout `paths::resolve` produces, matching
/// `tests/brand_logo.rs::test_paths` / `tests/brand_dialog_commands.rs::test_paths`.
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

/// `branding_enabled` left at its default (`false`) -- opt-in only, see
/// `AppSettings::branding_enabled`'s doc comment.
async fn state_at(root: &Path) -> AppState {
    let paths = test_paths(root);
    create_subdirs(&paths);
    AppState::load_with_paths(paths, "Conduit-test")
        .await
        .expect("load state")
}

/// Same as [`state_at`], but with `brandingEnabled: true` already in
/// `settings.json`. Mirrors `tests/brand_logo.rs::branded_state` /
/// `tests/brand_dialog_commands.rs::branded_state`.
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

// =============================================================================
// set_brand_config_impl
// =============================================================================

#[tokio::test]
async fn set_brand_config_refuses_when_locked_even_with_branding_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let state = branded_state(dir.path()).await;

    let err = set_brand_config_impl(&state, IDENTITY_ONLY_BRAND_MD.to_string(), false).unwrap_err();
    assert!(err.contains("does not permit"), "error: {err}");
    assert!(
        !state.paths.branding.join("brand.md").exists(),
        "a refused write must not land on disk"
    );
}

#[tokio::test]
async fn set_brand_config_refuses_when_branding_disabled_even_if_build_allows_it() {
    let dir = tempfile::tempdir().unwrap();
    let state = state_at(dir.path()).await; // branding_enabled defaults false

    let err = set_brand_config_impl(&state, IDENTITY_ONLY_BRAND_MD.to_string(), true).unwrap_err();
    assert!(err.contains("disabled"), "error: {err}");
    assert!(!state.paths.branding.join("brand.md").exists());
}

#[tokio::test]
async fn set_brand_config_succeeds_when_unlocked_and_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let state = branded_state(dir.path()).await;

    let config =
        set_brand_config_impl(&state, IDENTITY_ONLY_BRAND_MD.to_string(), true).expect("write");
    assert_eq!(config.identity.app_name, "Northwind");
    assert!(state.paths.branding.join("brand.md").exists());
}

// =============================================================================
// clear_brand_config_impl
// =============================================================================

#[tokio::test]
async fn clear_brand_config_refuses_when_locked() {
    let dir = tempfile::tempdir().unwrap();
    let state = branded_state(dir.path()).await;
    branding::set(&state.paths.branding, IDENTITY_ONLY_BRAND_MD).unwrap();

    let err = clear_brand_config_impl(&state, false).unwrap_err();
    assert!(err.contains("does not permit"), "error: {err}");
    assert!(
        state.paths.branding.join("brand.md").exists(),
        "a refused clear must not remove anything"
    );
}

#[tokio::test]
async fn clear_brand_config_permitted_even_when_branding_disabled() {
    // Unlike `set_brand_config_impl`, a removal does not require
    // `branding_enabled` -- see `commands::branding::guard_removal`'s doc
    // comment for why: clearing is idempotent housekeeping, not an
    // activation, and refusing it here would block a legitimate reset with
    // no safety benefit.
    let dir = tempfile::tempdir().unwrap();
    let state = state_at(dir.path()).await; // branding_enabled defaults false
    branding::set(&state.paths.branding, IDENTITY_ONLY_BRAND_MD).unwrap();

    clear_brand_config_impl(&state, true).expect("clear must be permitted while unlocked");
    assert!(!state.paths.branding.join("brand.md").exists());
}

// =============================================================================
// apply_brand_edits_impl
// =============================================================================

#[tokio::test]
async fn apply_brand_edits_refuses_when_locked() {
    let dir = tempfile::tempdir().unwrap();
    let state = branded_state(dir.path()).await;
    let (config, _warnings) = provider_core::brand::parse(IDENTITY_ONLY_BRAND_MD).unwrap();

    let err = apply_brand_edits_impl(&state, config, false).unwrap_err();
    assert!(err.contains("does not permit"), "error: {err}");
    assert!(!state.paths.branding.join("brand.md").exists());
}

#[tokio::test]
async fn apply_brand_edits_refuses_when_branding_disabled() {
    let dir = tempfile::tempdir().unwrap();
    let state = state_at(dir.path()).await;
    let (config, _warnings) = provider_core::brand::parse(IDENTITY_ONLY_BRAND_MD).unwrap();

    let err = apply_brand_edits_impl(&state, config, true).unwrap_err();
    assert!(err.contains("disabled"), "error: {err}");
    assert!(!state.paths.branding.join("brand.md").exists());
}

#[tokio::test]
async fn apply_brand_edits_succeeds_when_unlocked_and_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let state = branded_state(dir.path()).await;
    let (config, _warnings) = provider_core::brand::parse(IDENTITY_ONLY_BRAND_MD).unwrap();

    let applied = apply_brand_edits_impl(&state, config, true).expect("apply");
    assert_eq!(applied.identity.app_name, "Northwind");
}

// =============================================================================
// import_brand_file_impl
// =============================================================================

#[tokio::test]
async fn import_brand_file_refuses_when_locked() {
    let dir = tempfile::tempdir().unwrap();
    let state = branded_state(dir.path()).await;
    let source_dir = tempfile::tempdir().unwrap();
    let source_path = source_dir.path().join("brand.md");
    fs::write(&source_path, IDENTITY_ONLY_BRAND_MD).unwrap();

    let err = import_brand_file_impl(&state, source_path.to_string_lossy().into_owned(), false)
        .unwrap_err();
    assert!(err.contains("does not permit"), "error: {err}");
    assert!(!state.paths.branding.join("brand.md").exists());
}

#[tokio::test]
async fn import_brand_file_refuses_when_branding_disabled() {
    let dir = tempfile::tempdir().unwrap();
    let state = state_at(dir.path()).await;
    let source_dir = tempfile::tempdir().unwrap();
    let source_path = source_dir.path().join("brand.md");
    fs::write(&source_path, IDENTITY_ONLY_BRAND_MD).unwrap();

    let err = import_brand_file_impl(&state, source_path.to_string_lossy().into_owned(), true)
        .unwrap_err();
    assert!(err.contains("disabled"), "error: {err}");
    assert!(!state.paths.branding.join("brand.md").exists());
}

// =============================================================================
// Read/write symmetry
// =============================================================================
//
// The bug this whole module exists to catch: before the write-side gates
// existed, `branding_enabled = false` made every *read* command answer as
// though nothing were configured, while every *write* command happily
// ignored the same setting entirely -- an asymmetry a locked-out user could
// exploit by writing through a path (chat -> `write_brand_theme` ->
// `DocumentPanel` Apply) that never went near the Settings toggle at all.

#[tokio::test]
async fn write_and_read_agree_when_branding_disabled() {
    let dir = tempfile::tempdir().unwrap();
    let state = state_at(dir.path()).await; // branding_enabled defaults false

    // The read side already reported "nothing configured"...
    assert!(get_brand_config_impl(&state).unwrap().is_none());
    // ...and now the write side refuses outright, instead of silently
    // succeeding into a state the read side would never surface.
    assert!(set_brand_config_impl(&state, IDENTITY_ONLY_BRAND_MD.to_string(), true).is_err());
    assert!(get_brand_config_impl(&state).unwrap().is_none());
}

#[tokio::test]
async fn write_and_read_agree_when_build_is_locked() {
    let dir = tempfile::tempdir().unwrap();
    let state = branded_state(dir.path()).await;
    // A pre-existing brand.md (e.g. shipped by a reseller) still reads back
    // normally -- the lock only stops *changing* what is active, not
    // reading it.
    branding::set(&state.paths.branding, IDENTITY_ONLY_BRAND_MD).unwrap();
    assert!(get_brand_config_impl(&state).unwrap().is_some());

    // But no write can alter it while locked, from any of the write
    // commands.
    assert!(set_brand_config_impl(&state, IDENTITY_ONLY_BRAND_MD.to_string(), false).is_err());
    let (config, _warnings) = provider_core::brand::parse(IDENTITY_ONLY_BRAND_MD).unwrap();
    assert!(apply_brand_edits_impl(&state, config, false).is_err());
    assert!(clear_brand_config_impl(&state, false).is_err());

    // Unaffected the whole time.
    let on_disk = fs::read_to_string(state.paths.branding.join("brand.md")).unwrap();
    assert_eq!(on_disk, IDENTITY_ONLY_BRAND_MD);
}
