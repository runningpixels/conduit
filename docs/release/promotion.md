# Update channels: promotion & rollback (Phase 6 M6.3)

Conduit ships two update channels: **stable** and **beta**. Each channel has its
own manifest at `<base>/<channel>/manifest.json`:

- `<base>/stable/manifest.json`
- `<base>/beta/manifest.json`

`<base>` is `https://runningpixels.github.io/conduit` (the static GitHub
Pages host; set in `apps/desktop/src-tauri/src/updater.rs::UPDATE_BASE` and
mirrored as the default endpoint in `tauri.conf.json::plugins.updater.endpoints`).

The client picks the channel via `AppSettings.updateChannel` (`Stable` | `Beta`).
`updater.rs::channel_url` builds the per-channel manifest URL; the consumer UI
(Settings → Updates) only offers Stable/Beta (`Pinned`/`TenantSpecific` are
reserved for Phase 7/8/9 and fall back to `stable` if they ever reach the
runtime). A stable-channel client never reads the beta manifest, and vice-versa —
the channels are isolated by URL path.

## Manifest generation

`scripts/generate-update-manifest.mjs --channel <stable|beta>` writes
`<outDir>/<channel>/manifest.json`. Each release's `manifest` job (`.github/
workflows/release.yml`) generates the manifest for the channel the release was
tagged for (prerelease tags + `nightly` → beta; plain `v*.*.*` → stable).

## Promotion: beta → stable

A beta build that has baked successfully is promoted to stable by **publishing
its manifest under the stable channel** — no rebuild, no re-sign. The bundle
assets already exist on the GitHub Release from the beta tag.

1. Confirm the beta release passed the [release checklist](./checklist.md)
   (update smoke on the beta channel, survival checks, diagnostics).
2. Copy the beta manifest to the stable path on the static host:
   ```sh
   # beta manifest → stable manifest (same payload, same signatures/URLs)
   cp <base>/beta/manifest.json <base>/stable/manifest.json
   ```
   The `version`, `pub_date`, `platforms[].signature`, and `platforms[].url`
   stay identical — only the channel path changes.
3. (Optional, for a clean history) tag the same commit as `v<version>` (a plain
   semver tag, no prerelease suffix) so the release is also discoverable as a
   stable tag. This is cosmetic; the manifest copy is what actually moves
   stable-channel clients onto the build.
4. Verify: a stable-channel client on the previous version sees the update via
   "Check now" and installs through the migration precheck.

## Rollback

To pull a bad release off a channel, **republish the previous good release's
manifest under the same channel file**. Tauri's updater only offers an update
when the manifest `version` is *higher* than the installed version, so
republishing an older manifest does not auto-downgrade clients that already took
the bad build — it stops new clients from seeing it. (True auto-downgrade is not
supported by the Tauri updater and is out of scope for Phase 6.)

1. Locate the previous good release tag's manifest (kept on the static host
   history or regenerable from its GitHub Release assets via
   `generate-update-manifest.mjs --channel <channel> --version <prev>`).
2. Overwrite `<base>/<channel>/manifest.json` with the previous good manifest.
3. For clients that already installed the bad build: ship a *new* (higher)
   patch release that rolls back the offending change, then promote it normally.
   The migration precheck + survival checks apply as usual.

## Known limitations / deferred

- **`min_app_version` gating is not implemented.** The Tauri 2 updater manifest
  schema has no standard minimum-version field, and the plugin parses the
  manifest internally (so a custom field isn't readable from `check_for_update`
  without a separate fetch). A version floor (refuse an update whose manifest
  declares a minimum above the installed version) is deferred to Phase 10, where
  it would pair with a small side-channel manifest fetch. Until then, every
  signed manifest is offered to every client on its channel regardless of how
  old the client is — acceptable because migrations are forward-only and the
  precheck refuses unsafe upgrades.
- **Auto-downgrade** is unsupported (above).
- **Custom domain** `updates.conduit.dev` is optional; the Pages URL is the
  default. Moving is a one-line change to `UPDATE_BASE` + `tauri.conf.json`.