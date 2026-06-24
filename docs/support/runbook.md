# Support runbook — Conduit diagnostics export

Phase 6 M6.5. The diagnostics export is the single, privacy-safe artifact a
user can attach to a support request. This runbook is what maintainers follow
when triaging a bug report, and what the in-app Diagnostics section points at.

## What a diagnostics bundle is

A JSON file written to the user's local **exports** folder
(`<app-data>/exports/diagnostics-<unix>.json`). It is produced by
`conduit_desktop::diagnostics::export` and surfaced in **Settings →
Diagnostics → Export diagnostics**.

### What it INCLUDES

- `settings.activeProvider` + `settings.activeModel`
- `settings.localOnly`
- `settings.diagnosticsEnabled`
- `settings.theme`
- `paths.*` — the Conduit app paths, **with the user's home directory prefix
  replaced by `~/`** so the local username is not leaked. `redacted_fields`
  lists which path entries were actually redacted.

### What it NEVER includes (hard guarantees)

- **No secrets or API keys** — provider credentials live in the OS keychain and
  are never read into the export.
- **No provider base URLs** — `providerEndpoints` is omitted.
- **No artifact remote allowlists** — `artifactRemoteAllowlist` is omitted.
- **No conversation or message content** — the export does not touch the
  conversations or messages tables.

If a bundle is suspected to contain any of the above, treat it as a
**security bug** and follow the security disclosure process, not this runbook.

## Triggering an export

1. Open **Settings**.
2. Ensure **Enable diagnostics export** is checked. If it is off, the Export
   button is disabled with the helper text "Enable diagnostics above to export a
   support bundle." The Rust side also refuses (`diagnostics::export` returns an
   `Err` when `diagnostics_enabled` is false), so a stale UI cannot bypass the
   gate.
3. Click **Export diagnostics**.
   - On the **first** export, a confirmation dialog summarizes what is and is
     not included. The user must accept; the acknowledgement is persisted
     once-ever (`diagnosticsDisclosureAcknowledged` in raw settings JSON) so
     subsequent exports skip the prompt. Cancelling aborts — nothing is written.
4. The export path is shown (copyable). **Reveal in folder** opens the exports
   directory in the OS file manager (Finder/Explorer) via `tauri-plugin-shell`.

## Safe reproduction instructions (ask the user for these)

A useful report has all of:

- **OS + version** (Windows 10/11, macOS 11+, Ubuntu 20.04+/deb).
- **Conduit version** (Settings → About, or the version in the export's
  sibling release manifest).
- **Active provider + model** (in the bundle).
- **Connector(s) involved** (name + version, if the issue is connector-related).
- **Artifact kind** (`text` / `json` / `html` / `file`) if the issue is
  artifact-related. **Do not** ask for artifact *content*.
- **Steps to reproduce** — concrete, minimal.
- **The diagnostics bundle** attached, with the disclosure acknowledged.

## Rollback / known issues

- **A bad update that the migration precheck would have caught** never reaches
  the user: `download_and_install_update` runs the precheck on a copy of the
  local DB and refuses on failure. If a user is on a broken build, the rollback
  path is in [`docs/release/promotion.md`](../release/promotion.md)
  (republish the previous tag's manifest under the same channel file).
- **Migration recovery at startup**: if a migration failed on launch, Conduit
  rolls back to a fresh store with a `.corrupt-<unix>.bak` backup and surfaces a
  `MigrationRecovery` notice. The backup path is the first thing to ask for if
  the user reports missing data after an upgrade.
- **Local-data survival** across an in-place upgrade is covered by the release
  checklist in [`docs/release/checklist.md`](../release/checklist.md)
  (settings.json + conduit.sqlite + attachments + artifacts must survive).

## Pointer for the release quality bar

The full per-release smoke (supported OS versions, forward-migration fixture,
update smoke on stable + beta, local-data survival, diagnostics export
verification) lives in
[`docs/release/checklist.md`](../release/checklist.md). Run it for every
release tag.