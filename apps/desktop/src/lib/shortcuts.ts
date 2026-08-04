/**
 * Platform-correct keyboard shortcut hints.
 *
 * Every visible hint in the product was hardcoded to the macOS glyphs — the
 * command entry read "⌘K" and the sidebar "⌘N" while running on Windows, where
 * the binding is Ctrl. `modShortcutHint` also existed twice, in App.tsx and
 * DocumentPanel.tsx, so the platform check lives here once.
 *
 * The bindings themselves are unchanged: useHotkeys matches on
 * `event.metaKey || event.ctrlKey`, so both modifiers already work on both
 * platforms. This module only decides which one to *show*.
 */

/**
 * True on macOS. `navigator.platform` is deprecated but still the most
 * reliable signal inside WebView2/WKWebView, with the UA string as fallback;
 * `navigator` itself is guarded for the non-DOM test environments.
 */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** The modifier glyph for the primary accelerator: `⌘` on macOS, `Ctrl` else. */
export function modKey(): string {
  return isMacPlatform() ? '⌘' : 'Ctrl';
}

/**
 * A full hint for the primary accelerator plus `key`, e.g. `⌘J` / `Ctrl+J`.
 * macOS sets glyphs solid; Windows and Linux join with `+`.
 */
export function modShortcutHint(key: string): string {
  return isMacPlatform() ? `⌘${key}` : `Ctrl+${key}`;
}

/** As `modShortcutHint`, with Shift: `⌘⇧F` / `Ctrl+Shift+F`. */
export function modShiftShortcutHint(key: string): string {
  return isMacPlatform() ? `⌘⇧${key}` : `Ctrl+Shift+${key}`;
}
