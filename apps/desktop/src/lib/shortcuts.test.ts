import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMacPlatform, modKey, modShiftShortcutHint, modShortcutHint } from './shortcuts';

/**
 * jsdom reports a Linux-ish platform by default, so each case pins the value
 * it needs. `platform` is read-only on the real Navigator, hence defineProperty.
 */
function setPlatform(platform: string, userAgent = '') {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('platform detection', () => {
  it.each(['MacIntel', 'iPhone', 'iPad'])('treats %s as mac', (platform) => {
    setPlatform(platform);
    expect(isMacPlatform()).toBe(true);
  });

  it.each(['Win32', 'Linux x86_64'])('treats %s as non-mac', (platform) => {
    setPlatform(platform);
    expect(isMacPlatform()).toBe(false);
  });

  // Chromium is freezing navigator.platform to the empty string, so the UA has
  // to be able to carry the answer on its own.
  it('falls back to the user agent when platform is blank', () => {
    setPlatform('', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)');
    expect(isMacPlatform()).toBe(true);
  });
});

describe('hints', () => {
  it('renders mac glyphs solid', () => {
    setPlatform('MacIntel');
    expect(modKey()).toBe('⌘');
    expect(modShortcutHint('K')).toBe('⌘K');
    expect(modShiftShortcutHint('F')).toBe('⌘⇧F');
  });

  // The whole point of the module: Windows showed ⌘K while the binding is Ctrl.
  it('renders Ctrl on Windows', () => {
    setPlatform('Win32');
    expect(modKey()).toBe('Ctrl');
    expect(modShortcutHint('K')).toBe('Ctrl+K');
    expect(modShiftShortcutHint('F')).toBe('Ctrl+Shift+F');
  });
});
