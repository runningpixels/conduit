//! White-label Mode A, Phase 2: logo save/get/clear through the actual
//! command bodies (`commands::save_brand_logo_impl` / `get_brand_logo_impl`,
//! and `branding::clear_logo`), not just the storage/validation functions
//! underneath them. This is what actually exercises the `branding_enabled`
//! gate and the `data:` URI assembly, neither of which live in
//! `branding.rs`'s or `logo.rs`'s own unit tests.
//!
//! `tauri::State` has no public constructor outside a running `App`, so
//! `commands::branding`'s `save_brand_logo`/`get_brand_logo` themselves
//! cannot be called directly from a test; `save_brand_logo_impl` and
//! `get_brand_logo_impl` are their bodies with a plain `&AppState` instead,
//! exposed `#[doc(hidden)] pub` for exactly this purpose. Building a real
//! `AppState` over a tempdir via `AppState::load_with_paths` mirrors
//! `tests/local_data_survival.rs`'s existing approach for the same reason.

use conduit_desktop::{
    branding,
    commands::{clear_brand_logo_impl, get_brand_logo_impl, save_brand_logo_impl},
    paths::AppPaths,
    state::AppState,
};
use std::{fs, path::Path};

/// Same layout `paths::resolve` produces, matching
/// `tests/local_data_survival.rs::test_paths`.
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

/// An `AppState` rooted at `root` with `brandingEnabled: true` already in
/// `settings.json` -- `branding_enabled` defaults to `false` (opt-in only,
/// see `AppSettings::branding_enabled`'s doc comment), so every test that
/// needs the logo commands to actually do something has to seed this.
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

/// A minimal valid PNG magic-byte prefix (same fixture shape as
/// `logo.rs`'s own `PNG_MAGIC` test constant).
const PNG_BYTES: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
];

#[tokio::test]
async fn get_brand_logo_is_none_when_unbranded() {
    let dir = tempfile::tempdir().unwrap();
    let paths = test_paths(dir.path());
    create_subdirs(&paths);
    // `brandingEnabled` defaults to false and no brand.md exists at all --
    // either alone is enough to make this `None`; both are true here.
    let state = AppState::load_with_paths(paths, "Conduit-test")
        .await
        .expect("load state");

    assert_eq!(get_brand_logo_impl(&state).unwrap(), None);
}

#[tokio::test]
async fn get_brand_logo_is_none_when_branding_enabled_but_no_logo_named() {
    let dir = tempfile::tempdir().unwrap();
    let state = branded_state(dir.path()).await;
    branding::set(&state.paths.branding, IDENTITY_ONLY_BRAND_MD).unwrap();

    assert_eq!(get_brand_logo_impl(&state).unwrap(), None);
}

#[tokio::test]
async fn save_then_get_round_trips_to_a_valid_data_uri() {
    let dir = tempfile::tempdir().unwrap();
    let state = branded_state(dir.path()).await;
    branding::set(&state.paths.branding, IDENTITY_ONLY_BRAND_MD).unwrap();

    let stored = save_brand_logo_impl(&state, PNG_BYTES, "logo.png", true).unwrap();
    assert_eq!(stored, "logo.png");

    let uri = get_brand_logo_impl(&state)
        .unwrap()
        .expect("a logo was just saved");
    assert!(
        uri.starts_with("data:image/png;base64,"),
        "unexpected URI shape: {uri}"
    );

    let encoded = uri.strip_prefix("data:image/png;base64,").unwrap();
    use base64::{engine::general_purpose::STANDARD, Engine};
    let decoded = STANDARD.decode(encoded).expect("valid base64");
    assert_eq!(decoded, PNG_BYTES);
}

#[tokio::test]
async fn swapped_hostile_file_is_caught_on_read() {
    let dir = tempfile::tempdir().unwrap();
    let state = branded_state(dir.path()).await;
    branding::set(&state.paths.branding, IDENTITY_ONLY_BRAND_MD).unwrap();
    save_brand_logo_impl(&state, PNG_BYTES, "logo.png", true).unwrap();

    // Something else with filesystem access -- not `save_brand_logo` --
    // replaces the bytes after the fact. `brand.md` still names
    // `logo.png`, but the bytes no longer are one.
    fs::write(
        state.paths.branding.join("logo.png"),
        b"definitely not a png, just plain bytes",
    )
    .unwrap();

    let err = get_brand_logo_impl(&state).unwrap_err();
    assert!(err.contains("magic bytes"), "error: {err}");
}

#[tokio::test]
async fn clear_brand_logo_removes_file_and_reference_and_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let state = branded_state(dir.path()).await;
    branding::set(&state.paths.branding, IDENTITY_ONLY_BRAND_MD).unwrap();
    save_brand_logo_impl(&state, PNG_BYTES, "logo.png", true).unwrap();
    assert!(get_brand_logo_impl(&state).unwrap().is_some());

    branding::clear_logo(&state.paths.branding).expect("clear");
    assert!(get_brand_logo_impl(&state).unwrap().is_none());
    assert!(!state.paths.branding.join("logo.png").exists());

    branding::clear_logo(&state.paths.branding).expect("clearing twice must still succeed");
}

// -------------------------------------------------------------------
// Authorization: the Mode B build lock and the `branding_enabled` toggle,
// now enforced on writes/removals too (previously only the three read
// commands above checked either flag -- the security gap this module's
// tests now cover).
// -------------------------------------------------------------------

#[tokio::test]
async fn save_brand_logo_refuses_when_build_is_locked_even_with_branding_enabled() {
    let dir = tempfile::tempdir().unwrap();
    let state = branded_state(dir.path()).await;
    branding::set(&state.paths.branding, IDENTITY_ONLY_BRAND_MD).unwrap();

    let err = save_brand_logo_impl(&state, PNG_BYTES, "logo.png", false).unwrap_err();
    assert!(err.contains("does not permit"), "error: {err}");
    // Refused, not a silent no-op: nothing landed on disk.
    assert!(!state.paths.branding.join("logo.png").exists());
}

#[tokio::test]
async fn save_brand_logo_refuses_when_branding_disabled_even_if_build_allows_it() {
    let dir = tempfile::tempdir().unwrap();
    // Unlike `branded_state`, this leaves `brandingEnabled` at its default
    // (`false`) -- opt-in only, per `AppSettings::branding_enabled`.
    let paths = test_paths(dir.path());
    create_subdirs(&paths);
    let state = AppState::load_with_paths(paths, "Conduit-test")
        .await
        .expect("load state");
    branding::set(&state.paths.branding, IDENTITY_ONLY_BRAND_MD).unwrap();

    let err = save_brand_logo_impl(&state, PNG_BYTES, "logo.png", true).unwrap_err();
    assert!(err.contains("disabled"), "error: {err}");
    assert!(!state.paths.branding.join("logo.png").exists());
}

#[tokio::test]
async fn clear_brand_logo_refuses_when_locked() {
    let dir = tempfile::tempdir().unwrap();
    let state = branded_state(dir.path()).await;
    branding::set(&state.paths.branding, IDENTITY_ONLY_BRAND_MD).unwrap();
    save_brand_logo_impl(&state, PNG_BYTES, "logo.png", true).unwrap();

    let err = clear_brand_logo_impl(&state, false).unwrap_err();
    assert!(err.contains("does not permit"), "error: {err}");
    // Refused, not a silent no-op: the logo is still there.
    assert!(state.paths.branding.join("logo.png").exists());
}

#[tokio::test]
async fn clear_brand_logo_permitted_even_when_branding_disabled() {
    // Clearing is a removal, not a write -- `clear_brand_logo_impl` takes no
    // `branding_enabled` parameter at all, unlike `save_brand_logo_impl`, so
    // this exercises it with a state that never enabled branding in the
    // first place and confirms the clear still goes through as long as the
    // build itself is unlocked.
    let dir = tempfile::tempdir().unwrap();
    let paths = test_paths(dir.path());
    create_subdirs(&paths);
    let state = AppState::load_with_paths(paths, "Conduit-test")
        .await
        .expect("load state");
    branding::set(&state.paths.branding, IDENTITY_ONLY_BRAND_MD).unwrap();
    // Save the logo bytes directly via the storage layer (bypassing the
    // gated command) since `branding_enabled` is off here on purpose.
    let stored = branding::save_logo(&state.paths.branding, PNG_BYTES, "png").unwrap();
    branding::set_logo(&state.paths.branding, &stored).unwrap();
    assert!(state.paths.branding.join("logo.png").exists());

    clear_brand_logo_impl(&state, true).expect("clear must be permitted while unlocked");
    assert!(!state.paths.branding.join("logo.png").exists());
}
