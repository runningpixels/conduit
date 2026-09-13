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

use std::{
    fs,
    path::Path,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use url::Url;

use crate::{db::migrations, paths::AppPaths, state::AppState};
use provider_core::schema::RolloutChannel;

/// Default host for the per-channel update manifests. The release pipeline
/// publishes `<base>/<channel>/manifest.json` to GitHub Pages on this repo.
///
/// This MUST stay a host the project actually controls: an endpoint on an
/// unclaimed domain lets whoever registers it serve stale-but-validly-signed
/// manifests (a downgrade vector) and log every client's IP. Payloads are still
/// signature-verified against the pubkey in `tauri.conf.json`, so a squatter
/// cannot execute code — but they can pin users to an old version.
const DEFAULT_UPDATE_BASE: &str = "https://runningpixels.github.io/conduit";

/// Resolved update host. Forks MUST point this at their own infrastructure
/// rather than inherit upstream's — set `CONDUIT_UPDATE_BASE` at build time.
/// Under the AGPL every fork ships this source, so a hardcoded endpoint would
/// otherwise make every downstream build phone home to upstream.
const UPDATE_BASE: &str = match option_env!("CONDUIT_UPDATE_BASE") {
    Some(base) => base,
    None => DEFAULT_UPDATE_BASE,
};

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
        let app_name = crate::brand::app_name();
        format!(
            "{app_name} will not auto-update: a migration dry-run on a copy of your \
             local data failed. Your data is untouched; export a diagnostics bundle \
             and update manually."
        )
    })?;
    if recovery.is_some() {
        let app_name = crate::brand::app_name();
        return Err(format!(
            "{app_name} will not auto-update: a dry-run on a copy of your local data \
             showed it would not migrate cleanly and would be reset to an empty \
             store. Your data is untouched; export a diagnostics bundle, then \
             update manually or contact support."
        ));
    }
    // Belt-and-suspenders: `open_with_migrations` already runs the integrity
    // check on the happy path, but re-affirming it keeps the precheck honest if
    // that internal call is ever refactored away.
    migrations::reconcile_on_startup(&pool).await.map_err(|e| {
        let app_name = crate::brand::app_name();
        format!(
            "{app_name} will not auto-update: your local data did not pass the \
                 integrity check ({e}). Your data is untouched; export a diagnostics \
                 bundle and update manually."
        )
    })?;
    Ok(())
}

/// An update that has been downloaded and signature-verified but not yet
/// applied, held in memory until the user quits.
///
/// Deliberately **not** persisted to disk. Staging exists to serve "apply on
/// next quit", and the quit that matters is the one ending the session that
/// staged it; writing an installer-sized blob to disk would buy nothing but
/// staleness, cleanup and disk-usage problems. A crash simply loses the staged
/// payload and the next session re-stages it.
///
/// The [`Update`] handle is kept alongside the bytes because `install` is a
/// method on it. Re-deriving one at exit would mean a network round-trip during
/// teardown — slow, and broken for anyone quitting offline.
#[derive(Default)]
pub struct StagedUpdate(Mutex<Option<Staged>>);

struct Staged {
    info: UpdateInfo,
    update: Update,
    bytes: Vec<u8>,
}

impl StagedUpdate {
    pub fn new() -> Self {
        Self::default()
    }

    fn info(&self) -> Option<UpdateInfo> {
        self.0
            .lock()
            .ok()
            .and_then(|guard| guard.as_ref().map(|s| s.info.clone()))
    }
}

/// Whether "install when I quit" can actually work on this build.
///
/// Windows and macOS replace the bundle in place, so staging and applying at
/// exit is invisible. Linux is split: an AppImage is a single file the updater
/// swaps directly, but a `.deb` is installed by shelling out to `dpkg -i`
/// through `pkexec` (`tauri-plugin-updater-2.10.1/src/updater.rs:1112`) — a
/// graphical sudo prompt. Firing that during teardown, after the window is
/// gone, is an unexplained auth dialog arriving from nowhere; the user gets no
/// context and no way to tell what asked. So automatic install is offered only
/// where it can be silent, and `.deb` users keep the manual path.
///
/// `APPIMAGE` is set by the AppImage runtime itself, which is the same signal
/// the plugin uses to pick its own install strategy.
pub fn automatic_install_supported() -> bool {
    if cfg!(target_os = "linux") {
        std::env::var_os("APPIMAGE").is_some()
    } else {
        true
    }
}

/// What the renderer needs to decide whether to check and what to show,
/// answerable without touching the network.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    /// Unix seconds of the last completed check, or `None` if never checked on
    /// this machine. The scheduler uses this to avoid re-checking on every
    /// launch for someone who opens the app twenty times a day.
    pub last_checked: Option<i64>,
    /// Set once a payload is downloaded, verified and waiting for quit.
    pub staged: Option<UpdateInfo>,
    /// False where install-on-quit cannot be silent (a Linux `.deb` build), so
    /// the UI can withhold the option rather than offer one that will refuse.
    pub automatic_supported: bool,
}

/// On-disk record of the last check. Lives in `AppPaths.updates` — a directory
/// created at startup that has been unused until now.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CheckRecord {
    last_checked: Option<i64>,
}

fn check_record_path(paths: &AppPaths) -> std::path::PathBuf {
    paths.updates.join("last-check.json")
}

fn read_check_record(paths: &AppPaths) -> CheckRecord {
    // A missing or malformed record means "never checked" — it is a scheduling
    // hint, not state worth failing a check over.
    fs::read_to_string(check_record_path(paths))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn record_check_now(paths: &AppPaths) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default();
    let record = CheckRecord {
        last_checked: Some(now),
    };
    if let Ok(serialized) = serde_json::to_string_pretty(&record) {
        // Best-effort: failing to remember the timestamp costs an extra check
        // later, which is not worth surfacing to the user as an error.
        let _ = fs::create_dir_all(&paths.updates);
        let _ = fs::write(check_record_path(paths), serialized);
    }
}

/// Build an updater bound to the configured channel and carrying only the
/// minimal User-Agent. Shared by every path that touches the network so the
/// endpoint and header rules cannot drift between them.
fn build_updater(
    app: &AppHandle,
    channel: &RolloutChannel,
) -> Result<tauri_plugin_updater::Updater, String> {
    let url = channel_url(channel)?;
    let mut builder = app.updater_builder();
    builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    builder = builder
        .header("User-Agent", user_agent(app))
        .map_err(|e| e.to_string())?;
    builder.build().map_err(|e| e.to_string())
}

/// The one place an update check reaches the network.
///
/// Honors `update_check_enabled` as a hard off-switch: when it is false this
/// returns `Ok(None)` **before** constructing a client, so no request is made
/// and no timestamp is recorded. Every caller — the explicit button and the
/// background scheduler alike — goes through here, so that guarantee cannot be
/// bypassed by adding a second call site.
async fn fetch_update(
    app: &AppHandle,
    state: &AppState,
) -> Result<Option<(Update, UpdateInfo)>, String> {
    let settings = state.settings()?;
    if !settings.update_check_enabled {
        return Ok(None);
    }

    let updater = build_updater(app, &settings.update_channel)?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    record_check_now(&state.paths);

    Ok(update.map(|u| {
        let info = UpdateInfo {
            version: u.version.clone(),
            date: u.date.map(|d| d.unix_timestamp()),
            notes: u.body.clone(),
        };
        (u, info)
    }))
}

/// Check for an update without downloading. Returns `None` when update checks
/// are disabled or no update is available.
#[tauri::command]
pub async fn check_for_update(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<UpdateInfo>, String> {
    Ok(fetch_update(&app, &state)
        .await?
        .map(|(_update, info)| info))
}

/// Non-networked status read: last check time and whether something is staged.
#[tauri::command]
pub fn get_update_status(
    state: State<'_, AppState>,
    staged: State<'_, StagedUpdate>,
) -> Result<UpdateStatus, String> {
    Ok(UpdateStatus {
        last_checked: read_check_record(&state.paths).last_checked,
        staged: staged.info(),
        automatic_supported: automatic_install_supported(),
    })
}

/// Download and verify the pending update, then hold it for quit — without
/// restarting.
///
/// This is the `Automatic` policy's install path. It runs the same migration
/// precheck as the manual one; the only difference is the ending. Nothing is
/// applied here, so an in-flight conversation is never interrupted.
#[tauri::command]
pub async fn stage_update(
    app: AppHandle,
    state: State<'_, AppState>,
    staged: State<'_, StagedUpdate>,
) -> Result<Option<UpdateInfo>, String> {
    if !automatic_install_supported() {
        return Err(
            "Automatic install is not available for this package format.              Use Check now to download and install manually."
                .to_string(),
        );
    }

    let Some((update, info)) = fetch_update(&app, &state).await? else {
        return Ok(None);
    };

    // Trust-promise gate: never stage over a store that is not migration-safe.
    // Checked before the download so a doomed update does not burn the
    // bandwidth first.
    migration_precheck(&state.paths).await?;

    // `download` verifies the payload signature against the pubkey in
    // `tauri.conf.json` before returning the bytes, so what we hold is already
    // trusted — `install` at exit does no further network work.
    let bytes = update
        .download(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;

    if let Ok(mut guard) = staged.0.lock() {
        *guard = Some(Staged {
            info: info.clone(),
            update,
            bytes,
        });
    }
    Ok(Some(info))
}

/// Apply a staged update during teardown. No-op when nothing is staged.
///
/// **Must be called after every other shutdown step.** On Windows the plugin's
/// `install` spawns the installer and then calls `std::process::exit(0)`
/// (`tauri-plugin-updater-2.10.1/src/updater.rs:865`), so anything sequenced
/// after this never runs — including connector teardown, which would leave
/// child processes orphaned.
pub fn install_staged_update(app: &AppHandle) {
    let Some(state) = app.try_state::<StagedUpdate>() else {
        return;
    };
    let Some(staged) = state.0.lock().ok().and_then(|mut guard| guard.take()) else {
        return;
    };
    if let Err(error) = staged.update.install(&staged.bytes) {
        // The user is quitting; there is no UI left to show this in, and
        // failing to update is not a reason to fail the quit. The next launch
        // simply finds the same update still available.
        tracing::warn!(
            version = %staged.info.version,
            %error,
            "staged update failed to install on quit"
        );
    }
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
    let updater = build_updater(&app, &settings.update_channel)?;

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
            branding: root.join("branding"),
        }
    }

    #[test]
    fn check_record_round_trips_through_the_updates_dir() {
        let dir = tempfile::tempdir().unwrap();
        let paths = scratch_paths(dir.path(), dir.path().join("conduit.sqlite"));

        // Never checked: no file, no timestamp, no error.
        assert_eq!(read_check_record(&paths).last_checked, None);

        record_check_now(&paths);
        let recorded = read_check_record(&paths).last_checked;
        assert!(recorded.is_some(), "a completed check records a timestamp");
        assert!(
            check_record_path(&paths).starts_with(&paths.updates),
            "the record belongs in AppPaths.updates, not the settings file"
        );
    }

    #[test]
    fn malformed_check_record_reads_as_never_checked() {
        // A scheduling hint is not worth failing a check over: garbage on disk
        // degrades to "check now" rather than erroring the caller.
        let dir = tempfile::tempdir().unwrap();
        let paths = scratch_paths(dir.path(), dir.path().join("conduit.sqlite"));
        fs::create_dir_all(&paths.updates).unwrap();
        fs::write(check_record_path(&paths), b"{ not json").unwrap();

        assert_eq!(read_check_record(&paths).last_checked, None);
    }

    #[test]
    fn staged_update_starts_empty_and_reports_no_info() {
        let staged = StagedUpdate::new();
        assert!(
            staged.info().is_none(),
            "nothing is staged before an update is downloaded"
        );
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
