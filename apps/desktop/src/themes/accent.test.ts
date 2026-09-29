import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCENT_SURFACES,
  ACCENT_SWATCHES,
  applyAccent,
  applyCachedAccent,
  contrast,
  DEFAULT_ACCENT,
  deriveAccent,
  type AccentMode,
} from './accent';

const here = dirname(fileURLToPath(import.meta.url));
const tokens = readFileSync(join(here, '..', '..', '..', '..', 'packages', 'ui', 'src', 'tokens.css'), 'utf8')
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** The first top-level `selector { … }` block's declarations. */
function block(selector: string): string {
  const start = tokens.indexOf(`\n${selector} {\n`);
  if (start < 0) throw new Error(`no ${selector} block`);
  const open = tokens.indexOf('{', start);
  return tokens.slice(open + 1, tokens.indexOf('\n}\n', open));
}

function token(mode: AccentMode, name: string): string {
  const layers = mode === 'dark' ? [block(':root')] : [block(':root'), block('[data-theme="light"]')];
  for (const decls of layers.reverse()) {
    const hit = decls.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6});`));
    if (hit) return hit[1];
  }
  throw new Error(`--${name} not found for ${mode}`);
}

const MODES: AccentMode[] = ['dark', 'light'];

describe('accent constants match tokens.css', () => {
  it.each(MODES)('%s: surfaces and default accent', (mode) => {
    expect(ACCENT_SURFACES[mode]).toEqual(['bg', 'bg-side', 'card', 'card-hi'].map((n) => token(mode, n)));
    expect(DEFAULT_ACCENT[mode]).toBe(token(mode, 'accent'));
    expect(ACCENT_SWATCHES[mode][0]).toBe(DEFAULT_ACCENT[mode]);
  });
});

describe('deriveAccent', () => {
  it.each(MODES.flatMap((mode) => ACCENT_SWATCHES[mode].map((hex) => [mode, hex] as const)))(
    '%s swatch %s is valid and legible',
    (mode, hex) => {
      const verdict = deriveAccent(hex, mode);
      expect(verdict.ok).toBe(true);
      if (!verdict.ok) return;
      const { family } = verdict;
      for (const surface of ACCENT_SURFACES[mode]) {
        expect(contrast(family.accent, surface)).toBeGreaterThanOrEqual(3);
        expect(contrast(family.accentText, surface)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(family.onAccent, family.accent)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('derives a legible text form for a colour that is only graphic-grade', () => {
    // #3f7fd0 clears 3:1 on the dark surfaces but not 4.5:1.
    const verdict = deriveAccent('#3f7fd0', 'dark');
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.family.accentText).not.toBe('#3f7fd0');
    for (const surface of ACCENT_SURFACES.dark) {
      expect(contrast(verdict.family.accentText, surface)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('normalises case and whitespace', () => {
    const verdict = deriveAccent('  #FF7A59 ', 'dark');
    expect(verdict.ok && verdict.family.accent).toBe('#ff7a59');
  });

  it.each(['#fff', 'red', '#ff7a59aa', 'ff7a59', '', 'url(x)'])('refuses the malformed %j', (bad) => {
    expect(deriveAccent(bad, 'dark')).toEqual({ ok: false, reason: 'format' });
  });

  it('refuses a colour too close to the dark background', () => {
    expect(deriveAccent('#1a1d26', 'dark')).toEqual({ ok: false, reason: 'lowContrast' });
  });

  it('refuses a colour too close to the light background', () => {
    expect(deriveAccent('#e6e8ee', 'light')).toEqual({ ok: false, reason: 'lowContrast' });
  });
});

describe('applyAccent', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style');
    document.documentElement.removeAttribute('data-palette');
    localStorage.clear();
  });

  const style = () => document.documentElement.style;

  it('sets the derived family inline for the current mode', () => {
    const applied = applyAccent({ dark: '#2fd3b5', light: '#0b7a67' }, 'light');
    expect(applied?.accent).toBe('#0b7a67');
    expect(style().getPropertyValue('--accent')).toBe('#0b7a67');
    expect(style().getPropertyValue('--on-accent')).toBe(applied?.onAccent);
    expect(style().getPropertyValue('--accent-text')).toBe(applied?.accentText);
  });

  it('clears the inline family when the mode has no override', () => {
    applyAccent({ dark: '#2fd3b5' }, 'dark');
    expect(style().getPropertyValue('--accent')).toBe('#2fd3b5');
    applyAccent({ dark: '#2fd3b5' }, 'light');
    expect(style().getPropertyValue('--accent')).toBe('');
  });

  it('keeps the default for a refused colour', () => {
    expect(applyAccent({ dark: '#1a1d26' }, 'dark')).toBeNull();
    expect(style().getPropertyValue('--accent')).toBe('');
  });

  it('stands down while a white-label brand is active', () => {
    document.documentElement.setAttribute('data-palette', 'brand');
    expect(applyAccent({ dark: '#2fd3b5' }, 'dark')).toBeNull();
    expect(style().getPropertyValue('--accent')).toBe('');
  });

  it('caches the override and replays it before first paint', () => {
    applyAccent({ dark: '#c08cff' }, 'dark');
    document.documentElement.removeAttribute('style');
    applyCachedAccent('dark');
    expect(style().getPropertyValue('--accent')).toBe('#c08cff');
  });

  it('drops the cache when the override is cleared', () => {
    applyAccent({ dark: '#c08cff' }, 'dark');
    applyAccent({}, 'dark');
    expect(localStorage.getItem('conduit:v11-accent')).toBeNull();
  });
});
