# Shipping a rebranded build (Mode B)

This is for someone building Conduit from source to distribute under a
different name — a reseller or OEM producing their own installer. If you
just want to see the app under your own colours in your own copy, you don't
need any of this: use Settings → Branding instead, and see
[`README.md`](./README.md) for why that's a different, much cheaper thing.

Everything here builds on one `brand.md` — see [`README.md`](./README.md)
and [`brand.template.md`](./brand.template.md) for the format itself. This
document covers what's specific to producing something you hand to other
people: what a packaged build can change that Settings can't, why the update
mechanism is not optional, what the AGPL requires of you as a distributor,
and a checklist to run before you ship.

**A note on where this stands today:** the build-time pipeline that turns a
`brand.md` into a patched `tauri.conf.json`, generated CSS, regenerated
icons, and a built installer is under active development. The mechanism
described below — validate once in Rust, emit config + assets, then run the
normal build — is the shape it's being built to, but the exact command name
and flags aren't finalized as this is written. Where that's true below, it's
called out rather than guessed at. Check back here, or in the repository's
own release tooling, before treating a specific invocation as final.

## 1. What a packaged build changes that Settings can't

| | Settings → Branding (Mode A) | A packaged build (Mode B) |
|---|---|---|
| App icon / taskbar icon | No — can't touch the compiled-in icon set | Yes — regenerated from your logo |
| Installer name, `.exe`/`.app` name | No | Yes (`productName` in `tauri.conf.json`) |
| Bundle identifier (`com.example.app`) | No | Yes |
| Fonts | No — blocked by `font-src 'self'` in the content security policy | Yes — bundled into the build, so the policy is satisfied rather than bent |
| Update server + signing key | N/A | Yes — see §2, and it's required, not optional |

**What it still can't change, on purpose:** the on-disk data directory. Conduit
resolves its data directory via `directories::ProjectDirs`, and
`apps/desktop/src-tauri/src/paths.rs:34` calls it as
`ProjectDirs::from("com", "Conduit", app_name)` — the organisation qualifier
is the literal string `"Conduit"`, independent of whatever `app_name` a brand
supplies. That's why the Windows path is
`%LOCALAPPDATA%\Conduit\<app_name>\data` and the macOS bundle ID prefix stays
`com.Conduit.*` for this piece, regardless of branding.

This is a deliberate scope decision, not an oversight: changing the
organisation qualifier is a breaking migration for every existing install —
their data directory would silently become empty until something migrates it
across, and no such migration exists. A reseller building a genuinely new
product from a fresh install base could change it, but then a
Conduit-to-rebrand upgrade path stops existing for anyone who had Conduit
installed first. You will notice this constant if you go looking for it; it's
recorded here so you find it in a document instead of by diffing directory
listings. The guard test described in §5 keeps the exact string pinned so a
future refactor can't drift it silently.

## 2. The updater is not optional

A `[updater]` section in `brand.md` — your own manifest endpoint and your own
minisign public key — has to be part of any Mode B build. The reasoning is
in the codebase's own words. `apps/desktop/src-tauri/src/updater.rs` (lines
51–54) says, about the update host:

> Resolved update host. Forks MUST point this at their own infrastructure
> rather than inherit upstream's — set `CONDUIT_UPDATE_BASE` at build time.
> Under the AGPL every fork ships this source, so a hardcoded endpoint would
> otherwise make every downstream build phone home to upstream.

Two separate failures follow from skipping this:

- **An inherited endpoint** means your build polls Conduit's own update
  manifest (`https://runningpixels.github.io/conduit/<channel>/manifest.json`
  by default — see `DEFAULT_UPDATE_BASE` in `updater.rs`) for updates that
  were never meant for your users, and never will offer them yours.
- **An inherited public key** means your build can't verify its own
  releases even if you did stand up your own manifest server, because the
  Ed25519/minisign key baked into the app is Conduit's, not yours.

Because of that, a missing `[updater]` section in a Mode B `brand.md` is meant
to fail the build outright, not just warn — this is one of the few places in
the whole branding format where silently falling back to the built-in value
would be actively unsafe rather than merely wrong-looking. (As noted at the
top of this document, the build-time enforcement of that hard-fail is still
being built; treat the requirement itself — every distributed build carries
its own endpoint and its own key, full stop — as binding regardless of
whether the check has landed yet.)

### It lives in two places, and both need patching

The endpoint is set through two different mechanisms, and they don't share
one source of truth:

| Mechanism | What it controls | Where |
|---|---|---|
| `CONDUIT_UPDATE_BASE` | A build-time environment variable compiled into the binary (`option_env!`); it's what `check_for_update` and `download_and_install_update` use to build the manifest URL at runtime | Set at build time — no config file |
| `plugins.updater.endpoints` / `plugins.updater.pubkey` | Tauri's own updater-plugin config; `pubkey` is what every downloaded update payload is verified against | `apps/desktop/src-tauri/tauri.conf.json` |

`CONDUIT_UPDATE_BASE` has env-var indirection built in; the `tauri.conf.json`
fields don't — they're plain JSON that has to be edited (or generated) per
build. A build that patches one and misses the other is the worst outcome:
it looks correctly branded, checks a URL that may or may not be reachable,
and either can't verify its own signatures or silently accepts Conduit's.
Both need to point at your infrastructure and your key.

### Generating your own signing key

Tauri's updater uses a minisign (Ed25519) keypair. Generate one with Tauri's
own CLI (`tauri signer generate`); the private key is what CI needs to sign
release payloads (`TAURI_SIGNING_PRIVATE_KEY` /
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` in Conduit's own release workflow are the
pattern to follow), and the public key is what goes into
`plugins.updater.pubkey` in `tauri.conf.json`.

The private key must never be committed. `.gitignore:14-15` already excludes
Conduit's own key files by name:

```
apps/desktop/src-tauri/.tauri-updater-private.key
apps/desktop/src-tauri/.tauri-updater-private.key.pub
```

If you generate your key under a different filename, add it to your own
`.gitignore` the same way — the private key belongs in a secrets store (CI
secrets, a password manager), never in the repository, on either side of a
fork.

## 3. Licensing

Conduit is licensed **AGPL-3.0-only** (see [`LICENSE`](../../LICENSE) and
[`LICENSING.md`](../../LICENSING.md)). What follows describes obligations the
licence text itself states; it is not legal advice, and it does not resolve
every judgment call a white-label programme raises. Where a decision depends
on your specific distribution model, that decision is yours and your
counsel's to make — this document flags where those decisions live rather
than making them for you.

**The mechanics, plainly:**

- A rebranded build is a modified copy of Conduit's source. Distributing it
  to others — an installer, a download link, anything that leaves your own
  machines — is distributing a derivative work under the AGPL, and the
  obligation to make corresponding source available follows the binary,
  the same as it would for an unmodified build.
- The AGPL's distinguishing clause (section 13) also applies if a modified
  version is run as a network service rather than shipped as a desktop
  installer: users interacting with it over a network are entitled to that
  version's source, the same as a recipient of the binary would be.
  `LICENSING.md` states this for Conduit itself; it applies identically to a
  modified, rebranded copy.
- None of this is contingent on how much was changed. A rebrand — name,
  colours, icon, updater endpoint — is a modification like any other for
  this purpose.

**Where the licence stops, and a separate question starts:** the AGPL governs
the *code*. It does not grant, and does not need to say anything about, the
right to use the name "Conduit" or its marks — trademark and the licence are
different bodies of law. Where the line sits for a white-label programme
(what a reseller may call their build, whether "Conduit" may appear in
metadata a user never sees, and similar questions) is not something the
AGPL answers and not something this document decides. That's a question for
the project owner and their counsel.

**One thing to check before shipping, not decide here:** [`LICENSING.md`](../../LICENSING.md),
[`NOTICE`](../../NOTICE), and [`THIRD-PARTY-NOTICES.md`](../../THIRD-PARTY-NOTICES.md)
all name Conduit specifically — copyright lines, the project name in
attribution text, and the AGPL notices the licence itself requires be
preserved. A shipped rebrand needs a documented position on what in those
three files may be rewritten (a reseller's own product name in prose) versus
what must not be (the copyright holder's name, the licence grant itself, the
attributions the licence and third-party licences require). That position
belongs to you; it isn't inferred by this pipeline and isn't asserted here.

## 4. Checklist

Run this end to end for every build you intend to distribute, not just the
first one — a config regression here ships silently, because none of these
failure modes crash the app.

- [ ] `brand.md` has a complete `[bundle]` section — `productName`,
      `identifier`, and the rest are what end up on the installer and in the
      Start-menu entry / `.app` bundle. Check the built installer's filename
      and the app's own title bar, not just the config file.
- [ ] `[updater]` is present with **your** `endpoint` and **your** `pubkey` —
      never left blank, never copy-pasted from a Conduit example. After the
      build, confirm both places from §2 agree: the env var the build was
      compiled with, and the `pubkey`/`endpoints` baked into the shipped
      `tauri.conf.json`.
- [ ] **Verify the updater against your own manifest, not Conduit's.** Point
      a test build at your endpoint and confirm it actually resolves and
      serves a manifest signed with your key — a build that silently falls
      back to Conduit's default host is the single most expensive mistake to
      discover after release, because every installed copy is already
      phoning home to the wrong place.
- [ ] Icons were regenerated from your logo for this build — check the
      taskbar/dock icon and the installer icon, not just that a logo file
      exists in `brand.md`. A stale or default icon usually means the icon
      step was skipped, not that it silently failed.
- [ ] If you don't want end users re-branding your build back out from
      inside the app, `[runtime] allowUserBranding = false` is set — and
      confirm Settings → Branding is actually gone (or inert) in the built
      app, not just that the flag is set in `brand.md`.
- [ ] `[fonts]`, if set, actually shipped — check the running app's fonts,
      not just that the files were listed.
- [ ] Both palettes (`[palette.dark]` and `[palette.light]`) are complete if
      either is set at all — a half-specified pair produces unreadable text
      in whichever theme wasn't overridden, not an obvious error.
- [ ] You have a documented position on §3 — what LICENSING.md/NOTICE/
      THIRD-PARTY-NOTICES.md say in your distribution, and how your build
      satisfies the AGPL's source-availability obligation for a modified
      work (a public fork, a source archive alongside the installer,
      whatever your model requires).

## 5. What stays Conduit's, regardless of branding

A handful of strings are wire or protocol identity — something outside the
app (an update server, an MCP connector, a third-party HTTP endpoint) may
parse or key on the exact value — rather than display identity a brand
should own. These are deliberately excluded from both modes:

| String | Where | Why it doesn't rebrand |
|---|---|---|
| `Conduit-Updater/<version>` | Update-check `User-Agent` header (`apps/desktop/src-tauri/src/updater.rs:88`) | The update server (or an operator reading its access logs) identifies the client by this string; changing it per-fork is an update-channel break, not a cosmetic rename |
| `ClientInfo.name = "Conduit"` | MCP `initialize` handshake sent to every connector server (`apps/desktop/src-tauri/src/connector_runtime/mod.rs:103`) | Identifies the client to the connector, not the user; some MCP servers allowlist or log by this field |
| `User-Agent: Conduit/1.0` | Outbound HTTP requests from agent tools — e.g. artifact link fetches (`apps/desktop/src-tauri/src/agent_tools.rs:1310` and `:1419`) | Third-party servers and their rate limiters key off this string |
| `ProjectDirs::from("com", "Conduit", …)` | The data-directory organisation qualifier (`apps/desktop/src-tauri/src/paths.rs:34`) | Covered in §1 — changing it is a breaking data-directory migration for existing installs, not a display-name change |

This isn't a gap in the branding feature; it's the boundary the feature is
scoped to. Everything in this table is enforced by a test — Guard G9,
`apps/desktop/src/brand/brandLiterals.test.ts` — which scans the renderer and
Rust source for the bare literal `"Conduit"` outside comments and fails on
any occurrence that isn't in its allowlist. That allowlist is a table of
exactly `{ file, pattern, reason }` entries, one per row above, and the test
asserts both directions: no *new* literal slips in unnoticed, and none of
these four is accidentally reworded out of the allowlist without the table
being updated to match — so if one of these strings ever needs to change,
the change and the reasoning travel together in one place, not as a stray
edit nobody reviewed for its wire-protocol consequences.
