/**
 * Theme mode resolution (theme.ts). `resolveTheme` narrows `AppSettings.theme`
 * to what the active look × palette can actually render — `supportedModes()`
 * from shell/uiPrefs.ts — without ever writing back to the user's own
 * dark/light/system preference (themes/registry.ts's `modesForPalette`).
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

describe('resolveTheme — default registry state (both modes supported)', () => {
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

describe('resolveTheme — narrows to supportedModes() (dark-only palette active)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('./shell/uiPrefs', () => ({ supportedModes: () => ['dark'] }));
  });
  afterEach(() => {
    vi.doUnmock('./shell/uiPrefs');
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it('light narrows to dark', async () => {
    mockMatchMedia(true);
    const { resolveTheme } = await import('./theme');
    expect(resolveTheme('light')).toBe('dark');
  });

  it('system narrows to dark even when the OS prefers light', async () => {
    mockMatchMedia(true);
    const { resolveTheme } = await import('./theme');
    expect(resolveTheme('system')).toBe('dark');
  });

  it('dark is unaffected (already the only supported mode)', async () => {
    mockMatchMedia(false);
    const { resolveTheme } = await import('./theme');
    expect(resolveTheme('dark')).toBe('dark');
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
