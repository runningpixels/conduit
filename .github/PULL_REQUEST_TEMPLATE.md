<!--
Thanks for contributing. First-time contributors: a CLA bot will comment below
with a link to sign — see CONTRIBUTING.md for why.
-->

## What and why

<!-- What does this change, and what problem does it solve? Link any issue. -->

Closes #

## How it was verified

<!-- Say what you actually ran, not what the CI will run. -->

- [ ] `cargo test --workspace`
- [ ] `pnpm -C apps/desktop test`
- [ ] `pnpm -C apps/desktop check`
- [ ] Ran the app and exercised the change by hand

## Checklist

- [ ] Commits follow conventional-commit format (`feat:`, `fix:`, `docs:`, …)
- [ ] Tests added or updated
- [ ] Docs updated if behavior changed; ADR added/amended if a decision changed
- [ ] Generated schema bindings regenerated with
      `pnpm -C packages/config-schema build` (never hand-edited)
- [ ] No new migration edits an existing one — new migrations are additive only

## Trust boundary

<!-- Delete this section only if the change touches none of these. -->

- [ ] The renderer still holds no API key and makes no network call
- [ ] Model/connector output is still treated as untrusted (no
      `dangerouslySetInnerHTML` in the safe path)
- [ ] No telemetry, analytics, or background network call was introduced

## Anything else

<!-- Trade-offs, follow-ups, or things you'd like a closer look at. -->
