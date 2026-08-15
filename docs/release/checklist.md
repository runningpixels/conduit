# Release checklist (Phase 6)

The bar a Conduit release must clear before it ships. Used by M6.6's release
quality gate; expanded there with automated survival/migration checks.

## Scope

- **Channels:** `stable` and `beta`. A prerelease tag (`v1.2.3-beta.1`, `-rc.1`,
  `-nightly`) or the `nightly` branch routes to **beta**; a plain `v*.*.*` tag
  routes to **stable**. See `.github/workflows/release.yml`.
- **OS signing: deferred.** Bundles ship **unsigned** at the OS level
  (macOS notarization / Windows Azure Trusted Signing / Linux GPG are Phase 9/10).
  First-run Gatekeeper / SmartScreen prompts are expected and documented. The
  updater payload itself is still signature-verified (Ed25519 minisign keypair:
  private key in CI secrets, pubkey in `tauri.conf.json`).
- **No versioning/restore** of artifacts (single-payload model, ADR-002 override).

## Supported platforms (Phase 6)

- **Windows:** 10 and 11 (x86_64). NSIS `currentUser` installer.
- **macOS:** 11 (Big Sur) and later (`minimumSystemVersion` = `11.0`); Universal
  (`aarch64` + `x86_64`) `.dmg`/`.app`.
- **Linux:** Ubuntu 20.04+ `.deb` + `.AppImage` (x86_64). Other distros
  best-effort via AppImage.
- A platform outside this list is not blocking for a beta but is noted in the
  release notes.

## Pre-release

- [ ] `cargo test --workspace` green (incl. `previous_tag_db_migrates_forward`,
      `local_data_survival`, `diagnostics_export`, updater precheck tests).
- [ ] `pnpm -C apps/desktop test` (vitest) green.
- [ ] `pnpm -C apps/desktop check` (`tsc -b`) clean.
- [ ] `pnpm -C packages/config-schema build` + `check` — schema bindings fresh
      (no committed drift).
- [ ] `cargo fmt --all --check` + `cargo clippy --workspace --all-targets -- -D warnings`.
- [ ] Release-tag fixture present in `apps/desktop/src-tauri/tests/fixtures/db/`
      (generated via `tests/fixtures/regenerate.sh`); `previous_tag_db_migrates_forward`
      green against it.

## Build + sign + manifest (CI: `release.yml`)

- [ ] Tag pushed (`v*.*.*` for stable, `v*.*.*-<pre>` / `nightly` for beta).
- [ ] `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` present
      in GitHub Actions secrets (never in the repo).
- [ ] Matrix build (ubuntu/macos-aarch64/macos-x86_64/windows) green; each
      platform produced an updater-signed bundle + `.sig`.
- [ ] GitHub Release created with all bundle assets attached.
- [ ] `manifest` job generated `<channel>/manifest.json` and attached it.
- [ ] **No** notarization / signtool / GPG step ran (deferred — confirm absence).

## Host the manifest

- [ ] Copy `manifest-<channel>/manifest.json` to the static host at
      `<base>/<channel>/manifest.json` (GitHub Pages:
      `https://tobiaz.github.io/conduit/<channel>/manifest.json` —
      matches the `tauri.conf.json` `plugins.updater.endpoints` + `updater.rs`
      `UPDATE_BASE`). Manual for Phase 6; automated in Phase 10.
- [ ] Verify the manifest URL is reachable over HTTPS from a clean machine.

## Update smoke (per channel)

- [ ] A clean-machine install of the **previous** build, on the release channel,
      finds the new manifest via "Check now".
- [ ] "Download & install" runs the migration precheck on a copy of the local
      DB and **passes** for a healthy store.
- [ ] The update applies (passive install → user confirms) and restarts into the
      new version.
- [ ] The precheck **refuses** with a user-safe message over a deliberately
      broken store, and the live store is untouched.

## Local-data survival (in-place upgrade)

- [ ] `settings.json` (incl. `encryptionAtRest`, `onboardingCompleted`,
      `updateChannel`, `updateCheckEnabled`) survives the upgrade.
- [ ] `conduit.sqlite` survives (schema forward-migrates; no recovery triggered).
- [ ] Attachments + artifacts (content-addressed blobs) survive.
- [ ] OS keychain credential survives (app re-reads it on relaunch).

## Diagnostics

- [ ] Settings → Diagnostics: export with `diagnosticsEnabled` on writes a file
      under `paths.exports`, shows the path, "Reveal" works.
- [ ] Export with `diagnosticsEnabled` off is refused with a clear message.
- [ ] Bundle contains NO secrets, NO base URLs, NO allowlists, NO conversation
      content (only redacted paths + active provider/model/toggles/theme).

## Known limitations (documented, accepted for the beta)

- Unsigned OS bundles → first-run Gatekeeper / SmartScreen prompts.
- E2E harness deferred to Phase 10; coverage is vitest + Rust integration + this
  manual smoke.
- Release-tag fixture presence is a manual checklist item (automated in Phase 10).
- `min_app_version` gating is deferred (M6.3+); the manifest carries no minimum.