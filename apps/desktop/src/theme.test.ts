/**
 * Theme mode resolution (theme.ts): `AppSettings.theme` (dark / light /
 * system) to the effective mode. ADR-011 removed palette narrowing; a
 * retired single-mode palette is migrated once at boot instead
 * (uiPrefs.ts `migrateRetiredThemePrefs`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Minimal MediaQueryList stub good enough for theme.ts's usage. */
function mockMatchMedia(prefersLight: boolean) {
  const listeners = new Set<(e: unknown) => void>();
  const mql = {
    matches: prefersLight,
    media: '(prefers-color-scheme: light)',
    addEventListener: (_type: string, cb: (e: unknown) => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: (e: unknown) => void) => listeners.delete(cb),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue(mql),
  );
  return { mql, listeners };
}

describe('resolveTheme', () => {
  beforeEach(() => {
    mockMatchMedia(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('dark resolves to dark', async () => {
    const { resolveTheme } = await import('./theme');
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('light resolves to light', async () => {
    const { resolveTheme } = await import('./theme');
    expect(resolveTheme('light')).toBe('light');
  });

  it('system follows prefers-color-scheme', async () => {
    const { resolveTheme } = await import('./theme');
    mockMatchMedia(false);
    expect(resolveTheme('system')).toBe('dark');
    mockMatchMedia(true);
    expect(resolveTheme('system')).toBe('light');
  });
});

describe('resolveTheme — no palette narrowing (ADR-011)', () => {
  beforeEach(() => {
    mockMatchMedia(true);
    localStorage.setItem('conduit:v9-palette', 'amber');
  });
  afterEach(() => {
    localStorage.removeItem('conduit:v9-palette');
    vi.unstubAllGlobals();
  });

  it('a stored retired dark-only palette no longer forces dark', async () => {
    const { resolveTheme } = await import('./theme');
    expect(resolveTheme('light')).toBe('light');
    expect(resolveTheme('system')).toBe('light');
  });
});

describe('applyTheme', () => {
  beforeEach(() => {
    mockMatchMedia(false);
    document.documentElement.removeAttribute('data-theme');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sets html[data-theme] to the resolved value and returns it', async () => {
    const { applyTheme } = await import('./theme');
    expect(applyTheme('dark')).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(applyTheme('light')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('watchSystemTheme', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('re-applies the theme and notifies on an OS change while mode is system', async () => {
    const { listeners } = mockMatchMedia(false);
    const { watchSystemTheme } = await import('./theme');
    const onChange = vi.fn();
    const teardown = watchSystemTheme('system', onChange);
    expect(listeners.size).toBe(1);
    for (const listener of listeners) listener({});
    expect(onChange).toHaveBeenCalledTimes(1);
    teardown();
  });

  it('does not notify when mode is not system', async () => {
    const { listeners } = mockMatchMedia(false);
    const { watchSystemTheme } = await import('./theme');
    const onChange = vi.fn();
    watchSystemTheme('dark', onChange);
    for (const listener of listeners) listener({});
    expect(onChange).not.toHaveBeenCalled();
  });

  it('teardown removes the media-query listener', async () => {
    const { listeners } = mockMatchMedia(false);
    const { watchSystemTheme } = await import('./theme');
    const teardown = watchSystemTheme('system', vi.fn());
    expect(listeners.size).toBe(1);
    teardown();
    expect(listeners.size).toBe(0);
  });
});
