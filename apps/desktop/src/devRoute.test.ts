import { describe, expect, it } from 'vitest';
import { readDevRoute } from './devRoute';

/// The whole risk of a routing override is that it reaches production, where a
/// user could land on a screen they cannot leave. `import.meta.env.DEV` is a
/// Vite `define`, so the guard is compiled away rather than evaluated — which
/// means these tests run in DEV (vitest sets it) and pin the parsing, while the
/// production inertness is a build-time property, asserted in the last case by
/// the only thing a test here can check: that nothing but the known value is
/// ever returned.
describe('the dev route override', () => {
  it('recognises the one route it knows', () => {
    expect(readDevRoute('?route=onboarding')).toBe('onboarding');
  });

  it('is null when unset', () => {
    expect(readDevRoute('')).toBeNull();
    expect(readDevRoute('?locale=de')).toBeNull();
  });

  it('ignores a route it does not know, rather than routing somewhere odd', () => {
    // A typo, or a stale link, must land on the ordinary app — never on a
    // half-matched screen.
    expect(readDevRoute('?route=workspace')).toBeNull();
    expect(readDevRoute('?route=ONBOARDING')).toBeNull();
    expect(readDevRoute('?route=')).toBeNull();
  });

  it('finds the route beside other parameters', () => {
    // The layout suite pairs it with `?locale=`, so order must not matter.
    for (const q of ['?route=onboarding&locale=de', '?locale=de&route=onboarding']) {
      expect(readDevRoute(q)).toBe('onboarding');
    }
  });

  it('is read from a search string, which never carries the fragment', () => {
    /* `URLSearchParams` does not strip a `#fragment` — it is not part of the
     * grammar it parses, so `?route=onboarding#x` yields the value
     * `"onboarding#x"` and falls through to null. That is correct rather than a
     * bug, because the only caller passes `window.location.search`, which is
     * defined to exclude the fragment. Pinned so nobody "fixes" it by feeding
     * this a full href, where the failure would be silent. */
    expect(readDevRoute('?route=onboarding#x')).toBeNull();
  });
});
