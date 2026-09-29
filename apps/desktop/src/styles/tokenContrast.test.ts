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
 *
 * The set of looks this file checks is registry-driven (Phase 2): every
 * `PALETTE_IDS` entry × the modes `modesForPalette` says it supports. Adding a
 * palette to the registry (and its block(s) to tokens.css) is automatically
 * covered here without touching this file — see themes/registry.ts.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PALETTE_IDS, modesForPalette } from '../themes/registry';
import { PINNED_PALETTE } from '../shell/uiPrefs';

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

/** Whether any top-level rule declares `selector` among its comma-separated members. */
function hasSelector(selector: string): boolean {
  return RULES.some((r) => r.selectors.includes(selector));
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
 * The palette selector for a non-`terra` palette id.
 *
 * `terra` is the base look: it has no `html[data-palette]` block of its own —
 * `:root` / `[data-theme="light"]` already *are* Terra — so it is handled
 * separately below rather than through this helper.
 */
function paletteSelector(id: string): string {
  return `html[data-palette="${id}"]`;
}

function paletteLightSelector(id: string): string {
  return `${paletteSelector(id)}[data-theme="light"]`;
}

/**
 * The looks the app can render, one entry per palette × supported mode. Each
 * is a *stack* of token layers in cascade order, because a palette is a delta
 * over a theme — it declares only what it changes.
 *
 * The non-terra light stacks list the palette's base block after
 * `[data-theme="light"]` deliberately: `html[data-palette="…"]` is (0,1,1)
 * and `[data-theme="light"]` is (0,1,0), so in the browser the palette's dark
 * values *do* outrank the light theme. That is why the light palette block has
 * to redeclare every colour the dark one does, and why the coverage test below
 * exists.
 *
 * A palette whose `modesForPalette` is `['light']` only (e.g. `paper`) is the
 * exception: it never meets dark (resolveTheme() forces light), so its base
 * `html[data-palette="…"]` block *is* the light values — there is no separate
 * `[data-theme="light"]` compound block to layer on top of it, and none is
 * required. Its stack is still resolved on top of `[data-theme="light"]` so a
 * token the palette leaves undeclared falls through to the light theme
 * default rather than the dark one.
 *
 * Registry-driven (Phase 2): built from `PALETTE_IDS` × `modesForPalette`, so a
 * new palette (and its tokens.css block(s)) is covered the moment it lands in
 * the registry, with no edit here.
 */
const THEMES: Record<string, readonly string[]> = {};
for (const id of PALETTE_IDS) {
  const modes = modesForPalette(id);
  if (id === 'terra') {
    THEMES['terra dark'] = [':root'];
    if (modes.includes('light')) THEMES['terra light'] = [':root', '[data-theme="light"]'];
    continue;
  }
  const dark = paletteSelector(id);
  const light = paletteLightSelector(id);
  const lightOnly = modes.length === 1 && modes[0] === 'light';
  if (lightOnly) {
    THEMES[`${id} light`] = [':root', '[data-theme="light"]', dark];
    continue;
  }
  THEMES[`${id} dark`] = [':root', dark];
  if (modes.includes('light')) {
    THEMES[`${id} light`] = [':root', '[data-theme="light"]', dark, light];
  }
}

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
 *
 * These roles are declared theme-wide (`[data-provider="…"]`, not scoped to a
 * palette), so they are checked once against Terra's surfaces regardless of
 * how many palettes the registry lists.
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
 * ADR-011 (one design, two modes): the accent and signal roles, measured on
 * the base stacks the renderer pins (`applyPalette` always writes `terra`).
 *
 *   --accent        fills and graphics — 3:1 on every surface
 *   --accent-text   the accent as literal text — AA on every surface
 *   --on-accent     glyphs on an --accent fill (send button, .btn.primary) — AA
 *   --signal        running-state graphics — 3:1;  --signal-text — AA
 *
 * Rail labels are ink-3 on --bg-rail, so the rail joins the surface list for
 * the ink ramp here rather than in SURFACES (which the retired palettes, having
 * no rail colour, cannot satisfy).
 */
describe.each(['dark', 'light'] as const)('Nocturne (%s): accent, signal and rail', (mode) => {
  const layers = TERRA[mode];
  const surfaces = SURFACES.map((s) => [s, resolve(layers, s)] as const);

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
  it.each(INKS)('--%s clears AA on --bg-rail', (ink) => {
    expect(contrast(resolve(layers, ink), resolve(layers, 'bg-rail'))).toBeGreaterThanOrEqual(AA);
  });
});

describe('Nocturne accent pin', () => {
  const pin = blockFor('html[data-palette="terra"] [data-provider]');

  it('maps every hue role on [data-provider] elements onto the accent', () => {
    expect(pin).toContain('--hue: var(--accent)');
    expect(pin).toContain('--hue-text: var(--accent-text)');
    expect(pin).toContain('--hue-solid: var(--accent)');
    expect(pin).toContain('--on-hue: var(--on-accent)');
    expect(pin).toContain('--hue-weak: var(--accent-soft)');
  });

  it('covers <html> itself too, which carries the active provider', () => {
    expect(hasSelector('html[data-palette="terra"][data-provider]')).toBe(true);
  });

  it('pins the palette the renderer applies, which has no block of its own', () => {
    expect(PINNED_PALETTE).toBe('terra');
    expect(hasSelector(paletteSelector('terra'))).toBe(false);
  });

  it('keeps provider identity available as --provider-hue', () => {
    for (const provider of PROVIDERS) {
      expect(readTokenIn(hueBlockFor('dark', provider), 'provider-hue'), provider).not.toBeNull();
      expect(readTokenIn(hueBlockFor('light', provider), 'provider-hue'), provider).not.toBeNull();
    }
  });
});

/**
 * Some palettes pin one identity across every provider through private
 * `--<prefix>-hue*` literals rather than by declaring `--hue` directly — so
 * that the rule doing the assigning can stay theme-agnostic and lose to
 * `provider-colour: off` on source order (see the orange-charcoal/orange-dark
 * blocks in tokens.css).
 *
 * That indirection costs the checks above their subject: under such a palette
 * `--hue` is a `var()`, which `readTokenIn` cannot see. This section puts the
 * subject back for *any* palette that declares the pin — the literals are
 * measured, and the mapping from literal to role is asserted, so the two
 * cannot drift apart.
 *
 * Registry-driven: a palette is included here iff tokens.css declares
 * `html[data-palette="<id>"] [data-provider]` (the pinned-hue rule), and the
 * private variable names are read out of that rule's own text rather than
 * hardcoded — so this generalizes to any future pinning palette (Phase 3's
 * `amber`, if it pins) with no edit here.
 */
function pinSelector(id: string): string {
  return `${paletteSelector(id)} [data-provider]`;
}

interface PinnedHueVars {
  hue: string;
  hueText: string;
  hueSolid: string;
}

function pinnedHueVars(pin: string): PinnedHueVars | null {
  const hue = pin.match(/--hue:\s*var\((--[a-z0-9-]+)\)/)?.[1];
  const hueText = pin.match(/--hue-text:\s*var\((--[a-z0-9-]+)\)/)?.[1];
  const hueSolid = pin.match(/--hue-solid:\s*var\((--[a-z0-9-]+)\)/)?.[1];
  if (!hue || !hueText || !hueSolid) return null;
  return { hue, hueText, hueSolid };
}

const PINNED_PALETTES = PALETTE_IDS.filter((id) => id !== 'terra' && hasSelector(pinSelector(id)));

describe.each(PINNED_PALETTES)('%s palette hue (pinned via [data-provider])', (id) => {
  const dark = paletteSelector(id);
  const light = paletteLightSelector(id);
  const pin = blockFor(pinSelector(id));
  const vars = pinnedHueVars(pin);

  it('pins --hue / --hue-text / --hue-solid to private var() tokens', () => {
    expect(vars, `${pinSelector(id)} does not map --hue/--hue-text/--hue-solid to var(--private) tokens`).not.toBeNull();
  });

  const paletteModes = modesForPalette(id);
  const lightOnly = paletteModes.length === 1 && paletteModes[0] === 'light';
  // A light-only palette (e.g. `paper`) has no dark block at all — its base
  // selector already holds the light values (see the THEMES-building comment
  // near the top of this file) — so its only entry probes the base selector
  // under the `THEMES['<id> light']` stack, not a separate compound block.
  const modes: Array<readonly [mode: 'dark' | 'light', sel: string, layers: readonly string[]]> = lightOnly
    ? [['light', dark, THEMES[`${id} light`]]]
    : [['dark', dark, THEMES[`${id} dark`]]];
  if (!lightOnly && paletteModes.includes('light')) {
    modes.push(['light', light, THEMES[`${id} light`]]);
  }

  it.each(modes)('%s --hue-text clears AA on every surface', (_mode, sel, layers) => {
    const hueText = readTokenIn(blockFor(sel), vars!.hueText.slice(2))!;
    for (const surface of SURFACES) {
      expect(
        contrast(hueText, resolve(layers, surface)),
        `${vars!.hueText} on --${surface}`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it.each(modes)('%s --hue clears 3:1 on every surface', (_mode, sel, layers) => {
    const hue = readTokenIn(blockFor(sel), vars!.hue.slice(2))!;
    for (const surface of SURFACES) {
      expect(contrast(hue, resolve(layers, surface)), `${vars!.hue} on --${surface}`).toBeGreaterThanOrEqual(
        AA_NON_TEXT,
      );
    }
  });

  it.each(modes)('%s --on-hue clears AA on the pinned hue-solid', (_mode, sel, layers) => {
    const solid = readTokenIn(blockFor(sel), vars!.hueSolid.slice(2))!;
    expect(contrast(resolve(layers, 'on-hue'), solid)).toBeGreaterThanOrEqual(AA);
  });

  // Without this, the literals above could be measured while the app renders
  // something else entirely.
  it('maps every hue role onto the measured literal', () => {
    expect(pin).toContain(`--hue: var(${vars!.hue})`);
    expect(pin).toContain(`--hue-text: var(${vars!.hueText})`);
    expect(pin).toContain(`--hue-solid: var(${vars!.hueSolid})`);
  });
});

/**
 * `html[data-palette="<id>"]` is (0,1,1) and `[data-theme="light"]` is (0,1,0),
 * so the palette's dark values outrank the light theme. Any colour the dark
 * block declares and the light block forgets leaks into light mode — and for
 * `--ink` that is near-white text on near-white paper, with every contrast
 * assertion above still green because they resolve the stack correctly.
 *
 * So the coverage itself is the assertion. Registry-driven: runs for every
 * non-terra palette that supports BOTH modes — a light-only palette (e.g.
 * `paper`) has no separate dark block for its light block to cover, so this
 * check does not apply to it (see the THEMES-building comment above).
 */

/**
 * `--field-line` (text-field and dropdown border) is a `color-mix` of each
 * palette's `--ink-3` into its `--bg`, not a literal, so every palette gets it
 * without a value of its own. Resolve it the way the browser does (sRGB, by the
 * declared share) and hold it to the non-text minimum on every surface a field
 * sits on or is filled with.
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

describe.each(Object.entries(THEMES))('%s: field border', (_look, layers) => {
  const line = mixHex(resolve(layers, 'ink-3'), resolve(layers, 'bg'), fieldLineShare(layers));
  it.each(SURFACES)('--field-line on --%s clears 3:1', (surface) => {
    expect(contrast(line, resolve(layers, surface))).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

const LIGHT_CAPABLE_PALETTES = PALETTE_IDS.filter(
  (id) => id !== 'terra' && modesForPalette(id).includes('light') && modesForPalette(id).includes('dark'),
);

describe.each(LIGHT_CAPABLE_PALETTES)('%s palette: light covers dark', (id) => {
  it('redeclares every colour the dark block declares', () => {
    const dark = blockFor(paletteSelector(id));
    const light = blockFor(paletteLightSelector(id));
    const declared = [...dark.matchAll(/--([a-z0-9-]+)\s*:\s*(?:#|rgba?\()/g)].map((m) => m[1]);
    expect(declared.length, 'the dark palette block declares no colours').toBeGreaterThan(0);
    const missing = declared.filter((name) => !new RegExp(`--${name}\\s*:`).test(light));
    expect(missing, 'these leak dark values into light mode').toEqual([]);
  });
});

/**
 * Block-existence coverage: every palette the registry names must actually
 * have the tokens.css blocks its modes promise, or the whole suite above is
 * silently vacuous (`blockFor` only throws for a selector some *other* rule
 * still happens to declare; a palette with *no* block at all would just never
 * be exercised).
 */
describe('palette block coverage (registry vs. tokens.css)', () => {
  it.each(PALETTE_IDS.filter((id) => id !== 'terra'))('%s has a dark block', (id) => {
    expect(hasSelector(paletteSelector(id)), `expected ${paletteSelector(id)} in tokens.css`).toBe(true);
  });

  it.each(PALETTE_IDS.filter((id) => id !== 'terra'))(
    '%s has a light block iff its registry modes are exactly [dark, light]',
    (id) => {
      const modes = modesForPalette(id);
      const needsCompoundLightBlock = modes.includes('light') && modes.includes('dark');
      const hasLightBlock = hasSelector(paletteLightSelector(id));
      if (needsCompoundLightBlock) {
        expect(hasLightBlock, `${id} supports both modes but has no ${paletteLightSelector(id)} block`).toBe(
          true,
        );
      }
      // Dark-only and light-only palettes are not required to omit a compound
      // light block (one would simply be unused); a light-only palette's base
      // block already *is* the light values (see the THEMES-building comment
      // above), so it needs no separate `[data-theme="light"]` block at all.
    },
  );
});

/**
 * WCAG AAA (enhanced) minimum for normal text. The `contrast` palette ("High
 * Contrast") targets this floor explicitly for every ink/status/link/code
 * token on every surface — a stricter bar than the AA the rest of the suite
 * enforces, so it gets its own threshold and its own describe rather than
 * weakening the shared one above.
 */
const AAA = 7;

describe.each(
  (['dark', 'light'] as const).filter((m) => modesForPalette('contrast').includes(m)),
)('contrast palette (%s): AAA (7:1) for ink/status/link/code', (mode) => {
  const layers = THEMES[`contrast ${mode}`];
  const surfaces = Object.fromEntries(SURFACES.map((s) => [s, resolve(layers, s)]));
  const tokens = [...INKS, 'ok', 'warn', 'err', 'link', 'code'] as const;

  it.each(tokens.flatMap((t) => SURFACES.map((s) => [t, s] as const)))(
    '--%s on --%s clears AAA',
    (token, surface) => {
      expect(contrast(resolve(layers, token), surfaces[surface])).toBeGreaterThanOrEqual(AAA);
    },
  );
});

/**
 * The contrast palette also targets >=3:1 (the non-text floor) for --line
 * against every surface, so borders stay visible under the contrast look's
 * heavier-border treatment — ordinary palettes only need --line to be
 * present, not measurably visible.
 */
describe.each(
  (['dark', 'light'] as const).filter((m) => modesForPalette('contrast').includes(m)),
)('contrast palette (%s): --line clears 3:1 on every surface', (mode) => {
  const layers = THEMES[`contrast ${mode}`];
  const surfaces = Object.fromEntries(SURFACES.map((s) => [s, resolve(layers, s)]));

  it.each(SURFACES)('--line on --%s', (surface) => {
    expect(contrast(resolve(layers, 'line'), surfaces[surface])).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

/**
 * --hue-solid always carries --on-hue on top of it (the send button glyph,
 * `.btn.primary`'s label), so this must clear AA for every palette in every
 * mode it renders — not just the palettes already covered by the two
 * describes above ("provider hue: solid fill role" for terra's per-provider
 * hue, and the pinned-hue describe for palettes that pin --hue/--hue-solid to
 * private var() tokens).
 *
 * Every non-terra palette here pins its hue (tokens.css's
 * `[data-provider]` rule), so `PINNED_PALETTES` — computed above from
 * tokens.css itself, not hardcoded — already equals every non-terra
 * `PALETTE_IDS` entry, and its per-mode "clears AA on the pinned hue-solid"
 * test already re-checks this for each of them. This block is the explicit,
 * registry-wide assertion that no non-terra palette has silently fallen out
 * of that coverage (e.g. by declaring --hue directly instead of pinning it),
 * which would make the check above pass vacuously by never running for it.
 */
describe('--hue-solid vs --on-hue clears AA for every palette/mode (registry-wide)', () => {
  const nonTerraPalettes = PALETTE_IDS.filter((id) => id !== 'terra');

  it('every non-terra palette pins --hue via [data-provider] (or is reported here, not silently skipped)', () => {
    const unpinned = nonTerraPalettes.filter((id) => !PINNED_PALETTES.includes(id));
    expect(
      unpinned,
      'these palettes declare no [data-provider] pin rule, so their --hue-solid vs --on-hue pairing is ' +
        'unchecked — either add the pin (see amber/orange-charcoal) or add bespoke coverage for them here',
    ).toEqual([]);
  });

  // terra itself is covered by "provider hue: solid fill role" above, across
  // both themes and all four providers.
  it('terra is covered by the provider hue describes above', () => {
    expect(THEME_PROVIDERS.length).toBeGreaterThan(0);
  });
});
