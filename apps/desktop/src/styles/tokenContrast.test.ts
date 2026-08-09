/**
 * WCAG contrast guard for the token palette.
 *
 * The V7 ink ramp shipped with `--ink-3` at 3.2:1 against `--card` — under the
 * AA floor for normal text — and it carries real copy: the composer
 * placeholder, sidebar group headers, tool status, `.kv` labels, timestamps.
 * `tsc -b` and the component tests cannot see a contrast ratio, so the palette
 * is asserted numerically here, the same way cssContract.test.ts asserts the
 * button reset.
 *
 * Ratios are computed from tokens.css itself, so editing a colour re-checks it.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
// Normalised: the repo checks out CRLF on Windows, and the selector probes
// below anchor on the newline that separates one rule from the next.
const tokens = readFileSync(
  join(here, '..', '..', '..', '..', 'packages', 'ui', 'src', 'tokens.css'),
  'utf8',
).replace(/\r\n/g, '\n');

/** WCAG 2.1 normal-text minimum. */
const AA = 4.5;

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
 */
function readToken(block: string, name: string): string {
  const m = block.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`));
  if (!m) throw new Error(`token --${name} is not a hex literal in tokens.css`);
  return m[1];
}

/**
 * The declarations of the first rule whose selector list contains `selector`.
 * Delimited by braces rather than newlines: the dark provider rules are
 * one-liners, and the theme blocks span many lines.
 */
function blockFor(selector: string): string {
  const i = tokens.indexOf(selector);
  if (i === -1) throw new Error(`selector ${selector} not found in tokens.css`);
  const open = tokens.indexOf('{', i);
  const close = tokens.indexOf('}', open);
  if (open === -1 || close === -1) throw new Error(`rule for ${selector} is unterminated`);
  return tokens.slice(open + 1, close);
}

/** WCAG 1.4.11 non-text minimum, for graphical objects that carry no glyphs. */
const AA_NON_TEXT = 3;

/**
 * Surfaces text can sit on. `--bg-side` (the sidebar / panel / sheet-nav fill,
 * formerly `--raised`) is the worst case in light mode, where it is the
 * *darkest* surface — the direction that catches the opposite failures from
 * dark mode's `--card-hi`.
 */
const SURFACES = ['bg', 'bg-side', 'card', 'card-hi'] as const;
/** Ink steps that carry text. All three must be legible on all four surfaces. */
const INKS = ['ink', 'ink-2', 'ink-3'] as const;

const THEMES = {
  dark: blockFor(':root {'),
  light: blockFor('[data-theme="light"] {\n'),
} as const;

describe.each(Object.entries(THEMES))('%s theme', (_theme, block) => {
  const surfaces = Object.fromEntries(SURFACES.map((s) => [s, readToken(block, s)]));

  it.each(INKS.flatMap((ink) => SURFACES.map((s) => [ink, s] as const)))(
    '--%s on --%s clears AA',
    (ink, surface) => {
      expect(contrast(readToken(block, ink), surfaces[surface])).toBeGreaterThanOrEqual(AA);
    },
  );

  // A ramp whose steps are numerically legible but visually identical buys
  // nothing — each step must be a perceptible jump from the next.
  it('keeps three distinct steps', () => {
    const ramp = INKS.map((i) => readToken(block, i));
    expect(contrast(ramp[0], ramp[1])).toBeGreaterThan(1.4);
    expect(contrast(ramp[1], ramp[2])).toBeGreaterThan(1.4);
  });

  // Status colours label errors and warnings; illegible ones defeat the point.
  // Checked on every surface, not just --bg/--card: a failed tool summary sits on
  // a hovered tool line, which is --card-hi, and that is where --err was
  // measured at 4.13:1 under the V9 palette.
  it.each(
    (['ok', 'warn', 'err'] as const).flatMap((s) => SURFACES.map((sf) => [s, sf] as const)),
  )('--%s clears AA on --%s', (status, surface) => {
    expect(contrast(readToken(block, status), surfaces[surface])).toBeGreaterThanOrEqual(AA);
  });

  // --code carries body text (inline spans, plain fence bodies), so it is held
  // to every surface it can sit on, like the ink ramp above.
  it.each(SURFACES)('--code clears AA on --%s', (surface) => {
    expect(contrast(readToken(block, 'code'), surfaces[surface])).toBeGreaterThanOrEqual(AA);
  });

  // --link is the only thing marking a link as actionable, so it has to be
  // legible on every surface prose can sit on.
  it.each(SURFACES)('--link clears AA on --%s', (surface) => {
    expect(contrast(readToken(block, 'link'), surfaces[surface])).toBeGreaterThanOrEqual(AA);
  });
});

/**
 * V9 splits provider hue into three roles, each with its own floor, because the
 * warm palette's surfaces are light enough that one value cannot serve all
 * three (v9 implementation plan D1):
 *
 *   --hue        graphics only — the assistant left rule, provider dots, the
 *                streaming caret, focus rings. WCAG 1.4.11, so 3:1.
 *   --hue-text   the same identity wherever it is literal text. AA, 4.5:1.
 *   --hue-solid  a fill with --on-hue on top of it (the send button glyph, the
 *                `.btn.primary` label). AA against --on-hue.
 *
 * Each is checked against the theme it is scoped to. Without the split, all
 * four dark hues measure 3.57–4.43 on --card/--card-hi and white-on-hue
 * measures 2.98–3.20 — the state the V9 spec ships and describes as legible.
 */
const PROVIDERS = ['anthropic', 'openai', 'ollama', 'custom'] as const;
const THEME_PROVIDERS = (['dark', 'light'] as const).flatMap((theme) =>
  PROVIDERS.map((provider) => [theme, provider] as const),
);

function hueBlockFor(theme: 'dark' | 'light', provider: string): string {
  return blockFor(
    theme === 'light'
      ? `[data-theme="light"][data-provider="${provider}"]`
      : `\n[data-provider="${provider}"]`,
  );
}

describe('provider hue: text role', () => {
  it.each(THEME_PROVIDERS)('%s / %s --hue-text clears AA on every surface', (theme, provider) => {
    const surfaceBlock = THEMES[theme];
    const hueText = readToken(hueBlockFor(theme, provider), 'hue-text');
    for (const surface of SURFACES) {
      expect(
        contrast(hueText, readToken(surfaceBlock, surface)),
        `${theme}/${provider} --hue-text on --${surface}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe('provider hue: graphic role', () => {
  it.each(THEME_PROVIDERS)('%s / %s --hue clears 3:1 on every surface', (theme, provider) => {
    const surfaceBlock = THEMES[theme];
    const hue = readToken(hueBlockFor(theme, provider), 'hue');
    for (const surface of SURFACES) {
      expect(
        contrast(hue, readToken(surfaceBlock, surface)),
        `${theme}/${provider} --hue on --${surface}`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });
});

describe('provider hue: solid fill role', () => {
  it.each(THEME_PROVIDERS)('%s / %s --on-hue clears AA on --hue-solid', (theme, provider) => {
    const onHue = readToken(THEMES[theme], 'on-hue');
    const solid = readToken(hueBlockFor(theme, provider), 'hue-solid');
    expect(contrast(onHue, solid)).toBeGreaterThanOrEqual(AA);
  });
});
