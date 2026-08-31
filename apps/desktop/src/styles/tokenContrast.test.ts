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
 * The *last* declaration wins, as it does in the cascade.
 */
function readTokenIn(block: string, name: string): string | null {
  const all = [...block.matchAll(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`, 'g'))];
  return all.length ? all[all.length - 1][1] : null;
}

/**
 * Top-level rules, as `{ selectors, decls }`. Nested at-blocks (`@supports`,
 * `@media`) are skipped outright: their contents are fallbacks and overrides
 * that must never be mistaken for the real declarations.
 *
 * This replaces a substring `indexOf` probe. That probe resolved a selector to
 * "the first place this text appears anywhere in the file", which made two
 * things true that should not have been: a shorter selector silently matched
 * inside a longer one (`[data-theme="light"] {\n` is a substring of
 * `html[data-palette="orange-charcoal"][data-theme="light"] {\n`, so the light theme's
 * contrast was checked correctly only by source order), and a typo'd or deleted
 * selector matched something else instead of failing. Exact selector-member
 * matching plus a uniqueness check makes both of those errors loud.
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

/**
 * Resolve a token the way the browser would: walk the layers in cascade order
 * and take the last one that declares it. A palette is a *delta* over a theme —
 * two hex literals behind one surface is the drift this file exists to prevent
 * — so most tokens fall through to the layer beneath.
 */
function resolve(layers: readonly string[], name: string): string {
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const hit = readTokenIn(blockFor(layers[i]), name);
    if (hit) return hit;
  }
  throw new Error(`token --${name} is not a hex literal in any of [${layers.join(', ')}]`);
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

/**
 * The six looks the app can render: three palettes × two themes. Each is a
 * *stack* of token layers in cascade order, because a palette is a delta over
 * a theme — it declares only what it changes.
 *
 * The terracotta light stacks list the palette's base block after
 * `[data-theme="light"]` deliberately: `html[data-palette="…"]` is (0,1,1)
 * and `[data-theme="light"]` is (0,1,0), so in the browser the palette's dark
 * values *do* outrank the light theme. That is why the light palette block has
 * to redeclare every colour the dark one does, and why the coverage test below
 * exists.
 */
const OC = 'html[data-palette="orange-charcoal"]';
const OC_LIGHT = 'html[data-palette="orange-charcoal"][data-theme="light"]';
const OD = 'html[data-palette="orange-dark"]';
const OD_LIGHT = 'html[data-palette="orange-dark"][data-theme="light"]';
const THEMES = {
  'terra dark': [':root'],
  'terra light': [':root', '[data-theme="light"]'],
  'orange-charcoal dark': [':root', OC],
  'orange-charcoal light': [':root', '[data-theme="light"]', OC, OC_LIGHT],
  'orange-dark dark': [':root', OD],
  'orange-dark light': [':root', '[data-theme="light"]', OD, OD_LIGHT],
} as const;

describe.each(Object.entries(THEMES))('%s', (_look, layers) => {
  const surfaces = Object.fromEntries(SURFACES.map((s) => [s, resolve(layers, s)]));

  it.each(INKS.flatMap((ink) => SURFACES.map((s) => [ink, s] as const)))(
    '--%s on --%s clears AA',
    (ink, surface) => {
      expect(contrast(resolve(layers, ink), surfaces[surface])).toBeGreaterThanOrEqual(AA);
    },
  );

  // A ramp whose steps are numerically legible but visually identical buys
  // nothing — each step must be a perceptible jump from the next.
  it('keeps three distinct steps', () => {
    const ramp = INKS.map((i) => resolve(layers, i));
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
    expect(contrast(resolve(layers, status), surfaces[surface])).toBeGreaterThanOrEqual(AA);
  });

  // --code carries body text (inline spans, plain fence bodies), so it is held
  // to every surface it can sit on, like the ink ramp above.
  it.each(SURFACES)('--code clears AA on --%s', (surface) => {
    expect(contrast(resolve(layers, 'code'), surfaces[surface])).toBeGreaterThanOrEqual(AA);
  });

  // --link is the only thing marking a link as actionable, so it has to be
  // legible on every surface prose can sit on.
  it.each(SURFACES)('--link clears AA on --%s', (surface) => {
    expect(contrast(resolve(layers, 'link'), surfaces[surface])).toBeGreaterThanOrEqual(AA);
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
      : `[data-provider="${provider}"]`,
  );
}

/** The terra (default) palette's surface stack for a theme. */
const TERRA = { dark: THEMES['terra dark'], light: THEMES['terra light'] } as const;

describe('provider hue: text role', () => {
  it.each(THEME_PROVIDERS)('%s / %s --hue-text clears AA on every surface', (theme, provider) => {
    const hueText = readTokenIn(hueBlockFor(theme, provider), 'hue-text')!;
    for (const surface of SURFACES) {
      expect(
        contrast(hueText, resolve(TERRA[theme], surface)),
        `${theme}/${provider} --hue-text on --${surface}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });
});

describe('provider hue: graphic role', () => {
  it.each(THEME_PROVIDERS)('%s / %s --hue clears 3:1 on every surface', (theme, provider) => {
    const hue = readTokenIn(hueBlockFor(theme, provider), 'hue')!;
    for (const surface of SURFACES) {
      expect(
        contrast(hue, resolve(TERRA[theme], surface)),
        `${theme}/${provider} --hue on --${surface}`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });
});

describe('provider hue: solid fill role', () => {
  it.each(THEME_PROVIDERS)('%s / %s --on-hue clears AA on --hue-solid', (theme, provider) => {
    const onHue = resolve(TERRA[theme], 'on-hue');
    const solid = readTokenIn(hueBlockFor(theme, provider), 'hue-solid')!;
    expect(contrast(onHue, solid)).toBeGreaterThanOrEqual(AA);
  });
});

/**
 * The Orange Charcoal palette pins one identity across every provider, and it
 * does so through private `--oc-*` literals rather than by declaring `--hue`
 * directly — so that the rule doing the assigning can stay theme-agnostic and
 * lose to `provider-colour: off` on source order.
 *
 * That indirection costs the checks above their subject: under this palette
 * `--hue` is a `var()`, which `readTokenIn` cannot see. These three tests put
 * the subject back — the literals are measured, and the mapping from literal to
 * role is asserted, so the two cannot drift apart.
 */
describe('orange-charcoal palette hue', () => {
  const LOOKS = [
    ['orange-charcoal dark', OC, THEMES['orange-charcoal dark']],
    ['orange-charcoal light', OC_LIGHT, THEMES['orange-charcoal light']],
  ] as const;

  it.each(LOOKS)('%s --oc-hue-text clears AA on every surface', (_look, sel, layers) => {
    const hueText = readTokenIn(blockFor(sel), 'oc-hue-text')!;
    for (const surface of SURFACES) {
      expect(
        contrast(hueText, resolve(layers, surface)),
        `--oc-hue-text on --${surface}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it.each(LOOKS)('%s --oc-hue clears 3:1 on every surface', (_look, sel, layers) => {
    const hue = readTokenIn(blockFor(sel), 'oc-hue')!;
    for (const surface of SURFACES) {
      expect(
        contrast(hue, resolve(layers, surface)),
        `--oc-hue on --${surface}`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it.each(LOOKS)('%s --on-hue clears AA on --oc-hue-solid', (_look, sel, layers) => {
    const solid = readTokenIn(blockFor(sel), 'oc-hue-solid')!;
    expect(contrast(resolve(layers, 'on-hue'), solid)).toBeGreaterThanOrEqual(AA);
  });

  // Without this, the literals above could be measured while the app renders
  // something else entirely.
  it('maps every hue role onto a measured literal', () => {
    const pin = blockFor('html[data-palette="orange-charcoal"] [data-provider]');
    expect(pin).toContain('--hue: var(--oc-hue)');
    expect(pin).toContain('--hue-text: var(--oc-hue-text)');
    expect(pin).toContain('--hue-solid: var(--oc-hue-solid)');
  });
});

describe('orange-dark palette hue', () => {
  const LOOKS = [
    ['orange-dark dark', OD, THEMES['orange-dark dark']],
    ['orange-dark light', OD_LIGHT, THEMES['orange-dark light']],
  ] as const;

  it.each(LOOKS)('%s --od-hue-text clears AA on every surface', (_look, sel, layers) => {
    const hueText = readTokenIn(blockFor(sel), 'od-hue-text')!;
    for (const surface of SURFACES) {
      expect(
        contrast(hueText, resolve(layers, surface)),
        `--od-hue-text on --${surface}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it.each(LOOKS)('%s --od-hue clears 3:1 on every surface', (_look, sel, layers) => {
    const hue = readTokenIn(blockFor(sel), 'od-hue')!;
    for (const surface of SURFACES) {
      expect(
        contrast(hue, resolve(layers, surface)),
        `--od-hue on --${surface}`,
      ).toBeGreaterThanOrEqual(AA_NON_TEXT);
    }
  });

  it.each(LOOKS)('%s --on-hue clears AA on --od-hue-solid', (_look, sel, layers) => {
    const solid = readTokenIn(blockFor(sel), 'od-hue-solid')!;
    expect(contrast(resolve(layers, 'on-hue'), solid)).toBeGreaterThanOrEqual(AA);
  });

  it('maps every hue role onto a measured literal', () => {
    const pin = blockFor('html[data-palette="orange-dark"] [data-provider]');
    expect(pin).toContain('--hue: var(--od-hue)');
    expect(pin).toContain('--hue-text: var(--od-hue-text)');
    expect(pin).toContain('--hue-solid: var(--od-hue-solid)');
  });
});

/**
 * `html[data-palette="orange-charcoal"]` is (0,1,1) and `[data-theme="light"]` is
 * (0,1,0), so the palette's dark values outrank the light theme. Any colour the
 * dark block declares and the light block forgets leaks into light mode — and
 * for `--ink` that is near-white text on near-white paper, with every contrast
 * assertion above still green because they resolve the stack correctly.
 *
 * So the coverage itself is the assertion.
 */
describe('orange-charcoal palette: light covers dark', () => {
  it('redeclares every colour the dark block declares', () => {
    const dark = blockFor(OC);
    const light = blockFor(OC_LIGHT);
    const declared = [...dark.matchAll(/--([a-z0-9-]+)\s*:\s*(?:#|rgba?\()/g)].map((m) => m[1]);
    expect(declared.length, 'the dark palette block declares no colours').toBeGreaterThan(0);
    const missing = declared.filter((name) => !new RegExp(`--${name}\\s*:`).test(light));
    expect(missing, 'these leak dark values into light mode').toEqual([]);
  });
});

describe('orange-dark palette: light covers dark', () => {
  it('redeclares every colour the dark block declares', () => {
    const dark = blockFor(OD);
    const light = blockFor(OD_LIGHT);
    const declared = [...dark.matchAll(/--([a-z0-9-]+)\s*:\s*(?:#|rgba?\()/g)].map((m) => m[1]);
    expect(declared.length, 'the dark palette block declares no colours').toBeGreaterThan(0);
    const missing = declared.filter((name) => !new RegExp(`--${name}\\s*:`).test(light));
    expect(missing, 'these leak dark values into light mode').toEqual([]);
  });
});
