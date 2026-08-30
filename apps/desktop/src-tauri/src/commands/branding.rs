//! White-label Mode A (runtime branding) IPC surface.
//!
//! Storage/parsing/validation logic lives in `crate::branding` (filesystem)
//! and `provider_core::brand` (pure parse+validate); this module is the thin
//! `#[tauri::command]` layer over both, matching the `local_data` /
//! `commands::settings` split.
//!
//! ## Why warnings are a sibling command, not part of the config payload
//!
//! `get_brand_config`, `set_brand_config`, and `import_brand_file` all have a
//! signature fixed by callers that predate this module: the renderer's
//! `getBrandConfig()` (`apps/desktop/src/ipc/client.ts`) already expects
//! `BrandConfig | null` verbatim, and the other two mirror it for symmetry.
//! None of the three has room to also carry a warnings list without changing
//! that contract. Since warnings (a contrast shortfall, a missing logo file)
//! are cheap to re-derive from whatever is currently on disk, [`get_brand_warnings`]
//! recomputes them from the same [`crate::branding::load`] rather than the
//! success payloads trying to smuggle them through.

use std::path::Path;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use provider_core::{brand::BrandIssue, schema::BrandConfig};
use serde::Serialize;
use tauri::State;

use crate::state::AppState;

// =============================================================================
// Authorization: the two flags a branding *write* must respect
// =============================================================================
//
// `branding_enabled` (a user preference, `AppSettings.branding_enabled`) and
// `allow_user_branding` (a Mode B build-time lock, `BrandRuntime` in
// `provider_core::schema`) were, before this section existed, only ever
// consulted by the three *read* commands below (`get_brand_config`,
// `get_brand_warnings`, `get_brand_logo`). Every command that instead
// *writes* the active brand had no check at all: a chat-generated
// `write_brand_theme` artifact routed through `DocumentPanel`'s Apply button
// straight to `set_brand_config`, bypassing both the user's own "Enable
// branding" toggle and, more seriously, a reseller's Mode B lock -- the one
// flag that is supposed to be unbypassable by anything short of rebuilding
// the app. This section is the fix: every write/removal command below now
// runs through `guard_write`/`guard_removal` before it touches disk.

/// Mode B build-time lock: whether this *compiled binary* permits any
/// branding write at all, independent of what `AppSettings.branding_enabled`
/// says. Baked in by `build.rs` from `CONDUIT_ALLOW_USER_BRANDING`
/// (ultimately sourced from `apps/desktop/branding.build.json`, written by
/// `scripts/apply-brand-identity.mjs` from brand.md's
/// `[runtime] allowUserBranding`), via the identical `option_env!` shape
/// `updater.rs`'s `UPDATE_BASE`/`CONDUIT_UPDATE_BASE` already uses.
///
/// This MUST be a compile-time constant, not a runtime setting, and that is
/// the whole reason it lives here instead of as another `AppSettings` field
/// next to `branding_enabled`: `AppSettings` is a JSON file the *running
/// process itself* reads and writes (see `state::read_settings`/
/// `write_settings`), so a "lock" stored there would only ever be as strong
/// as "hasn't been hand-edited (or reset by a corrupted-settings recovery
/// path) since install" -- not a lock at all. `option_env!` is resolved once,
/// by `rustc`, at the moment this binary was produced; changing it requires
/// rebuilding and re-shipping the app, which is the actual guarantee a
/// reseller needs when they set `allowUserBranding = false`.
///
/// Defaults `true` (branding permitted) when `CONDUIT_ALLOW_USER_BRANDING` is
/// unset -- i.e. every ordinary `cargo build`/`cargo test` in a checkout that
/// never ran `apply-brand-identity.mjs` -- matching
/// `BrandRuntime::allow_user_branding`'s own `#[serde(default = "default_true_bool")]`
/// and the renderer's `buildFlags.ts` fallback, so a stock Conduit build's
/// behavior is unchanged by this constant existing at all.
const ALLOW_USER_BRANDING: bool = match option_env!("CONDUIT_ALLOW_USER_BRANDING") {
    // `str` equality isn't usable in a const context (no const `PartialEq`),
    // so this matches on the byte slice instead -- slice patterns, unlike
    // `==`, are const-stable.
    Some(v) => !matches!(v.as_bytes(), b"false"),
    None => true,
};

/// Returned by every write/removal command when [`ALLOW_USER_BRANDING`] is
/// `false`. Deliberately the same message for every command it appears on --
/// a locked build's answer to "can I change or remove branding" does not
/// depend on which door was tried, and a single shared string makes that
/// invariant easy to grep for.
const LOCKED_MESSAGE: &str =
    "this build does not permit changing or removing branding (allowUserBranding is disabled)";

/// Returned by write commands (not removals -- see [`guard_removal`]) when
/// `AppSettings.branding_enabled` is off. Actionable rather than a bare
/// refusal: the user is one Settings toggle away from the same call
/// succeeding.
const DISABLED_MESSAGE: &str = "branding is disabled -- turn on \"Enable branding\" in Settings \
                                 before applying a brand theme";

/// Gate for every command that *writes* a new active brand:
/// [`set_brand_config`], [`apply_brand_edits`], [`import_brand_file`],
/// [`import_brand_file_dialog`], [`save_brand_logo`]. (Removals go through
/// [`guard_removal`] instead -- see that function's doc comment for why the
/// two are not the same check.)
///
/// `allow_user_branding` is checked first and unconditionally: a locked
/// build refuses regardless of what `branding_enabled` says, because a
/// per-install setting must never be able to override the build-time lock.
///
/// `branding_enabled` is checked second. Refusing here -- rather than
/// silently persisting the write while leaving the setting untouched -- is
/// what closes the specific bug this gate exists for: `DocumentPanel`'s
/// Apply flow (`apps/desktop/src/workspace/DocumentPanel.tsx`) calls
/// `applyBrand()` (re-skinning the running app's CSS custom properties)
/// immediately after `setBrandConfig` resolves, entirely client-side, with
/// no further round trip to ask whether branding is actually enabled. If
/// this command let that write through while `branding_enabled` stayed
/// `false`, the app would visibly re-skin while Settings still reported
/// branding as off -- the running state and the persisted setting actively
/// disagreeing. Returning `Err` here means that `try` block throws before
/// `applyBrand()` ever runs, so the disagreement cannot occur. The user is
/// not blocked, only asked to flip the toggle first, which keeps
/// `branding_enabled`'s own documented contract intact: branding is always
/// an opt-in action, never something a write silently flips on for you.
fn guard_write(allow_user_branding: bool, branding_enabled: bool) -> Result<(), String> {
    if !allow_user_branding {
        return Err(LOCKED_MESSAGE.to_string());
    }
    if !branding_enabled {
        return Err(DISABLED_MESSAGE.to_string());
    }
    Ok(())
}

/// Gate for [`clear_brand_config`]/[`clear_brand_logo`] -- removals, not
/// writes, and deliberately a different (narrower) check than
/// [`guard_write`].
///
/// Still refuses unconditionally when this build is locked
/// (`!allow_user_branding`): a reseller's entire reason for
/// `allowUserBranding = false` is that end users cannot alter the shipped
/// identity in *either* direction, and letting "clear" strip brand.md back
/// out (falling back to Conduit's own default look) is exactly the kind of
/// alteration the lock exists to prevent.
///
/// Does NOT check `branding_enabled`, unlike [`guard_write`]: clearing is
/// idempotent housekeeping ("remove whatever's on disk, if anything"), not
/// an activation, and it produces no visible re-skin of its own that could
/// disagree with a disabled toggle the way an allowed *write* could (see
/// `guard_write`'s doc comment). Refusing a clear only because the user
/// happens to have branding turned off would block a legitimate reset --
/// e.g. "I don't want this stray brand.md around any more" -- with no
/// corresponding safety benefit.
fn guard_removal(allow_user_branding: bool) -> Result<(), String> {
    if !allow_user_branding {
        return Err(LOCKED_MESSAGE.to_string());
    }
    Ok(())
}

/// Serializable view of a `provider_core::brand::BrandIssue`. That type isn't
/// `Serialize`/`TS`-derived (it lives in a crate that stays IO- and
/// IPC-agnostic on purpose), so this is a hand-written payload the same way
/// `AppPathsPayload`/`MigrationRecoveryInfo` are elsewhere in `commands::settings`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandWarningPayload {
    pub field: String,
    pub message: String,
}

impl From<BrandIssue> for BrandWarningPayload {
    fn from(issue: BrandIssue) -> Self {
        Self {
            field: issue.field,
            message: issue.message,
        }
    }
}

/// The active brand, or `null` when unbranded — either because no `brand.md`
/// exists, or because `branding_enabled` is off. A `brand.md` that exists but
/// fails validation is *not* folded into either of those cases: it comes back
/// as `Err` so the failure reaches the user instead of being read as "no
/// brand configured."
#[tauri::command]
pub fn get_brand_config(state: State<'_, AppState>) -> Result<Option<BrandConfig>, String> {
    get_brand_config_impl(&state)
}

/// The body of [`get_brand_config`] -- see [`save_brand_logo_impl`] for why
/// this takes `&AppState` rather than `State<'_, AppState>`. Exists
/// primarily so tests can assert the read/write symmetry the flags are
/// meant to have: e.g. `branding_enabled = false` makes both this and
/// `set_brand_config_impl` behave consistently, one returning `None`, the
/// other refusing outright, rather than one silently ignoring the setting
/// the other enforces.
#[doc(hidden)]
pub fn get_brand_config_impl(state: &AppState) -> Result<Option<BrandConfig>, String> {
    let settings = state.settings()?;
    if !settings.branding_enabled {
        return Ok(None);
    }
    Ok(crate::branding::load(&state.paths.branding)?.map(|loaded| loaded.config))
}

/// Non-blocking warnings for whatever brand is currently on disk (e.g. a
/// palette that clears validation but falls short of WCAG AA). Empty when
/// unbranded, branding is disabled, or nothing failed. Errors are *not*
/// surfaced here — a `brand.md` bad enough to fail validation is reported by
/// [`get_brand_config`] instead, since a "warnings" call silently going empty
/// on a broken file would look identical to a healthy one.
#[tauri::command]
pub fn get_brand_warnings(state: State<'_, AppState>) -> Result<Vec<BrandWarningPayload>, String> {
    get_brand_warnings_impl(&state)
}

/// The body of [`get_brand_warnings`] -- see [`save_brand_logo_impl`] for why
/// this takes `&AppState` rather than `State<'_, AppState>`.
#[doc(hidden)]
pub fn get_brand_warnings_impl(state: &AppState) -> Result<Vec<BrandWarningPayload>, String> {
    let settings = state.settings()?;
    if !settings.branding_enabled {
        return Ok(Vec::new());
    }
    let warnings = crate::branding::load(&state.paths.branding)?
        .map(|loaded| loaded.warnings)
        .unwrap_or_default();
    Ok(warnings
        .into_iter()
        .map(BrandWarningPayload::from)
        .collect())
}

/// Parse and validate `source` as a `brand.md`, and persist it only if it
/// validates cleanly. `source` is raw text (e.g. from an in-app editor), not
/// a file path — see [`import_brand_file`] for loading from disk.
///
/// Gated by [`guard_write`] -- see that function's doc comment for what each
/// of the two flags means here and why a refusal, not a silent no-op, is the
/// correct response to either being unmet.
#[tauri::command]
pub fn set_brand_config(state: State<'_, AppState>, source: String) -> Result<BrandConfig, String> {
    set_brand_config_impl(&state, source, ALLOW_USER_BRANDING)
}

/// The body of [`set_brand_config`] -- see [`save_brand_logo_impl`] for why
/// this takes a plain `&AppState` rather than `State<'_, AppState>`.
/// `allow_user_branding` is threaded in as a parameter rather than read
/// straight from [`ALLOW_USER_BRANDING`] so tests can exercise both the
/// locked and unlocked case without needing a second compiled binary --
/// `option_env!` can only ever resolve to whatever this test binary was
/// actually built with.
#[doc(hidden)]
pub fn set_brand_config_impl(
    state: &AppState,
    source: String,
    allow_user_branding: bool,
) -> Result<BrandConfig, String> {
    let settings = state.settings()?;
    guard_write(allow_user_branding, settings.branding_enabled)?;
    let (config, _warnings) = crate::branding::set(&state.paths.branding, &source)?;
    Ok(config)
}

/// Remove the active brand (and its logo, if any). Idempotent — clearing an
/// already-unbranded install succeeds.
///
/// Gated by [`guard_removal`], not [`guard_write`] -- a clear is permitted
/// even while `branding_enabled` is off; see that function's doc comment for
/// why.
#[tauri::command]
pub fn clear_brand_config(state: State<'_, AppState>) -> Result<(), String> {
    clear_brand_config_impl(&state, ALLOW_USER_BRANDING)
}

/// The body of [`clear_brand_config`] -- see [`set_brand_config_impl`] for
/// why this takes `&AppState` plus an explicit `allow_user_branding`.
#[doc(hidden)]
pub fn clear_brand_config_impl(state: &AppState, allow_user_branding: bool) -> Result<(), String> {
    guard_removal(allow_user_branding)?;
    crate::branding::clear(&state.paths.branding)
}

/// Parse and validate `source` as a `brand.md` -- no filesystem access, no
/// persistence, and (unlike every other command in this module) no
/// `AppState` at all, since there is nothing here that touches the active
/// brand or the branding directory.
///
/// This exists for the renderer's Markdown-artifact viewer: `write_brand_theme`
/// (`agent_tools.rs`) saves a proposed theme as an ordinary Markdown
/// artifact, and the renderer needs a way to ask "is this particular
/// artifact's content actually an applicable brand theme, so I should offer
/// a Preview/Apply affordance on it?" without that question ever risking a
/// write. Routing that check through [`crate::branding::set`] (which persists
/// on success) would make a mere "can I preview this" probe capable of
/// silently becoming the active brand -- exactly the side effect
/// `write_brand_theme`'s design deliberately avoids at the point the theme
/// is generated. This command is the read-only counterpart that keeps that
/// guarantee intact one step later, at render time.
#[tauri::command]
pub fn parse_brand_source(source: String) -> Result<BrandConfig, String> {
    let (config, _warnings) =
        provider_core::brand::parse(&source).map_err(crate::branding::describe_error)?;
    Ok(config)
}

/// Import a `brand.md` from an already-resolved path, copying its logo
/// alongside if one is named. Validated exactly like [`set_brand_config`] --
/// an invalid source file is rejected and nothing is written.
///
/// `path` is renderer-supplied, which is why this command exists alongside
/// [`import_brand_file_dialog`] rather than being replaced by it: kept for
/// callers that already have a path in hand (tests, a future CLI/scripted
/// import) instead of forcing every caller through a picker. The in-app UI
/// calls [`import_brand_file_dialog`] instead, precisely so *this* command
/// never has to be the one taking a path straight from the renderer in
/// practice -- see that command's doc comment.
#[tauri::command]
pub fn import_brand_file(state: State<'_, AppState>, path: String) -> Result<BrandConfig, String> {
    import_brand_file_impl(&state, path, ALLOW_USER_BRANDING)
}

/// The body of [`import_brand_file`] -- see [`set_brand_config_impl`] for why
/// this takes `&AppState` plus an explicit `allow_user_branding`. Gated by
/// [`guard_write`], the same as [`set_brand_config`]: importing is a write,
/// not a removal.
#[doc(hidden)]
pub fn import_brand_file_impl(
    state: &AppState,
    path: String,
    allow_user_branding: bool,
) -> Result<BrandConfig, String> {
    let settings = state.settings()?;
    guard_write(allow_user_branding, settings.branding_enabled)?;
    let (config, _warnings) = crate::branding::import(&state.paths.branding, Path::new(&path))?;
    Ok(config)
}

/// Apply a [`BrandConfig`] the Settings UI edited (e.g. one colour tweak),
/// letting `crate::branding::apply` decide *how* to write it: a surgical
/// [`provider_core::brand::merge_brand_edits`] into the existing `brand.md`
/// when one exists, so a hand-authored file's comments, key order, and body
/// survive an in-app edit -- or a fresh [`provider_core::brand::
/// render_brand_md`] when there is nothing to merge into yet. `config` is
/// validated first; an invalid config is rejected and nothing is written.
///
/// Returns the re-parsed config, not `config` itself, so the renderer always
/// reflects what actually landed on disk rather than what it sent.
#[tauri::command]
pub fn apply_brand_edits(
    state: State<'_, AppState>,
    config: BrandConfig,
) -> Result<BrandConfig, String> {
    apply_brand_edits_impl(&state, config, ALLOW_USER_BRANDING)
}

/// The body of [`apply_brand_edits`] -- see [`set_brand_config_impl`] for why
/// this takes `&AppState` plus an explicit `allow_user_branding`. Gated by
/// [`guard_write`]: editing the active brand from Settings is a write, the
/// same as [`set_brand_config`]/[`import_brand_file`].
#[doc(hidden)]
pub fn apply_brand_edits_impl(
    state: &AppState,
    config: BrandConfig,
    allow_user_branding: bool,
) -> Result<BrandConfig, String> {
    let settings = state.settings()?;
    guard_write(allow_user_branding, settings.branding_enabled)?;
    let (config, _warnings) = crate::branding::apply(&state.paths.branding, &config)?;
    Ok(config)
}

/// Export the active `brand.md` -- and its logo, if any -- to `dest_path`.
///
/// A brand exports as `brand.md` plus its logo file, copied alongside each
/// other, rather than some single opaque bundle: that pair is what stays
/// hand-editable on the receiving end, which is the entire point of the
/// format (see `docs/private/white-label-plan.md` §4). `dest_path`'s parent
/// directory must already exist -- this never creates a directory tree, only
/// the files themselves.
///
/// Deliberately NOT gated by `guard_write`/`guard_removal`, unlike every
/// write/removal command above: export copies whatever is already on disk to
/// a caller-chosen destination but never changes which brand is active, so
/// neither flag's contract is at stake here. `allow_user_branding = false`
/// exists to stop the *active* brand from being altered or removed, not to
/// stop a copy of it leaving the branding directory -- and a locked build's
/// own `brand.md` already sits in plain text under the install directory
/// regardless, so this command grants no access a local user does not
/// already have via a file manager. Gating it would only block a legitimate
/// "back up my current brand.md" use case with no corresponding security
/// benefit.
#[tauri::command]
pub fn export_brand_config(state: State<'_, AppState>, dest_path: String) -> Result<(), String> {
    crate::branding::export(&state.paths.branding, Path::new(&dest_path))
}

// =============================================================================
// Dialog-backed import/export
// =============================================================================
//
// ADR-008 (`docs/adr/adr-008-tauri-capability-surface.md`) keeps
// `capabilities/default.json` at `core:*` only -- no `dialog:default` -- so
// the renderer cannot call `invoke('plugin:dialog|open')` (or any other
// plugin JS command) directly. It can only reach a curated set of Conduit's
// own `#[tauri::command]`s. The two commands below are that curated seam for
// branding import/export: the renderer asks Conduit to show a picker, and
// only Rust ever touches `tauri_plugin_dialog`.
//
// This also means the picker chooses the path, not the renderer -- unlike
// `import_brand_file`/`export_brand_config` above, neither command below
// accepts a path argument at all. That is exactly the shape ADR-008 asks for
// from anything that touches the filesystem: never trust a renderer-supplied
// path when the OS itself can hand back a user-chosen one instead.
//
// ## Why this needs no `dialog:default` grant
//
// ADR-008 finding #2 verified, by reading `tauri-plugin-shell`'s source,
// that `ShellExt::open` called from Rust skips the ACL/scope check entirely
// -- only the JS-invoked path is capability-gated. The same holds here,
// verified the same way against `tauri-plugin-dialog-2.7.1`:
// `FileDialogBuilder::pick_file`/`save_file` drive the OS picker directly
// (`src/desktop.rs`) and never consult `RuntimeAuthority`/`allowed_commands`
// at all -- that machinery only exists on the side that answers a JS
// `invoke('plugin:dialog|...')` call, which nothing in this codebase issues.
// `#[tauri::command]` functions are auto-allowed regardless of the
// capability file (ADR-008 finding #1), so
// `import_brand_file_dialog`/`export_brand_config_dialog` are reachable from
// the renderer even though `plugin:dialog|open` itself is not.
//
// ## Why the callback API, not `blocking_pick_file`/`blocking_save_file`
//
// The plugin ships both. The blocking variants park the calling thread on a
// `std::sync::mpsc::recv()` until the user responds to the dialog -- their
// own doc comments say to use them only "in other contexts" than the main
// thread. A `#[tauri::command] async fn` is driven on Tauri's async runtime
// (tokio), not the OS event-loop thread, but parking a tokio worker thread
// on a blocking channel recv for however long a user takes to click through
// a save dialog is still the wrong shape for async code -- it stalls
// whatever else that worker was scheduled to run in the meantime. The
// callback API (`pick_file`/`save_file`) is genuinely non-blocking, so it is
// bridged into `async fn` with a `tokio::sync::oneshot` channel instead --
// the same callback -> `.await` bridge `connector_runtime::consent` already
// uses for its own consent-decision channel.

/// Show the native "choose a brand.md" file picker, filtered to `.md`, and
/// import whatever the user selects via the same [`crate::branding::import`]
/// logic [`import_brand_file`] uses. `Ok(None)` means the user closed the
/// dialog without picking anything -- cancelling is success, not an error,
/// and must not surface as one to the renderer.
#[tauri::command]
pub async fn import_brand_file_dialog(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<BrandConfig>, String> {
    let picked = pick_file(&app, "Import brand.md").await?;
    import_brand_file_dialog_impl(&state, picked, ALLOW_USER_BRANDING)
}

/// The part of [`import_brand_file_dialog`] that runs once the picker has
/// already resolved to `picked`. Split out, and `#[doc(hidden)] pub`, for
/// the same reason [`save_brand_logo_impl`]/[`get_brand_logo_impl`] are: the
/// OS picker cannot be driven headlessly in a test, but the
/// cancel-is-success behaviour and the delegation to
/// [`crate::branding::import`] can be, and are, exercised directly against a
/// plain `&AppState` (`tests/brand_dialog_commands.rs`).
/// Gated by [`guard_write`] the same as [`import_brand_file`] -- but only
/// once the user has actually picked a file: cancelling (`picked: None`)
/// short-circuits to `Ok(None)` before the gate ever runs, so a locked or
/// disabled build never turns "I clicked Cancel" into an error message.
#[doc(hidden)]
pub fn import_brand_file_dialog_impl(
    state: &AppState,
    picked: Option<std::path::PathBuf>,
    allow_user_branding: bool,
) -> Result<Option<BrandConfig>, String> {
    let Some(path) = picked else {
        return Ok(None);
    };
    let settings = state.settings()?;
    guard_write(allow_user_branding, settings.branding_enabled)?;
    let (config, _warnings) = crate::branding::import(&state.paths.branding, &path)?;
    Ok(Some(config))
}

/// Show the native "save brand.md as..." file picker, defaulted to the
/// filename `brand.md`, and export the active brand there via the same
/// [`crate::branding::export`] logic [`export_brand_config`] uses (copying
/// the logo alongside, into the same directory the user chose). `Ok(None)`
/// means the user closed the dialog without choosing a destination --
/// cancelling is success, not an error.
#[tauri::command]
pub async fn export_brand_config_dialog(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<()>, String> {
    let picked = pick_save_path(&app, "Export brand.md").await?;
    export_brand_config_dialog_impl(&state, picked)
}

/// The part of [`export_brand_config_dialog`] that runs once the picker has
/// already resolved to `picked` -- see [`import_brand_file_dialog_impl`]'s
/// doc comment for why this split exists.
#[doc(hidden)]
pub fn export_brand_config_dialog_impl(
    state: &AppState,
    picked: Option<std::path::PathBuf>,
) -> Result<Option<()>, String> {
    let Some(path) = picked else {
        return Ok(None);
    };
    crate::branding::export(&state.paths.branding, &path)?;
    Ok(Some(()))
}

/// Show a single-file "open" picker filtered to `.md` and resolve to the
/// chosen path, or `None` if the user cancelled. `title` is the only thing
/// that differs between this and the save-dialog case, which
/// [`pick_save_path`] handles separately rather than this function trying to
/// serve both.
async fn pick_file(
    app: &tauri::AppHandle,
    title: &str,
) -> Result<Option<std::path::PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Brand file", &["md"])
        .set_title(title)
        .pick_file(move |file_path| {
            // The dialog delivers its result exactly once; if the receiver
            // has already gone away (it should not have -- the command that
            // created it is still awaiting `rx` at this point) there is
            // simply nothing left to deliver to.
            let _ = tx.send(file_path);
        });

    resolve_picked_path(rx).await
}

/// Show a "save as" picker filtered to `.md`, pre-filled with
/// [`crate::branding::BRAND_FILE_NAME`], and resolve to the chosen
/// destination path, or `None` if the user cancelled.
async fn pick_save_path(
    app: &tauri::AppHandle,
    title: &str,
) -> Result<Option<std::path::PathBuf>, String> {
    use tauri_plugin_dialog::DialogExt;

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Brand file", &["md"])
        .set_file_name(crate::branding::BRAND_FILE_NAME)
        .set_title(title)
        .save_file(move |file_path| {
            let _ = tx.send(file_path);
        });

    resolve_picked_path(rx).await
}

/// Await the dialog's callback result and convert its
/// `tauri_plugin_dialog::FilePath` into a plain [`std::path::PathBuf`].
/// Shared by [`pick_file`] and [`pick_save_path`] since both hand back the
/// same shape once the user has actually picked something.
async fn resolve_picked_path(
    rx: tokio::sync::oneshot::Receiver<Option<tauri_plugin_dialog::FilePath>>,
) -> Result<Option<std::path::PathBuf>, String> {
    let picked = rx
        .await
        .map_err(|_| "the file dialog closed without a response".to_string())?;

    picked
        .map(|file_path| {
            file_path
                .into_path()
                .map_err(|err| format!("failed to resolve the picked file path: {err}"))
        })
        .transpose()
}

// =============================================================================
// Logo (Phase 2)
// =============================================================================

/// Validate `bytes` and persist them as the active brand's logo.
///
/// The size cap and MIME decision both happen in [`crate::logo::validate`],
/// re-enforced here in Rust rather than trusted from the picker UI --
/// mirroring `commands::artifacts::save_attachment`'s inline-cap shape
/// (`ATTACHMENT_INLINE_CAP_BYTES`), where the same discipline applies: a
/// renderer-side size or type check is advice a modified renderer or a
/// direct IPC call can simply not make, not a boundary. `file_name` is only
/// ever used to read the *claimed* extension for that validation -- the
/// extension actually used on disk (via [`crate::branding::save_logo`])
/// comes from the sniffed type, so a picker offering a misleading name can
/// never cause a mismatched file to land on disk.
///
/// Returns the stored bare filename (e.g. `"logo.png"`), which is also what
/// `brand.md`'s `[logo] file` now names.
/// Gated by [`guard_write`] the same as [`set_brand_config`] -- a logo save
/// is as much a write to the active brand as any other.
#[tauri::command]
pub fn save_brand_logo(
    state: State<'_, AppState>,
    bytes: Vec<u8>,
    file_name: String,
) -> Result<String, String> {
    save_brand_logo_impl(&state, &bytes, &file_name, ALLOW_USER_BRANDING)
}

/// The body of [`save_brand_logo`], taking a plain `&AppState` instead of a
/// Tauri-managed `State` so it can be exercised directly from an integration
/// test (`tauri::State` has no public constructor outside a running `App` --
/// same reason `AppState::load_with_paths` is `pub` + `#[doc(hidden)]`
/// rather than test-only). `allow_user_branding` is an explicit parameter
/// rather than reading [`ALLOW_USER_BRANDING`] directly -- see
/// [`set_brand_config_impl`]'s doc comment for why.
#[doc(hidden)]
pub fn save_brand_logo_impl(
    state: &AppState,
    bytes: &[u8],
    file_name: &str,
    allow_user_branding: bool,
) -> Result<String, String> {
    let settings = state.settings()?;
    guard_write(allow_user_branding, settings.branding_enabled)?;
    let mime = crate::logo::validate(bytes, file_name)?;
    let stored_name = crate::branding::save_logo(&state.paths.branding, bytes, mime.extension())?;
    crate::branding::set_logo(&state.paths.branding, &stored_name)?;
    Ok(stored_name)
}

/// The active logo as a complete `data:` URI (e.g.
/// `data:image/png;base64,...`), or `None` when unbranded, when
/// `branding_enabled` is off, or when `brand.md` names no logo. A logo named
/// in `brand.md` whose file is missing from disk is *not* an error here --
/// that is surfaced as a warning through [`get_brand_warnings`] instead (see
/// [`crate::branding::load`]), consistent with how a missing logo is treated
/// everywhere else in this module.
///
/// ## Why this assembles the whole URI in Rust instead of returning
/// `{ mime, base64 }`
///
/// If the renderer built the `data:<mime>;base64,<data>` string itself from
/// two separate fields, a hostile `mime` value could inject its own `;` or
/// `,` and change what the resulting string actually is once handed to
/// `<img src>`. That risk only exists if `mime` can be an arbitrary string
/// in the first place. Here it never is: [`crate::logo::validate`] returns a
/// [`crate::logo::LogoMime`], a closed four-value enum, and its
/// `mime_type()` is what gets interpolated -- there is no code path by which
/// a free-form MIME string that crossed IPC could ever reach this format
/// string. Returning the pre-assembled URI just makes that guarantee visible
/// at the type layer the renderer actually consumes, instead of trusting the
/// renderer to reconstruct it correctly every time.
///
/// ## Why the bytes are re-validated here, not just trusted from the write
///
/// [`save_brand_logo`] already validated these bytes once, but that
/// guarantee only covers the moment they were written. Anything else with
/// filesystem access -- another process, a hand-edit, a restored backup --
/// could have replaced `logo.<ext>` between then and now, and this command
/// is the last point before those bytes are handed to the renderer and
/// rendered as an `<img>`. Re-running the same closed-set check on read is
/// what catches that swap instead of trusting a validation that only ran
/// once, in the past.
#[tauri::command]
pub fn get_brand_logo(state: State<'_, AppState>) -> Result<Option<String>, String> {
    get_brand_logo_impl(&state)
}

/// The body of [`get_brand_logo`] -- see [`save_brand_logo_impl`] for why
/// this takes `&AppState` rather than `State<'_, AppState>`.
#[doc(hidden)]
pub fn get_brand_logo_impl(state: &AppState) -> Result<Option<String>, String> {
    let settings = state.settings()?;
    if !settings.branding_enabled {
        return Ok(None);
    }

    let Some(loaded) = crate::branding::load(&state.paths.branding)? else {
        return Ok(None);
    };
    let Some(logo) = loaded.config.logo else {
        return Ok(None);
    };

    let path = state.paths.branding.join(&logo.file);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        // Missing on disk is `get_brand_warnings`'s concern, not an error
        // here -- see this function's doc comment.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(format!("failed to read {}: {err}", path.display())),
    };

    let mime = crate::logo::validate(&bytes, &logo.file)?;
    let encoded = B64.encode(&bytes);
    Ok(Some(format!("data:{};base64,{encoded}", mime.mime_type())))
}

/// Remove the active logo: its file on disk and the `[logo]` reference in
/// `brand.md`. Idempotent — clearing an already-logo-less (or entirely
/// unbranded) install succeeds.
///
/// Gated by [`guard_removal`], not [`guard_write`] -- same reasoning as
/// [`clear_brand_config`], and for the same reason: a removal, permitted
/// even while `branding_enabled` is off, refused only when this build is
/// locked.
#[tauri::command]
pub fn clear_brand_logo(state: State<'_, AppState>) -> Result<(), String> {
    clear_brand_logo_impl(&state, ALLOW_USER_BRANDING)
}

/// The body of [`clear_brand_logo`] -- see [`set_brand_config_impl`] for why
/// this takes `&AppState` plus an explicit `allow_user_branding`.
#[doc(hidden)]
pub fn clear_brand_logo_impl(state: &AppState, allow_user_branding: bool) -> Result<(), String> {
    guard_removal(allow_user_branding)?;
    crate::branding::clear_logo(&state.paths.branding)
}

#[cfg(test)]
mod guard_tests {
    use super::*;

    #[test]
    fn write_ok_only_when_both_flags_permit_it() {
        assert!(guard_write(true, true).is_ok());
    }

    #[test]
    fn write_refuses_when_locked_regardless_of_branding_enabled() {
        // The build lock wins even if the user has branding turned on --
        // it must be impossible for a per-install setting to override it.
        let err = guard_write(false, true).unwrap_err();
        assert_eq!(err, LOCKED_MESSAGE);
        let err = guard_write(false, false).unwrap_err();
        assert_eq!(err, LOCKED_MESSAGE);
    }

    #[test]
    fn write_refuses_when_branding_disabled_but_build_unlocked() {
        let err = guard_write(true, false).unwrap_err();
        assert_eq!(err, DISABLED_MESSAGE);
    }

    #[test]
    fn locked_message_wins_over_disabled_message_when_both_apply() {
        // Order matters for the message a caller sees: the build lock is
        // checked first, so a locked *and* disabled build reports the lock,
        // not the (comparatively actionable, "flip a Settings toggle")
        // disabled message -- the user cannot act on the latter here.
        let err = guard_write(false, false).unwrap_err();
        assert_eq!(err, LOCKED_MESSAGE);
    }

    #[test]
    fn removal_ok_when_unlocked() {
        // `guard_removal` takes no `branding_enabled` parameter at all --
        // unlike `guard_write`, a removal is permitted regardless of that
        // setting, so there is nothing else here to vary.
        assert!(guard_removal(true).is_ok());
    }

    #[test]
    fn removal_refuses_only_when_locked() {
        let err = guard_removal(false).unwrap_err();
        assert_eq!(err, LOCKED_MESSAGE);
    }
}
