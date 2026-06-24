//! Phase 6 — Tauri updater wrapper: the trust-promise gate.
//!
//! Two Tauri commands over the `tauri-plugin-updater` plugin:
//! - [`check_for_update`]: reads `AppSettings.update_channel` +
//!   `update_check_enabled`, builds the channel-specific manifest URL in Rust,
//!   fetches the manifest, and returns `{ version, date, notes }` **without
//!   downloading**. If `update_check_enabled` is false, returns `None` (no
//!   network call).
//! - [`download_and_install`]: re-checks for the update, runs the
//!   **migration / local-data-survival precheck** on a *copy* of the live
//!   `conduit.sqlite` (so the live store is never touched by the precheck),
//!   then delegates to Tauri's signature-verified `download_and_install` and
//!   restarts the app. On precheck failure, aborts with a user-safe message
//!   (the same posture as `MigrationRecovery`) — auto-update never applies over
//!   a store that is not migration-safe.
//!
//! Trust promise (Phase 6 contract): content-light (the manifest carries only
//! version + notes + signature + download URL; the `User-Agent` header carries
//! only `Conduit-Updater/<version>`, no user id), disclosed (the Settings →
//! Updates section shows what is sent and when), toggleable
//! (`update_check_enabled` + explicit "Check now"; `installMode: passive`
//! requires user confirmation before applying), and never applied without the
//! migration precheck.
//!
//! OS code-signing (macOS notarization / Windows Azure Trusted Signing) is
//! deferred to a later phase — bundles ship unsigned with the documented
//! Gatekeeper/SmartScreen first-run trade-off. The updater payload itself is
//! still signature-verified via the Ed25519 keypair in `tauri.conf.json`
//! `plugins.updater.pubkey` (private key in CI secrets, never in the repo).

use std::{fs, path::Path};

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

use crate::{db::migrations, paths::AppPaths, state::AppState};
use provider_core::schema::RolloutChannel;

/// Static host for the per-channel update manifests. M6.2/M6.3 publish
/// `<base>/<channel>/manifest.json` here (GitHub Releases storage + a static
/// host). Moveable: change this const + regenerate the config endpoints.
const UPDATE_BASE: &str = "https://conduit-app.github.io/conduit-updates";

/// Metadata for an available update, returned by [`check_for_update`] without
/// downloading the payload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    /// Unix timestamp (seconds) of the release date, or `None` if the manifest
    /// omitted it. Kept as a number so the renderer can format locale-aware.
    pub date: Option<i64>,
    /// Release notes body (markdown text), if the manifest carried it.
    pub notes: Option<String>,
}

/// Build the manifest URL for the configured channel. `Pinned`/`TenantSpecific`
/// are reserved for Phase 7/8/9 and are not reachable from the consumer UI; if
/// one somehow reaches the runtime, it falls back to `stable`.
fn channel_url(channel: &RolloutChannel) -> Result<Url, String> {
    let seg = match channel {
        RolloutChannel::Beta => "beta",
        _ => "stable",
    };
    Url::parse(&format!("{UPDATE_BASE}/{seg}/manifest.json"))
        .map_err(|e| format!("invalid update endpoint: {e}"))
}

/// `Conduit-Updater/<version>` — the only thing the update request sends beyond
/// the URL itself. No user id, no hardware fingerprint.
fn user_agent(app: &AppHandle) -> String {
    format!("Conduit-Updater/{}", app.package_info().version)
}

/// Migration + local-data-survival precheck: copy the live `conduit.sqlite`
/// (+ `-wal`/`-shm`) to a temp dir, run the migration runner + the startup
/// integrity check on the **copy** (the live store is never touched), and
/// return `Ok(())` only if both pass. On failure, returns a user-safe message
/// so the caller refuses to apply the update — auto-update never proceeds over
/// a store that is not migration-safe. The temp dir is cleaned up on drop.
async fn migration_precheck(paths: &AppPaths) -> Result<(), String> {
    let dir = tempfile::tempdir().map_err(|e| format!("precheck: temp dir: {e}"))?;
    let dst = dir.path().join("conduit.sqlite");

    fs::copy(&paths.database, &dst).map_err(|e| format!("precheck: copy database: {e}"))?;
    // Copy the WAL sidecars so the copy reflects all committed data.
    for suffix in ["-wal", "-shm"] {
        let src = format!("{}{suffix}", paths.database.display());
        if Path::new(&src).exists() {
            let dst_side = format!("{}{suffix}", dst.display());
            fs::copy(&src, &dst_side).map_err(|e| format!("precheck: copy {suffix}: {e}"))?;
        }
    }

    // Run the migration runner on the copy. On a store already at the current
    // schema this is a no-op; the value is confirming the user's data is in a
    // state the runner + integrity check accept before we replace the binary.
    //
    // `open_with_migrations` self-heals: if migrations fail it backs the copy up
    // and resets it to a fresh store, returning `Ok` *with* a `MigrationRecovery`.
    // For the precheck that recovery is the signal that the user's live data
    // would NOT survive an upgrade (it would be wiped to fresh) — so we refuse
    // rather than let an update apply over a store that cannot migrate forward.
    let (pool, recovery) = migrations::open_with_migrations(&dst).await.map_err(|_e| {
        "Conduit will not auto-update: a migration dry-run on a copy of your \
             local data failed. Your data is untouched; export a diagnostics bundle \
             and update manually."
            .to_string()
    })?;
    if recovery.is_some() {
        return Err(
            "Conduit will not auto-update: a dry-run on a copy of your local data \
             showed it would not migrate cleanly and would be reset to an empty \
             store. Your data is untouched; export a diagnostics bundle, then \
             update manually or contact support."
                .to_string(),
        );
    }
    // Belt-and-suspenders: `open_with_migrations` already runs the integrity
    // check on the happy path, but re-affirming it keeps the precheck honest if
    // that internal call is ever refactored away.
    migrations::reconcile_on_startup(&pool).await.map_err(|e| {
        format!(
            "Conduit will not auto-update: your local data did not pass the \
                 integrity check ({e}). Your data is untouched; export a diagnostics \
                 bundle and update manually."
        )
    })?;
    Ok(())
}

/// Check for an update without downloading. Returns `None` when update checks
/// are disabled or no update is available.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<UpdateInfo>, String> {
    let settings = state.settings()?;
    if !settings.update_check_enabled {
        return Ok(None);
    }

    let url = channel_url(&settings.update_channel)?;
    let mut builder = app.updater_builder();
    builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    builder = builder
        .header("User-Agent", user_agent(&app))
        .map_err(|e| e.to_string())?;
    let updater = builder.build().map_err(|e| e.to_string())?;

    let update = updater.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        date: u.date.map(|d| d.unix_timestamp()),
        notes: u.body.clone(),
    }))
}

/// Download and install the pending update, but only after the migration
/// precheck passes. Installs via Tauri's signature-verified path
/// (`installMode: passive` → the user confirms before applying), then restarts
/// the app into the new version.
#[tauri::command]
pub async fn download_and_install_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let settings = state.settings()?;
    let url = channel_url(&settings.update_channel)?;
    let mut builder = app.updater_builder();
    builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    builder = builder
        .header("User-Agent", user_agent(&app))
        .map_err(|e| e.to_string())?;
    let updater = builder.build().map_err(|e| e.to_string())?;

    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update is available to install.".to_string())?;

    // Trust-promise gate: never apply an update over a store that is not
    // migration-safe. The precheck operates on a copy — the live DB is safe.
    migration_precheck(&state.paths).await?;

    // `download_and_install` verifies the payload signature against the pubkey
    // in `tauri.conf.json` before installing. No-op progress callbacks: the
    // consumer UI shows a simple "installing…" state.
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    // Relaunch into the new version. The passive installer has already replaced
    // the bundle; `restart()` exits the process (returns `!`), so it is the
    // function's tail expression — nothing runs after it.
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::AppPaths;

    /// Build an `AppPaths` rooted at `root` with `database` set to `db`. The
    /// other paths are filler — `migration_precheck` only reads `paths.database`.
    fn scratch_paths(root: &Path, db: std::path::PathBuf) -> AppPaths {
        AppPaths {
            root: root.to_path_buf(),
            settings_file: root.join("settings.json"),
            database: db,
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
    fn channel_url_stable_and_beta() {
        let stable = channel_url(&RolloutChannel::Stable).unwrap();
        let beta = channel_url(&RolloutChannel::Beta).unwrap();
        assert!(stable.as_str().ends_with("/stable/manifest.json"));
        assert!(beta.as_str().ends_with("/beta/manifest.json"));
        assert_eq!(stable.scheme(), "https");
        // Pinned/TenantSpecific fall back to stable (consumer UI never sets them).
        let pinned = channel_url(&RolloutChannel::Pinned).unwrap();
        assert!(pinned.as_str().ends_with("/stable/manifest.json"));
    }

    #[tokio::test]
    async fn migration_precheck_passes_on_a_healthy_store() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("conduit.sqlite");
        // Materialize a fully-migrated, reconciled store (the happy path).
        let (pool, recovery) = migrations::open_with_migrations(&db).await.unwrap();
        assert!(
            recovery.is_none(),
            "a fresh store migrates without recovery"
        );
        pool.close().await;

        let paths = scratch_paths(dir.path(), db.clone());
        assert!(migration_precheck(&paths).await.is_ok());
        // The live store is still present and openable — the precheck only ever
        // touched a copy.
        let (pool2, recovery2) = migrations::open_with_migrations(&db).await.unwrap();
        assert!(recovery2.is_none());
        pool2.close().await;
    }

    #[tokio::test]
    async fn migration_precheck_refuses_on_an_unopenable_store_without_touching_it() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("conduit.sqlite");
        std::fs::write(&db, b"not a sqlite database").unwrap();
        let before = std::fs::read(&db).unwrap();

        let paths = scratch_paths(dir.path(), db.clone());
        let result = migration_precheck(&paths).await;
        assert!(
            result.is_err(),
            "precheck must refuse over an unopenable store"
        );
        let msg = result.unwrap_err();
        assert!(
            msg.contains("will not auto-update"),
            "expected a user-safe refusal message, got: {msg}"
        );

        // The live (garbage) file is byte-for-byte untouched — the precheck only
        // ever operated on a copy in a temp dir.
        assert_eq!(std::fs::read(&db).unwrap(), before);
    }
}
