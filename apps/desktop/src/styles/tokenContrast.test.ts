/**
 * WCAG contrast guard for the design tokens (ADR-011: one design, two modes).
 *
 * The V7 ink ramp shipped with `--ink-3` at 3.2:1 against `--card` — under the
 * AA floor for normal text — and it carries real copy: the composer
 * placeholder, sidebar group headers, tool status, `.kv` labels, timestamps.
 * `tsc -b` and the component tests cannot see a contrast ratio, so the tokens
 * are asserted numerically here, the same way cssContract.test.ts asserts the
 * button reset.
 *
 * Ratios are computed from tokens.css itself, so editing a colour re-checks it.
 * Dark is `:root`; light is `:root` overlaid with `[data-theme="light"]`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// Normalised: the repo checks out CRLF on Windows.
const tokens = readFileSync(
  join(here, '..', '..', '..', '..', 'packages', 'ui', 'src', 'tokens.css'),
  'utf8',
).replace(/\r\n/g, '\n');

/** WCAG 2.1 normal-text minimum. */
const AA = 4.5;
/** WCAG 1.4.11 non-text minimum, for graphical objects that carry no glyphs. */
const AA_NON_TEXT = 3;

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, (c) => c + c) : h, 16);
  return (
    0.2126 * channel((n >> 16) & 0xff) +
    0.7152 * channel((n >> 8) & 0xff) +
    0.0722 * channel(n & 0xff)
  );
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Read a literal hex token out of a `{ … }` block. Only literals are resolved;
 * tokens defined as `var(--other)` are covered by whichever token they alias.
 * The *last* declaration wins, as it does in the cascade.
 */
function readTokenIn(block: string, name: string): string | null {
  const all = [...block.matchAll(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`, 'g'))];
  return all.length ? all[all.length - 1][1] : null;
}

/**
 * Top-level rules, as `{ selectors, decls }`. Nested at-blocks (`@supports`,
 * `@media`) are skipped outright: their contents are fallbacks and overrides
 * that must never be mistaken for the real declarations. Exact selector-member
 * matching plus a uniqueness check makes a typo'd or deleted selector loud.
 */
interface Rule {
  selectors: string[];
  decls: string;
}

function parseRules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  let head = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '{') {
      const selector = head.trim();
      let depth = 1;
      let j = i + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') depth -= 1;
        j += 1;
      }
      if (!selector.startsWith('@')) {
        rules.push({
          selectors: selector.split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
          decls: src.slice(i + 1, j - 1),
        });
      }
      head = '';
      i = j;
      continue;
    }
    if (c === '}') {
      head = '';
      i += 1;
      continue;
    }
    head += c;
    i += 1;
  }
  return rules;
}

const RULES = parseRules(tokens);

/** The declarations of the one top-level rule carrying `selector` verbatim. */
function blockFor(selector: string): string {
  const hits = RULES.filter((r) => r.selectors.includes(selector));
  if (hits.length !== 1) {
    throw new Error(`selector ${selector}: expected exactly 1 rule, found ${hits.length}`);
  }
  return hits[0].decls;
}

/** Resolve a token the way the browser would: the last layer that declares it. */
function resolve(layers: readonly string[], name: string): string {
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const hit = readTokenIn(blockFor(layers[i]), name);
    if (hit) return hit;
  }
  throw new Error(`token --${name} is not a hex literal in any of [${layers.join(', ')}]`);
}

const MODES = {
  dark: [':root'],
  light: [':root', '[data-theme="light"]'],
} as const;

/**
 * Surfaces text can sit on. `--bg-side` (the side column / panel / sheet-nav
 * fill) is the worst case in light mode, where it is the *darkest* surface —
 * the direction that catches the opposite failures from dark mode's `--card-hi`.
 */
const SURFACES = ['bg', 'bg-side', 'card', 'card-hi'] as const;
/** Ink steps that carry text. All three must be legible on all four surfaces. */
const INKS = ['ink', 'ink-2', 'ink-3'] as const;

describe.each(Object.entries(MODES))('%s mode', (_mode, layers) => {
  const surfaces = SURFACES.map((s) => [s, resolve(layers, s)] as const);

  it.each(INKS.flatMap((ink) => SURFACES.map((s) => [ink, s] as const)))(
    '--%s on --%s clears AA',
    (ink, surface) => {
      expect(contrast(resolve(layers, ink), resolve(layers, surface))).toBeGreaterThanOrEqual(AA);
    },
  );

  // A ramp whose steps are numerically legible but visually identical buys
  // nothing — each step must be a perceptible jump from the next.
  it('keeps three distinct ink steps', () => {
    const ramp = INKS.map((i) => resolve(layers, i));
    expect(contrast(ramp[0], ramp[1])).toBeGreaterThan(1.4);
    expect(contrast(ramp[1], ramp[2])).toBeGreaterThan(1.4);
  });

  // Status colours label errors and warnings; illegible ones defeat the point.
  // Checked on every surface: a failed tool summary sits on a hovered tool
  // line, which is --card-hi.
  it.each((['ok', 'warn', 'err'] as const).flatMap((s) => SURFACES.map((sf) => [s, sf] as const)))(
    '--%s clears AA on --%s',
    (status, surface) => {
      expect(contrast(resolve(layers, status), resolve(layers, surface))).toBeGreaterThanOrEqual(AA);
    },
  );

  // --code carries body text (inline spans, plain fence bodies), and --link is
  // the only thing marking a link as actionable.
  it.each((['code', 'link'] as const).flatMap((s) => SURFACES.map((sf) => [s, sf] as const)))(
    '--%s clears AA on --%s',
    (token, surface) => {
      expect(contrast(resolve(layers, token), resolve(layers, surface))).toBeGreaterThanOrEqual(AA);
    },
  );

  /*
   * The accent and signal roles:
   *   --accent        fills and graphics — 3:1 on every surface
   *   --accent-text   the accent as literal text — AA on every surface
   *   --on-accent     glyphs on an --accent fill (send button, .btn.primary) — AA
   *   --signal        running-state graphics — 3:1;  --signal-text — AA
   */
  it.each(surfaces)('--accent clears 3:1 on --%s', (_s, bg) => {
    expect(contrast(resolve(layers, 'accent'), bg)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
  it.each(surfaces)('--accent-text clears AA on --%s', (_s, bg) => {
    expect(contrast(resolve(layers, 'accent-text'), bg)).toBeGreaterThanOrEqual(AA);
  });
  it('--on-accent clears AA on --accent', () => {
    expect(contrast(resolve(layers, 'on-accent'), resolve(layers, 'accent'))).toBeGreaterThanOrEqual(AA);
  });
  it.each(surfaces)('--signal clears 3:1 on --%s', (_s, bg) => {
    expect(contrast(resolve(layers, 'signal'), bg)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
  it.each(surfaces)('--signal-text clears AA on --%s', (_s, bg) => {
    expect(contrast(resolve(layers, 'signal-text'), bg)).toBeGreaterThanOrEqual(AA);
  });
  // Rail labels are ink on --bg-rail.
  it.each(INKS)('--%s clears AA on --bg-rail', (ink) => {
    expect(contrast(resolve(layers, ink), resolve(layers, 'bg-rail'))).toBeGreaterThanOrEqual(AA);
  });
});

/**
 * `--field-line` (text-field and dropdown border) is a `color-mix` of `--ink-3`
 * into `--bg`, not a literal. Resolve it the way the browser does (sRGB, by
 * the declared share) and hold it to the non-text minimum on every surface.
 */
function fieldLineShare(layers: readonly string[]): number {
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const hit = blockFor(layers[i]).match(
      /--field-line\s*:\s*color-mix\(in srgb,\s*var\(--ink-3\)\s*(\d+)%,\s*var\(--bg\)\)/,
    );
    if (hit) return Number(hit[1]) / 100;
  }
  throw new Error(`--field-line is not a color-mix of --ink-3 into --bg in any of [${layers.join(', ')}]`);
}

function mixHex(a: string, b: string, share: number): string {
  const rgb = (hex: string) => {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  const [x, y] = [rgb(a), rgb(b)];
  return `#${x
    .map((v, i) => Math.round(v * share + y[i] * (1 - share)).toString(16).padStart(2, '0'))
    .join('')}`;
}

describe.each(Object.entries(MODES))('%s mode: field border', (_mode, layers) => {
  const line = mixHex(resolve(layers, 'ink-3'), resolve(layers, 'bg'), fieldLineShare(layers));
  it.each(SURFACES)('--field-line on --%s clears 3:1', (surface) => {
    expect(contrast(line, resolve(layers, surface))).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

/**
 * The accent is set once on :root and inherited (ADR-011). A [data-provider]
 * rule that redeclared --hue would put provider colour back into the chrome
 * for everything under that element, so none may.
 */
describe('accent inheritance', () => {
  it('declares every hue role on :root as the accent', () => {
    const root = blockFor(':root');
    expect(root).toMatch(/--hue:\s*var\(--accent\)/);
    expect(root).toMatch(/--hue-text:\s*var\(--accent-text\)/);
    expect(root).toMatch(/--hue-solid:\s*var\(--accent\)/);
    expect(root).toMatch(/--on-hue:\s*var\(--on-accent\)/);
    expect(root).toMatch(/--hue-weak:\s*var\(--accent-soft\)/);
  });

  it('no [data-provider] rule redeclares a hue role', () => {
    const offenders = RULES.filter(
      (r) =>
        r.selectors.some((s) => s.includes('[data-provider')) &&
        // The white-label rule sets `inherit`, which keeps the inherited accent.
        /(^|[;\s])--(hue|hue-text|hue-solid|hue-weak|on-hue)\s*:(?!\s*inherit)/.test(r.decls),
    ).map((r) => r.selectors.join(', '));
    expect(offenders).toEqual([]);
  });
});

/**
 * Provider identity survives as --provider-hue* for the places that name a
 * model (ADR-011). Same three roles and floors the old --hue split had:
 * graphic 3:1, text AA, and white on the solid fill AA.
 */
const PROVIDERS = ['anthropic', 'openai', 'ollama', 'custom'] as const;
const THEME_PROVIDERS = (['dark', 'light'] as const).flatMap((mode) =>
  PROVIDERS.map((provider) => [mode, provider] as const),
);

function providerBlock(mode: 'dark' | 'light', provider: string): string {
  return blockFor(
    mode === 'light' ? `[data-theme="light"][data-provider="${provider}"]` : `[data-provider="${provider}"]`,
  );
}

describe('provider identity', () => {
  it.each(THEME_PROVIDERS)('%s / %s --provider-hue-text clears AA on every surface', (mode, provider) => {
    const text = readTokenIn(providerBlock(mode, provider), 'provider-hue-text')!;
    for (const surface of SURFACES) {
      expect(contrast(text, resolve(MODES[mode], surface)), `${mode}/${provider} on --${surface}`).toBeGreaterThanOrEqual(AA);
    }
  });

  it.each(THEME_PROVIDERS)('%s / %s --provider-hue clears 3:1 on every surface', (mode, provider) => {
    const hue = readTokenIn(providerBlock(mode, provider), 'provider-hue')!;
    for (const surface of SURFACES) {
      expect(contrast(hue, resolve(MODES[mode], surface)), `${mode}/${provider} on --${surface}`).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      );
    }
  });

  it.each(THEME_PROVIDERS)('%s / %s white clears AA on --provider-hue-solid', (mode, provider) => {
    const solid = readTokenIn(providerBlock(mode, provider), 'provider-hue-solid')!;
    expect(contrast('#ffffff', solid)).toBeGreaterThanOrEqual(AA);
  });
});

describe('no retired theme selectors remain', () => {
  it('declares no look, palette (other than the white-label sentinel) or provider-colour rule', () => {
    const retired = RULES.flatMap((r) => r.selectors).filter(
      (s) =>
        s.includes('data-look') ||
        s.includes('data-provider-colour') ||
        s.includes('data-user-') ||
        s.includes('data-reading-font') ||
        (s.includes('data-palette') && !s.includes('data-palette="brand"')),
    );
    expect(retired).toEqual([]);
  });
});
