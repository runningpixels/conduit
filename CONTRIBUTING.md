# Contributing to Conduit

Thanks for your interest. This document covers the practical setup and the few
rules that are genuinely load-bearing.

## Contributor License Agreement

Conduit requires a signed CLA before your first contribution can be merged. A
bot will comment on your first pull request with a link; signing takes one
comment.

**Why:** Conduit is AGPL-3.0-only, and the copyright holder offers a separate
commercial license to organisations that cannot use the AGPL. That dual-license
model only works if one party holds the rights to relicense. The CLA grants
those rights while leaving you full ownership of your contribution — you keep
the copyright and can reuse your work however you like. See
[`LICENSING.md`](./LICENSING.md).

If that is not acceptable to you, please open an issue to discuss the change
rather than sending a patch. A well-described bug report is genuinely valuable
and requires no CLA.

## Setup

Prerequisites and build steps are in the [README](./README.md#building-from-source).
In short:

```bash
pnpm install
pnpm dev
```

## The checks CI runs

Every one of these gates a merge. Run them before opening a PR:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm -C packages/config-schema check
pnpm -C apps/desktop check
pnpm -C apps/desktop test
```

A Husky pre-commit hook runs `cargo fmt --check` and the renderer typecheck on
staged files. Do not use `--no-verify`; if a hook fails, fix the cause.

## Rules that matter

These are architectural invariants, not style preferences. A PR that breaks one
will be asked to change regardless of how well it works.

### 1. The renderer never touches secrets or the network

The React side presents state and intent only. It must never hold an API key,
construct a provider request URL, or make an HTTP call. Credentials live in the
OS keychain and are read only in Rust; settings store a
`keychain://conduit/<provider>` reference, never a secret.

If you find yourself wanting `fetch()` in the renderer, the answer is a new
Tauri command. See [`docs/architecture/foundation-contracts.md`](./docs/architecture/foundation-contracts.md).

### 2. The Rust schema is the source of truth

`crates/provider-core/src/schema.rs` defines the on-wire types.
`packages/config-schema/src/generated/*.ts` is produced from it by ts-rs.

**Never hand-edit the generated bindings.** Change the Rust type, then:

```bash
pnpm -C packages/config-schema build
```

CI regenerates and fails if the committed output differs. Run the export from
the repo root — running it from inside `crates/provider-core/` writes a stray
duplicate tree (now gitignored).

### 3. Migrations are append-only and immutable once merged

sqlx records a checksum of every migration file in each user's database.
Editing a merged migration — including changing its line endings — breaks every
existing install with `migration N was previously applied but has been
modified`. Add a new migration instead.

If you must change one before release, regenerate the fixtures:

```bash
cargo run -p conduit-desktop --bin generate-migration-fixture
```

`.gitattributes` marks `migrations/**` as `-text` to keep their bytes stable.

### 4. Model output is untrusted

Anything from a provider or an MCP connector is untrusted input. Render it
through the safe renderers in `apps/desktop/src/artifacts/` — never
`dangerouslySetInnerHTML`. HTML artifacts go through `HtmlArtifactRenderer`,
which relies on a null-origin sandbox and a strict CSP; see
[`docs/adr/adr-007-artifact-rendering-security.md`](./docs/adr/adr-007-artifact-rendering-security.md)
before touching it. Tool output is redacted, size-capped, and never re-injected
into a prompt.

### 5. Local-first is a product invariant

No telemetry, no analytics, no background network calls. Update checks are
opt-in and send only a version string. A feature that phones home will not be
merged.

## Pull requests

- Branch from `main`, keep PRs focused.
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`,
  `test:`) — the release notes are generated from them.
- Add tests. Rust integration tests live in `apps/desktop/src-tauri/tests/`;
  renderer tests sit next to the component as `*.test.tsx`.
- Update docs when you change behavior. If you change an architectural
  decision, add or amend an ADR in `docs/adr/`.
- Say what you did and why. If you changed something security-relevant, say so
  explicitly.

## Reporting bugs

Use the issue template. It asks for a diagnostics bundle
(**Settings → Diagnostics → Export**), which is redacted before it is written —
but read it before attaching, and never paste an API key.

Security vulnerabilities go through [`SECURITY.md`](./SECURITY.md), not the
public tracker.
