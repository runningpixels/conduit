/**
 * Theming Phase 5 (user theme files) — resolve + apply + persistence.
 * Validation is the load-bearing part (docs/theming/decisions.md S7): colour
 * values only ever reach the DOM through the brand allowlist + hex grammar,
 * structural choices only through the fixed tables in userThemes.ts, so both
 * get direct coverage against malformed input, not just the happy path.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import enMessages from '../i18n/messages/en.json';
import type { BrandPalette, UserThemeEntry } from '@conduit/config-schema';
import {
  applyCachedUserTheme,
  clearUserTheme,
  clearUserThemeSelection,
  isResolvedUserTheme,
  reconcileUserThemes,
  resolveUserTheme,
  selectUserTheme,
  type ResolvedUserTheme,
} from './userThemes';
import { readUserThemeCache, readSelectedUserThemeId } from './userThemeStorage';
import { DEFAULT_THEME_ID, themeById } from './registry';
import { isBrandActive, readReadingFont, writeReadingFont } from '../shell/uiPrefs';

const en = enMessages as Record<string, string>;

/** A minimal stand-in for `Translate` that resolves against the real English
 *  catalog with `{name}`-style interpolation, so assertions read real text
 *  rather than opaque keys. */
function t(id: string, values?: Record<string, unknown>): string {
  let msg = en[id] ?? id;
  if (values) {
    for (const [key, value] of Object.entries(values)) {
      msg = msg.split(`{${key}}`).join(String(value));
    }
  }
  return msg;
}

function fullPalette(overrides: Partial<BrandPalette> = {}): BrandPalette {
  return {
    bg: '#111111',
    bgSide: '#121212',
    card: '#131313',
    cardHi: '#141414',
    line: '#151515',
    lineSoft: '#161616',
    lineHi: '#171717',
    ink: '#e0e0e0',
    ink2: '#d0d0d0',
    ink3: '#c0c0c0',
    hue: '#ff9900',
    hueText: '#ffb020',
    hueSolid: '#ffb020',
    onHue: '#000000',
    ok: '#22cc55',
    warn: '#ddaa00',
    err: '#dd3333',
    link: '#66aaff',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<UserThemeEntry> = {}): UserThemeEntry {
  return {
    id: 'my-theme',
    fileName: 'my-theme.theme.md',
    theme: { schemaVersion: 1, name: 'My Theme', extends: 'graphite' },
    ...overrides,
  } as UserThemeEntry;
}

function resetDocument() {
  const el = document.documentElement;
  for (const attr of Array.from(el.attributes)) el.removeAttribute(attr.name);
  el.removeAttribute('style');
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
}

describe('resolveUserTheme', () => {
  beforeEach(resetDocument);

  it('passes through Rust\'s own error unchanged', () => {
    const result = resolveUserTheme(makeEntry({ theme: undefined, error: 'bad frontmatter' }), t);
    expect(isResolvedUserTheme(result)).toBe(false);
    if (!isResolvedUserTheme(result)) {
      expect(result.error).toBe('bad frontmatter');
      expect(result.fileName).toBe('my-theme.theme.md');
    }
  });

  it('rejects an unknown base theme, naming every valid id', () => {
    const entry = makeEntry({ theme: { schemaVersion: 1, name: 'X', extends: 'not-a-real-theme' } });
    const result = resolveUserTheme(entry, t);
    expect(isResolvedUserTheme(result)).toBe(false);
    if (!isResolvedUserTheme(result)) {
      expect(result.error).toContain('not-a-real-theme');
      expect(result.error).toContain(DEFAULT_THEME_ID);
      expect(result.error).toContain('graphite');
    }
  });

  it('derives modes/swatches from the base theme when the file overrides no palette', () => {
    const entry = makeEntry();
    const result = resolveUserTheme(entry, t);
    expect(isResolvedUserTheme(result)).toBe(true);
    if (isResolvedUserTheme(result)) {
      const base = themeById('graphite')!;
      expect(result.modes).toEqual(base.modes);
      expect(result.swatches).toEqual(base.swatches);
      expect(result.look).toBe(base.look);
      expect(result.palette).toBe(base.palette);
      expect(result.id).toBe('user:my-theme');
    }
  });

  it('narrows modes/swatches to whichever palette modes the file overrides', () => {
    const dark = fullPalette({ bg: '#010101', card: '#020202', ink: '#e5e5e5', hue: '#ff0000' });
    const entry = makeEntry({
      theme: { schemaVersion: 1, name: 'Dark Only Override', extends: 'graphite', palette: { dark } },
    });
    const result = resolveUserTheme(entry, t);
    expect(isResolvedUserTheme(result)).toBe(true);
    if (isResolvedUserTheme(result)) {
      expect(result.modes).toEqual(['dark']);
      expect(result.swatches).toEqual(['#010101', '#020202', '#e5e5e5', '#ff0000']);
    }
  });

  it('keeps the base look/palette regardless of any colour override', () => {
    const entry = makeEntry({
      theme: {
        schemaVersion: 1,
        name: 'Recolored Amber',
        extends: 'amber-terminal',
        palette: { dark: fullPalette() },
      },
    });
    const result = resolveUserTheme(entry, t);
    expect(isResolvedUserTheme(result)).toBe(true);
    if (isResolvedUserTheme(result)) {
      expect(result.look).toBe('terminal');
      expect(result.palette).toBe('amber');
    }
  });
});

describe('applyUserTheme (via selectUserTheme) — structure table + clear', () => {
  beforeEach(resetDocument);

  function resolve(structure: NonNullable<ResolvedUserTheme['structure']>): ResolvedUserTheme {
    const entry = makeEntry({
      theme: { schemaVersion: 1, name: 'Structural', extends: 'graphite', structure },
    });
    const result = resolveUserTheme(entry, t);
    if (!isResolvedUserTheme(result)) throw new Error('expected a resolved theme');
    return result;
  }

  it('square corners zero every radius token including --r-pill', () => {
    selectUserTheme(resolve({ corners: 'square' }));
    const style = document.documentElement.style;
    for (const prop of ['--r-1', '--r-2', '--r-3', '--r-4', '--r-xs', '--r-sm', '--r', '--r-lg', '--r-xl', '--r-pill']) {
      expect(style.getPropertyValue(prop)).toBe('0');
    }
  });

  it('soft corners set the four named radii and leave --r-pill alone', () => {
    selectUserTheme(resolve({ corners: 'soft' }));
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--r-xs')).toBe('8px');
    expect(style.getPropertyValue('--r-lg')).toBe('20px');
    expect(style.getPropertyValue('--r-pill')).toBe('');
  });

  it('uiFont points --font-ui at the bundled face', () => {
    selectUserTheme(resolve({ uiFont: 'mono' }));
    expect(document.documentElement.style.getPropertyValue('--font-ui')).toBe('var(--font-mono)');
  });

  it('shadows: none flattens elevation to transparent zero-offset', () => {
    selectUserTheme(resolve({ shadows: 'none' }));
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--lift')).toBe('0 0 transparent');
    expect(style.getPropertyValue('--glow')).toBe('0 0 transparent');
  });

  it('motion: none collapses tap + duration + dur-* tokens', () => {
    selectUserTheme(resolve({ motion: 'none' }));
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--tap')).toBe('0s');
    expect(style.getPropertyValue('--dur-menu')).toBe('0s');
    expect(style.getPropertyValue('--duration-instant')).toBe('0ms');
  });

  it('iconStroke maps to the numeric --icon-stroke value', () => {
    selectUserTheme(resolve({ iconStroke: 'bold' }));
    expect(document.documentElement.style.getPropertyValue('--icon-stroke')).toBe('2.2');
  });

  it('labels: small-caps sets --label-case: none plus data-user-labels', () => {
    selectUserTheme(resolve({ labels: 'small-caps' }));
    expect(document.documentElement.style.getPropertyValue('--label-case')).toBe('none');
    expect(document.documentElement.getAttribute('data-user-labels')).toBe('small-caps');
  });

  it('clearUserTheme removes exactly what the last apply set, nothing else', () => {
    document.documentElement.style.setProperty('--r-xs', '99px'); // pre-existing, untracked
    selectUserTheme(resolve({ corners: 'square', motion: 'none' }));
    expect(document.documentElement.style.getPropertyValue('--r-xs')).toBe('0');
    clearUserTheme();
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--tap')).toBe('');
    expect(style.getPropertyValue('--dur-menu')).toBe('');
    // The untracked pre-existing value survives, because clearUserTheme only
    // removes properties applyUserTheme itself set on the most recent call —
    // and that call overwrote --r-xs to '0', which the clear does remove.
    expect(style.getPropertyValue('--r-xs')).toBe('');
  });

  it('re-applying with a different structure choice does not leave the old one behind', () => {
    selectUserTheme(resolve({ corners: 'square' }));
    expect(document.documentElement.style.getPropertyValue('--r-xs')).toBe('0');
    selectUserTheme(resolve({ corners: 'soft' }));
    expect(document.documentElement.style.getPropertyValue('--r-xs')).toBe('8px');
    // --r-pill was only ever a 'square' property; switching to 'soft' must
    // not leave it pinned at 0.
    expect(document.documentElement.style.getPropertyValue('--r-pill')).toBe('');
  });
});

describe('applyUserTheme — palette + brand interaction (S6)', () => {
  beforeEach(resetDocument);
  afterEach(resetDocument);

  function resolveWithPalette(): ResolvedUserTheme {
    const entry = makeEntry({
      theme: {
        schemaVersion: 1,
        name: 'Colourful',
        extends: 'graphite',
        palette: { dark: fullPalette({ bg: '#0a0a0a', hue: '#ff00ff' }) },
      },
    });
    const result = resolveUserTheme(entry, t);
    if (!isResolvedUserTheme(result)) throw new Error('expected a resolved theme');
    return result;
  }

  it('applies validated hex palette properties and data-user-palette when no brand is active', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    selectUserTheme(resolveWithPalette());
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#0a0a0a');
    expect(document.documentElement.style.getPropertyValue('--hue')).toBe('#ff00ff');
    expect(document.documentElement.getAttribute('data-user-palette')).toBe('1');
    expect(document.documentElement.getAttribute('data-palette')).toBe('graphite');
  });

  it('skips the palette entirely while a brand is active, and sets no data-user-palette', () => {
    document.documentElement.setAttribute('data-palette', 'brand');
    expect(isBrandActive()).toBe(true);
    selectUserTheme(resolveWithPalette());
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('');
    expect(document.documentElement.hasAttribute('data-user-palette')).toBe(false);
    // data-palette is left alone (still 'brand'), per S6.
    expect(document.documentElement.getAttribute('data-palette')).toBe('brand');
  });

  it('still applies structure while a brand is active', () => {
    document.documentElement.setAttribute('data-palette', 'brand');
    const entry = makeEntry({
      theme: {
        schemaVersion: 1,
        name: 'Colourful',
        extends: 'graphite',
        palette: { dark: fullPalette() },
        structure: { iconStroke: 'thin' },
      },
    });
    const result = resolveUserTheme(entry, t);
    if (!isResolvedUserTheme(result)) throw new Error('expected a resolved theme');
    selectUserTheme(result);
    expect(document.documentElement.style.getPropertyValue('--icon-stroke')).toBe('1.3');
  });
});

describe('applyUserTheme — reading-font precedence', () => {
  beforeEach(resetDocument);

  function resolveReading(): ResolvedUserTheme {
    const entry = makeEntry({
      theme: { schemaVersion: 1, name: 'Mono Reading', extends: 'graphite', structure: { readingFont: 'mono' } },
    });
    const result = resolveUserTheme(entry, t);
    if (!isResolvedUserTheme(result)) throw new Error('expected a resolved theme');
    return result;
  }

  it('sets --font-prose inline while the reading-font preference is "theme"', () => {
    expect(readReadingFont()).toBe('theme');
    selectUserTheme(resolveReading());
    expect(document.documentElement.style.getPropertyValue('--font-prose')).toBe('var(--font-mono)');
  });

  it('does not set --font-prose inline once the user has an explicit reading-font preference', () => {
    writeReadingFont('serif');
    selectUserTheme(resolveReading());
    expect(document.documentElement.style.getPropertyValue('--font-prose')).toBe('');
  });
});

describe('cache round-trip + persistence', () => {
  beforeEach(resetDocument);

  it('selectUserTheme persists the id and a cache that applyCachedUserTheme can replay', () => {
    const entry = makeEntry({
      theme: {
        schemaVersion: 1,
        name: 'Cached',
        extends: 'graphite',
        palette: { dark: fullPalette({ bg: '#0b0b0b' }) },
        structure: { iconStroke: 'bold' },
      },
    });
    const result = resolveUserTheme(entry, t);
    if (!isResolvedUserTheme(result)) throw new Error('expected a resolved theme');
    selectUserTheme(result);

    expect(readSelectedUserThemeId()).toBe('my-theme');
    const cached = readUserThemeCache();
    expect(cached?.id).toBe('my-theme');
    expect(cached?.base).toEqual({ look: 'soft', palette: 'graphite' });

    clearUserTheme(); // simulate a fresh boot before the pre-paint replay
    const replayed = applyCachedUserTheme('dark');
    expect(replayed?.id).toBe('my-theme');
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#0b0b0b');
    expect(document.documentElement.style.getPropertyValue('--icon-stroke')).toBe('2.2');
  });

  it('applyCachedUserTheme is a no-op when nothing is selected', () => {
    expect(applyCachedUserTheme('dark')).toBeNull();
  });

  it('rejects a structurally malformed cache rather than applying it', () => {
    localStorage.setItem('conduit:v10-user-theme', 'ghost');
    localStorage.setItem('conduit:v10-user-theme-cache', JSON.stringify({ id: 'ghost' /* missing base/modes */ }));
    expect(applyCachedUserTheme('dark')).toBeNull();
  });

  it('drops an invalid hex value at apply time even though the cache round-tripped', () => {
    localStorage.setItem('conduit:v10-user-theme', 'ghost');
    localStorage.setItem(
      'conduit:v10-user-theme-cache',
      JSON.stringify({
        id: 'ghost',
        fileName: 'ghost.theme.md',
        base: { look: 'soft', palette: 'graphite' },
        palette: { dark: fullPalette({ bg: 'javascript:alert(1)' }) },
        modes: ['dark'],
      }),
    );
    applyCachedUserTheme('dark');
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('');
    // A sibling valid key in the same palette still applies — one bad value
    // does not sink the whole apply, same as applyBrand.ts.
    expect(document.documentElement.style.getPropertyValue('--card')).toBe('#131313');
  });

  it('clearUserThemeSelection drops both the pref and the cache', () => {
    const entry = makeEntry();
    const result = resolveUserTheme(entry, t);
    if (!isResolvedUserTheme(result)) throw new Error('expected a resolved theme');
    selectUserTheme(result);
    clearUserThemeSelection();
    expect(readSelectedUserThemeId()).toBeNull();
    expect(readUserThemeCache()).toBeNull();
  });
});

describe('reconcileUserThemes (App boot)', () => {
  beforeEach(resetDocument);

  it('does nothing when no user theme is selected', () => {
    expect(reconcileUserThemes([], 'dark', t)).toEqual({ cleared: false });
  });

  it('falls back to the cached base theme id when the file is gone, and reports it for a toast', () => {
    const entry = makeEntry();
    const resolved = resolveUserTheme(entry, t);
    if (!isResolvedUserTheme(resolved)) throw new Error('expected a resolved theme');
    selectUserTheme(resolved);

    const outcome = reconcileUserThemes([], 'dark', t);
    expect(outcome.cleared).toBe(true);
    expect(outcome.fileName).toBe('my-theme.theme.md');
    expect(outcome.fallbackThemeId).toBe(themeById('graphite')!.id);
    expect(readSelectedUserThemeId()).toBeNull();
    expect(document.documentElement.getAttribute('data-palette')).toBe('graphite');
  });

  it('re-applies and rewrites the cache when the entry is still valid', () => {
    const entry = makeEntry({
      theme: { schemaVersion: 1, name: 'Cached', extends: 'graphite', structure: { iconStroke: 'thin' } },
    });
    const resolved = resolveUserTheme(entry, t);
    if (!isResolvedUserTheme(resolved)) throw new Error('expected a resolved theme');
    selectUserTheme(resolved);
    clearUserTheme();

    const outcome = reconcileUserThemes([entry], 'dark', t);
    expect(outcome.cleared).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--icon-stroke')).toBe('1.3');
  });
});

describe('applyStructure hardening (tampered cache)', () => {
  it('ignores structure values that are not own keys of the fixed tables', async () => {
    const { applyCachedUserTheme } = await import('./userThemes');
    localStorage.setItem('conduit:v10-user-theme', 'evil');
    localStorage.setItem(
      'conduit:v10-user-theme-cache',
      JSON.stringify({
        id: 'evil',
        fileName: 'evil.theme.md',
        base: { look: 'soft', palette: 'graphite' },
        structure: { corners: 'constructor', uiFont: '__proto__', iconStroke: 'url(x)', motion: 'toString' },
        modes: ['dark'],
      }),
    );
    expect(() => applyCachedUserTheme('dark')).not.toThrow();
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--font-ui')).toBe('');
    expect(style.getPropertyValue('--icon-stroke')).toBe('');
    expect(style.getPropertyValue('--r-sm')).toBe('');
  });
});
