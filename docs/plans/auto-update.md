# Plan: Automatic update checks and staged installs

## Status

**Implemented.** All six phases landed. `cargo fmt --all --check`, `cargo clippy
--workspace --all-targets -- -D warnings` and `cargo test --workspace` are
clean; `pnpm -C apps/desktop check` (`tsc -b`) is clean; `pnpm -C apps/desktop
test` is green at 1429 passed / 4 skipped (up from 1402 — 27 new tests);
`pnpm i18n:check` and `i18n:status` are OK at 1094 keys × 8 locales with zero
missing, stale or orphaned.

### What shipped

| File | Change |
| --- | --- |
| `provider-core/src/schema.rs` | New `UpdatePolicy` enum; `update_policy` on `AppSettings` + `SettingsPatch`; four back-compat tests |
| `provider-core/examples/export_ts.rs` | Exports the new enum |
| `src-tauri/src/updater.rs` | `build_updater` + `fetch_update` extracted; `StagedUpdate` state; `stage_update`, `get_update_status`, `install_staged_update`; `automatic_install_supported`; last-check record |
| `src-tauri/src/main.rs` | Manages `StagedUpdate`; registers the two new commands; installs staged payload last in teardown |
| `src-tauri/src/state.rs` | `update_policy` patch arm |
| `src/updates/useUpdateScheduler.ts` | New — the renderer-side schedule |
| `src/updates/useUpdateScheduler.test.ts` | New — 15 tests over the decision table |
| `src/App.tsx` | Mounts the scheduler |
| `src/workspace/settings/UpdatesSection.tsx` | Policy select, last-checked, staged notice |
| `src/onboarding/PrivacyStep.tsx` | Policy select beside the existing toggle |
| `src/ipc/{client,contracts}.ts` | `stageUpdate`, `getUpdateStatus`, `UpdateStatus`, `UpdatePolicy` |
| `i18n/messages/*.json` | 7 new keys, 2 reworded — 8 locales, hand-translated |
| `README*.md` (8) | The "no telemetry" bullet now covers automatic updates |
| `conduit-website-internal/PLAN.md` | Truth-table row, safe-claims line, FAQ answer |
| `docs/release/checklist.md` | Automatic-update smoke section |

Two deviations from the plan as written, both deliberate:

1. **Staging holds the payload in memory, not on disk.** The plan reserved
   `AppPaths.updates` for the staged bytes. Writing an installer-sized blob
   there would have bought staleness, cleanup and disk-usage problems for no
   gain: the quit that applies an update is the one ending the session that
   staged it. `AppPaths.updates` is still used — for the `last-check.json`
   record, which does need to outlive the session.
2. **A Linux `.deb` build does not offer `automatic` at all.** The plan left
   this open. `install_deb` shells out to `dpkg -i` through `pkexec`
   (`tauri-plugin-updater-2.10.1/src/updater.rs:1112`), so applying at quit
   would raise a graphical sudo prompt after the window is gone, with nothing
   on screen to explain it. `automatic_install_supported()` gates the option
   out of the UI and refuses in `stage_update`; AppImage, Windows and macOS
   are unaffected.

This plan added *automatic* update checking and installation on top of the
Phase 6 updater, which already shipped. It is deliberately small on the Rust
side: the network path, signature verification, channel resolution and the
migration precheck all exist and are not re-litigated here. What does not
exist is anything that calls them without a user clicking a button.

Scope is `apps/desktop/src/` (a scheduler hook and two UI controls),
`crates/provider-core/src/schema.rs` (one enum, one field), a small refactor
in `apps/desktop/src-tauri/src/updater.rs`, and — the part that is easy to
under-budget — the copy and claims work in [Phase E](#phase-e--copy-and-claims).

### What already exists

Everything except the scheduling. Worth reading before touching any of it:

| File | What it already does |
| --- | --- |
| `src-tauri/src/updater.rs` | `check_for_update` + `download_and_install_update`; channel URL resolution; `Conduit-Updater/<version>` UA; the migration precheck |
| `.github/workflows/release.yml` | 4-platform build via `tauri-action`, Ed25519 payload signing, manifest generation, GitHub Pages publish |
| `scripts/generate-update-manifest.mjs` | Builds the per-channel manifest from signed artifacts |
| `settings/UpdatesSection.tsx` | Channel select, allow-checks toggle, "Check now", "Download & install" |
| `onboarding/PrivacyStep.tsx` | The "Allow update checks" checkbox and channel select, in 8 locales |
| `docs/adr/adr-008-*.md` | Why `updater:default` is omitted from the capability file |

`check_for_update` has exactly one call site: the "Check now" button. That is
the whole gap.

## The constraint this plan exists under

`schema.rs:1753` currently documents the product position:

> `update_check_enabled` — *"Defaults `true` but is a checkbox — updates are
> never automatic."*

That position is repeated in four shipped surfaces, and automatic updating
falsifies all four:

| Surface | Claim that stops being true |
| --- | --- |
| `i18n/messages/*.json` — `settings.updates.disclosure.body` | "checks for updates **only when you choose** — there is no background telemetry" |
| `i18n/messages/*.json` — `onboarding.welcome.lede` | "you will **always be asked** before an update is applied" |
| `README.md:44` + 7 translated READMEs | "**No telemetry.** Update checks are opt-in" |
| `conduit-website-internal/PLAN.md` | truth-table row and the "Does it phone home?" FAQ |

So Phase E is not cleanup to be done if there is time. It is the phase that
keeps the product honest, and the feature is not shippable without it.

Two consequences that constrain every decision below:

1. **`Manual` is the default, for new and existing installs alike.** Nobody is
   silently upgraded into background network access.
2. **The hard off-switch survives.** `update_check_enabled: false` continues to
   mean no network call under any circumstance, including from the scheduler.

## Design

### One enum beside the existing flag, not a replacement

```rust
/// How the app acts on updates *on its own*. Orthogonal to
/// `update_check_enabled`, which remains the hard off-switch: when that is
/// false nothing here runs and no request is made.
pub enum UpdatePolicy {
    /// Today's behaviour, unchanged. Only the explicit "Check now" button
    /// reaches the network.
    Manual,
    /// Check on a schedule; surface a toast when something is found. Installing
    /// stays a deliberate click.
    Notify,
    /// Check on a schedule, verify and stage the payload, and apply it the next
    /// time the user quits.
    Automatic,
}
```

Replacing `update_check_enabled` with a 4-variant enum was considered and
rejected. Keeping the boolean preserves the "no network at all" guarantee
verbatim, keeps its tests and its disclosure copy meaningful, and reuses the
pattern already established in both `UpdatesSection.tsx` and `PrivacyStep.tsx`,
where the channel select is disabled by the checkbox rather than folded into it.

There is **no settings migration runner** — `#[serde(default)]` is the entire
back-compat story (`schema.rs:1793-1795`). `UpdatePolicy::Manual` as the serde
default is therefore also the upgrade path: an existing `settings.json` with no
`updatePolicy` key deserializes to exactly today's behaviour.

### Schedule from the renderer, not from Rust

**The app uses no Tauri events.** There is no `.emit()` in the Rust tree and no
`listen()` in the renderer; all streaming goes through renderer-initiated
`tauri::ipc::Channel` (`commands/chat.rs:100`). A Rust background task in
`.setup()` would therefore have to introduce an event channel *and* a way to
ask whether a stream is in flight before it could restart anything.

A renderer-side scheduler needs neither. It calls the existing command, so Rust
still owns every byte of network I/O and the architectural promise in
`README.md:29-31` is untouched. And because it lives where stream state already
is, "don't interrupt an active conversation" falls out for free rather than
needing new plumbing.

The tradeoff — checks only happen while the window is alive — is correct for a
desktop chat client that has no background service and should not grow one.

### Applying on quit

`download_and_install_update` currently ends in `app.restart()`. For `Automatic`
that is the wrong ending: it would kill in-flight streams. The install is split
so the payload can be verified and staged without restarting, and the swap
happens on the quit the user chose to perform.

`RunEvent::ExitRequested` in `main.rs:198` already exists as the app-exit hook —
the connector shutdown backstop lives there — so this is an addition to an
established teardown path rather than a new lifecycle concept.

## Phases

### Phase A — schema

- `crates/provider-core/src/schema.rs`: add `UpdatePolicy` (serde
  `rename_all = "camelCase"`, `#[derive(TS)]`), `update_policy: UpdatePolicy`
  with `#[serde(default)]` on `AppSettings`, the field in the `Default` impl,
  and `update_policy: Option<UpdatePolicy>` on `SettingsPatch`.
- `crates/provider-core/examples/export_ts.rs`: add the new enum. Field
  additions re-export with their struct; a brand-new top-level type does not.
- `apps/desktop/src-tauri/src/state.rs`: the patch arm, beside the existing
  `update_check_enabled` one at `state.rs:348-349`.
- Regenerate: `cargo run --example export_ts -p provider-core`. CI gates
  binding freshness, so the generated files must be committed.
- Test: a settings blob with no `updatePolicy` key deserializes to `Manual`,
  mirroring `settings_json_without_language_key_defaults_to_system`
  (`schema.rs:1988-2028`).

### Phase B — Rust

- Extract `fetch_update(app, settings) -> Result<Option<UpdateInfo>, String>`
  from `check_for_update` so the command and any future caller share one path,
  including the `update_check_enabled` early return.
- Split the install: `stage_update` runs the migration precheck, downloads and
  verifies, and returns without restarting; `download_and_install_update` keeps
  its current behaviour by calling `stage_update` then `app.restart()`, so the
  existing button and its tests are unaffected.
- Record the staged version and a `last_checked` timestamp under
  `AppPaths.updates` (`paths.rs:18`) — the directory is already created at
  `paths.rs:51` and is currently unused.
- `main.rs` `RunEvent::ExitRequested`: if a staged payload is present, apply it
  during teardown, after `mgr.shutdown_all()`.
- Tests alongside the existing `channel_url` ones: `fetch_update` makes no
  request when checks are disabled; `stage_update` refuses when the precheck
  refuses; staging does not restart.

### Phase C — renderer scheduler

`apps/desktop/src/chat/useUpdateScheduler.ts` (new), mounted from `App.tsx`:

- No-op unless `updateCheckEnabled && updatePolicy !== 'manual'`.
- First check ~60s after launch, so startup is never blocked by it; then every
  24h, **with jitter** — every client waking on the same wall-clock cadence
  would pile onto GitHub Pages.
- Persist `last_checked` through Rust so an app opened twenty times a day
  checks once, not twenty times.
- `Notify`: surface through the existing `ToastStack.tsx` (`StatusState`,
  already wired in `App.tsx`).
- `Automatic`: call `stage_update`, then toast that the update applies on next
  quit. Never while a stream is active — defer to the next tick.
- Background failures log and stay silent. Only the explicit "Check now" path
  surfaces errors, which is what `UpdatesSection.tsx` already does.

### Phase D — UI

- `settings/UpdatesSection.tsx`: a three-way policy control below the existing
  checkbox, `disabled={!settings.updateCheckEnabled}` exactly as the channel
  select already is. Show "last checked" and, when one is staged, "update
  applies when you quit".
- `onboarding/PrivacyStep.tsx`: the same control, replacing the bare checkbox,
  written through the existing `set('updatePolicy', …)` helper in
  `persistSteps.ts` — no new persistence plumbing.
- Both use the established `label.onboarding-check` / plain `<select>` idiom.
  There is no design-system `Toggle` or `RadioGroup` and this is not the change
  that should introduce one.

### Phase E — copy and claims

The phase that keeps the four surfaces above true.

- Rewrite `settings.updates.disclosure.body` so it states the schedule as well
  as the payload, and `onboarding.welcome.lede` so it no longer promises the
  user is always asked. Both should stay accurate under all three policies
  rather than branching per policy.
- `README.md:44-45` and the 7 translated READMEs: "opt-in" remains true because
  `Manual` is the default, but automatic updating needs saying out loud.
- Add the new keys to all 8 locale catalogs plus `provenance.json`; run
  `pnpm i18n:check` and `pnpm i18n:status` to zero.
- `conduit-website-internal/PLAN.md`: update the truth-table row and the "Does
  it phone home?" FAQ answer.
- `uiCrossReferences.test.ts` enforces that prose naming a control matches that
  control's real label, so it moves with the copy.
- Update the `schema.rs:1753` doc comment, which currently asserts the opposite
  of what the code will do.

### Phase F — tests and release

- Scheduler decision table: off / `Manual` / `Notify` / `Automatic` × update
  available or not × stream active or not.
- Autosave test for the new control in `SettingsSheet.behaviour.test.tsx`,
  following the `localOnly` toggle test at lines 117-124.
- `docs/release/checklist.md`: an automatic-update smoke step — stage on
  version *n*, quit, confirm *n+1* on relaunch with the local store intact.

## Deferred, with reasons

**OS code signing stays out of scope.** Bundles continue to ship without
notarization or Authenticode, as documented in `release.yml:19-22` and
`docs/release/checklist.md:11-12`. This is a real cost here and should be
recorded rather than glossed: a manual download trades one Gatekeeper or
SmartScreen prompt for a deliberate user action, whereas `Automatic` produces
that prompt on a schedule the user did not initiate. It is the main reason
`Automatic` should not become a default later without signing landing first.
Track it as the gate on any future default change.

**`min_app_version` manifest gating** remains unimplemented (`promotion.md`).
The migration precheck covers the failure it would prevent — an old client
jumping many versions onto a store that cannot migrate forward — so this stays
deferred, but it is the cleaner gate of the two.

**Linux `Automatic`** needs a decision during Phase C: `.deb` cannot self-update
and AppImage only can when the file is writable. Expect to hide or disable the
policy per package format rather than let it fail silently at stage time.
