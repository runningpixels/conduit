//! Phase 6 M6.6: local-data survival across an in-place upgrade.
//!
//! Simulates the release scenario "install a new Conduit build over an existing
//! one" hermetically: write a `settings.json` with known keys (typed + raw-only)
//! and seed a `conduit.sqlite` with a conversation, then re-open the *same*
//! paths via `AppState::load_with_paths` (the test-only twin of `load`) and
//! assert settings round-trip, the seeded DB row survives, and a raw-only
//! settings knob (`diagnosticsDisclosureAcknowledged`) survives a typed
//! `update_settings` write + a second reload.

use conduit_desktop::{
    db,
    db::repository::conversations,
    paths::AppPaths,
    state::{AppState, SettingsPatch},
};
use provider_core::schema::RolloutChannel;
use std::{fs, path::Path};

/// Build an `AppPaths` rooted at `root` (every subpath under it), matching the
/// layout `paths::resolve` produces, so `AppState::load_with_paths` operates
/// entirely inside the tempdir.
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

#[tokio::test]
async fn settings_and_db_survive_in_place_reopen() {
    let dir = tempfile::tempdir().expect("tempdir");
    let paths = test_paths(dir.path());
    for sub in [
        &paths.attachments,
        &paths.artifacts,
        &paths.logs,
        &paths.diagnostics,
        &paths.updates,
        &paths.streams,
        &paths.connectors,
        &paths.exports,
    ] {
        fs::create_dir_all(sub).unwrap();
    }

    // 1. A pre-upgrade settings file with typed + raw-only keys. Crucially
    //    `encryptionAtRest: false` keeps the test hermetic (no keychain access),
    //    while `diagnosticsDisclosureAcknowledged: true` is the raw-key survival
    //    probe — it is NOT an `AppSettings` field, so a typed merge that doesn't
    //    preserve raw keys would silently drop it.
    fs::write(
        &paths.settings_file,
        r#"{
  "activeProvider": "anthropic",
  "activeModel": "claude-sonnet-4",
  "localOnly": true,
  "diagnosticsEnabled": true,
  "theme": "system",
  "providerEndpoints": {},
  "artifactRemoteAllowlist": [],
  "updateChannel": "beta",
  "updateCheckEnabled": false,
  "onboardingCompleted": true,
  "encryptionAtRest": false,
  "diagnosticsDisclosureAcknowledged": true
}"#,
    )
    .unwrap();

    // 2. Seed the DB with a conversation so "DB intact" is a real assertion,
    //    not just "the file still exists". Close the seeding pool so the
    //    reopen is a true cold start.
    let (seed_pool, recovery) = db::migrations::open_with_migrations(&paths.database)
        .await
        .expect("seed open");
    assert!(recovery.is_none(), "seeding a fresh store must not recover");
    let seeded = conversations::create(&seed_pool, Some("survival-check"))
        .await
        .expect("seed conversation");
    seed_pool.close().await;

    // Baseline schema_migrations count for the "DB intact" check.
    let (fresh_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM schema_migrations")
        .fetch_one(
            &db::migrations::open_with_migrations(
                &tempfile::tempdir().unwrap().path().join("fresh.sqlite"),
            )
            .await
            .unwrap()
            .0,
        )
        .await
        .unwrap();

    // 3. Re-open the same paths (the in-place upgrade reinstall).
    let state = AppState::load_with_paths(paths.clone(), "Conduit-test")
        .await
        .expect("reload state");

    // Settings round-trip (typed fields).
    let settings = state.settings().expect("read settings");
    assert_eq!(settings.active_provider, "anthropic");
    assert_eq!(settings.active_model, "claude-sonnet-4");
    assert!(
        settings.onboarding_completed,
        "onboardingCompleted must survive"
    );
    assert!(
        matches!(settings.update_channel, RolloutChannel::Beta),
        "updateChannel must survive"
    );
    assert!(
        !settings.update_check_enabled,
        "updateCheckEnabled must survive"
    );
    assert_eq!(
        settings.agent.max_steps, 25,
        "missing agent field must serde-default max_steps"
    );
    assert_eq!(
        settings.agent.wall_clock_budget_secs, 300,
        "missing agent field must serde-default wall_clock_budget_secs"
    );

    // Raw-only knob survives the read.
    assert!(
        state.diagnostics_disclosure_acknowledged(),
        "raw diagnosticsDisclosureAcknowledged must be read back"
    );

    // DB intact: the seeded conversation is still there + schema is current.
    let rows = conversations::list(&state.db)
        .await
        .expect("list conversations");
    assert!(
        rows.iter().any(|c| c.id == seeded.id),
        "seeded conversation must survive the reopen"
    );
    let (live_count,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM schema_migrations")
        .fetch_one(&state.db)
        .await
        .unwrap();
    assert_eq!(
        live_count, fresh_count,
        "schema_migrations count must match a fresh DB"
    );

    // 4. A typed settings write (simulating the new build persisting a change)
    //    must NOT clobber the raw-only disclosure flag.
    let patch = SettingsPatch {
        active_provider: None,
        active_model: Some("claude-opus-4".to_string()),
        local_only: None,
        diagnostics_enabled: None,
        theme: None,
        provider_endpoints: None,
        artifact_remote_allowlist: None,
        artifact_styled_preview: None,
        update_channel: None,
        update_check_enabled: None,
        onboarding_completed: None,
        web_search_enabled: None,
        web_search: None,
        web_search_consent_acknowledged: None,
        agent: Some(provider_core::schema::AgentGuardrails {
            max_steps: 40,
            wall_clock_budget_secs: 600,
        }),
        branding_enabled: None,
        workspace_tools_enabled: None,
        workspace_root: None,
        workspace_tools_consent_acknowledged: None,
    };
    let updated = state.update_settings(patch).expect("update settings");
    assert_eq!(updated.active_model, "claude-opus-4");
    assert_eq!(updated.agent.max_steps, 40);
    assert_eq!(updated.agent.wall_clock_budget_secs, 600);
    assert!(
        state.diagnostics_disclosure_acknowledged(),
        "raw disclosure flag must survive a typed settings write"
    );

    // 5. A second cold reload (relaunch after the upgrade) reflects the
    //    persisted typed change AND the still-present raw knob.
    drop(state);
    let state2 = AppState::load_with_paths(paths.clone(), "Conduit-test")
        .await
        .expect("second reload");
    let settings2 = state2.settings().expect("read settings2");
    assert_eq!(settings2.active_model, "claude-opus-4");
    assert_eq!(settings2.agent.max_steps, 40);
    assert_eq!(settings2.agent.wall_clock_budget_secs, 600);
    assert!(settings2.onboarding_completed);
    assert!(matches!(settings2.update_channel, RolloutChannel::Beta));
    assert!(state2.diagnostics_disclosure_acknowledged());
    // DB still intact across the second reload.
    let rows2 = conversations::list(&state2.db)
        .await
        .expect("list conversations2");
    assert!(rows2.iter().any(|c| c.id == seeded.id));
}
