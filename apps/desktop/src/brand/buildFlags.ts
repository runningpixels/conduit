/**
 * Build-time switches over the runtime branding feature -- Phase 6
 * white-label, Mode B (`docs/private/white-label-plan.md` §5 item 5).
 *
 * `allowUserBranding` mirrors `BrandRuntime.allow_user_branding`
 * (`crates/provider-core/src/schema.rs`): when a reseller's brand.md sets
 * `[runtime] allowUserBranding = false`, `scripts/apply-brand-identity.mjs`
 * writes `apps/desktop/branding.build.json`, which `vite.config.ts` reads
 * synchronously at config-eval time and bakes into the `__ALLOW_USER_BRANDING__`
 * define. That define is read in exactly one place -- here -- rather than at
 * every call site, so:
 *
 *   - vitest evaluates this same `vite.config.ts` for its own `test:` block,
 *     so `__ALLOW_USER_BRANDING__` IS defined there -- but
 *     `readAllowUserBranding()` special-cases `process.env.VITEST` (which
 *     vitest sets) to always bake in `true`, regardless of whatever
 *     `branding.build.json` a brand run may have left on disk in this
 *     checkout, so every test run is deterministic instead of depending on
 *     local leftovers. The `typeof` guard below exists for a genuinely
 *     undefined case instead: this module loaded outside a Vite-processed
 *     bundle entirely, where no bundler ever substituted the define;
 *   - a stock, non-white-labeled build (no branding.build.json on disk)
 *     defaults to `true` in both places `vite.config.ts` and here agree on,
 *     so nothing changes for Conduit's own build.
 *
 * This is a compiled-in constant, not a runtime setting: unlike everything
 * else under `apps/desktop/src/brand/`, there is no `set`/`reset` pair here,
 * because Mode B's whole point is that this cannot be toggled back on by
 * the shipped binary itself.
 */
declare const __ALLOW_USER_BRANDING__: boolean | undefined;

export const allowUserBranding: boolean =
  typeof __ALLOW_USER_BRANDING__ === 'boolean' ? __ALLOW_USER_BRANDING__ : true;
