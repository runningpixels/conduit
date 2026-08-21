import { describe, it } from 'vitest';

/// Boundary placeholder (M6, plan §7). jsdom cannot enforce the iframe sandbox
/// or CSP, so behavioral isolation (a script inside the artifact actually being
/// blocked from `parent.document`, `fetch`, `window.open`, top navigation, and
/// remote `img` loads) is NOT testable here. Those assertions require a real
/// browser (Playwright) and are tracked as a future gap in
/// `docs/decisions/artifact-rendering-security.md`.
///
/// The structural guarantees that ARE testable in jsdom live in
/// `HtmlArtifactRenderer.test.tsx` (sandbox attr value, srcdoc assembly, CSP
/// meta placement, no `__TAURI__`). This file documents the non-goal boundary
/// and is intentionally skipped.

describe('artifact isolation (real-browser only)', () => {
  it.skip('artifact script cannot access parent.document (sandbox null origin)', () => {
    // Playwright: load an html artifact whose script reads parent.document;
    // assert it throws / gets a null origin.
  });

  it.skip('artifact script cannot fetch() (connect-src none)', () => {
    // Playwright: assert a fetch() inside the iframe is blocked by CSP.
  });

  it.skip('artifact cannot top-navigate or open popups', () => {
    // Playwright: assert top navigation + window.open are blocked.
  });

  it.skip('window.__TAURI__ is undefined inside the artifact iframe', () => {
    // Playwright: evaluate inside the iframe that window.__TAURI__ is undefined.
  });
});