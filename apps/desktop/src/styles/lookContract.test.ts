/**
 * Axis-orthogonality guard (theming Phase 2, docs/theming/decisions.md P1.1).
 *
 * `look` (`html[data-look]`, structure) and `palette` (`html[data-palette]`,
 * colour) are meant to be freely mixable — Appearance → Advanced lets a user
 * pick either independently of the other. That only holds if neither axis
 * ever declares a token that belongs to the other: a look that sneaks in a
 * colour, or a palette that sneaks in a structural token, silently breaks a
 * combination nobody tested.
 *
 * This file is a text parser of tokens.css and packages/ui/src/looks/*.css —
 * no browser, no CSSOM — so it stays fast and runs everywhere vitest does.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LOOK_IDS } from '../themes/registry';

const here = dirname(fileURLToPath(import.meta.url));
const UI_SRC = join(here, '..', '..', '..', '..', 'packages', 'ui', 'src');
const TOKENS_PATH = join(UI_SRC, 'tokens.css');
const LOOKS_DIR = join(UI_SRC, 'looks');

const tokensCss = readFileSync(TOKENS_PATH, 'utf8').replace(/\r\n/g, '\n');

/* ── A small, shared CSS block parser ─────────────────────────────────────
 * Strips comments, then walks brace depth. Top-level rules are captured
 * directly; `@media`/`@supports` bodies are walked exactly one level deep (so
 * a rule inside one of those is captured too, but a rule nested two levels
 * deep — which nothing here uses — is not). Any other at-rule (`@font-face`,
 * `@import`, `@keyframes`, …) is left unwalked: its body never becomes a
 * `Block`, so it can never accidentally satisfy a "declares no colour token"
 * check by omission. Banning those at-rules outright is done separately, by
 * a plain text search over the whole file (see BANNED_AT_RULES below). */

interface Block {
  /** Comma-separated selector members, each whitespace-normalised. */
  selectors: string[];
  /** Raw declaration text inside the `{ … }`. */
  decls: string;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function parseBlocks(css: string): Block[] {
  const src = stripComments(css);
  const blocks: Block[] = [];

  function walk(text: string, atDepth: number): void {
    let head = '';
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (c === '{') {
        const header = head.trim();
        let depth = 1;
        let j = i + 1;
        while (j < text.length && depth > 0) {
          if (text[j] === '{') depth += 1;
          else if (text[j] === '}') depth -= 1;
          j += 1;
        }
        const inner = text.slice(i + 1, j - 1);
        if (header.startsWith('@')) {
          if (atDepth === 0 && /^@(media|supports)\b/.test(header)) {
            walk(inner, atDepth + 1);
          }
          // Other at-rules (@font-face, @import has no block anyway,
          // @keyframes, …) are deliberately not walked into.
        } else {
          blocks.push({
            selectors: header.split(',').map((s) => s.trim().replace(/\s+/g, ' ')),
            decls: inner,
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
  }

  walk(src, 0);
  return blocks;
}

/** `{ prop, value }` pairs from a block's declaration text. */
interface Decl {
  prop: string;
  value: string;
}

function splitDecls(decls: string): Decl[] {
  const out: Decl[] = [];
  for (const stmt of decls.split(';')) {
    const trimmed = stmt.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(':');
    if (idx === -1) continue;
    out.push({ prop: trimmed.slice(0, idx).trim(), value: trimmed.slice(idx + 1).trim() });
  }
  return out;
}

/** Custom-property names (`--foo`) declared (LHS) anywhere in `decls`. */
function customPropNames(decls: string): string[] {
  return [...decls.matchAll(/--([a-zA-Z0-9-]+)\s*:/g)].map((m) => `--${m[1]}`);
}

/** Escape a literal string for embedding in a RegExp. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does `decls` mention `prop`, either as a declaration or as `var(prop)`? */
function propOccursIn(decls: string, prop: string): boolean {
  const re = new RegExp(`${reEscape(prop)}(?![\\w-])`);
  return re.test(decls);
}

/* ── tokens.css: parse once, reuse across describes ──────────────────────── */

const TOKEN_BLOCKS = parseBlocks(tokensCss);

function isPaletteSelector(selector: string): boolean {
  return /data-palette="[^"]+"/.test(selector);
}

function paletteIdOf(selectors: string[]): string {
  for (const s of selectors) {
    const m = s.match(/data-palette="([^"]+)"/);
    if (m) return m[1];
  }
  throw new Error(`no data-palette id found in [${selectors.join(', ')}]`);
}

const PALETTE_BLOCKS = TOKEN_BLOCKS.filter((b) => b.selectors.some(isPaletteSelector));

/** The single base `[data-theme="light"]` block (not a compound/palette variant). */
const LIGHT_BLOCK = TOKEN_BLOCKS.find(
  (b) => b.selectors.length === 1 && b.selectors[0] === '[data-theme="light"]',
);
if (!LIGHT_BLOCK) {
  throw new Error('tokens.css has no top-level [data-theme="light"] block');
}

/**
 * The "colour token" vocabulary: every custom property declared in the base
 * light block, plus every custom property declared in any `html[data-palette=…]`
 * block (light/compound/descendant variants included — `PALETTE_BLOCKS` above
 * already covers those, including the one level of `@supports` this parser
 * walks into). The palette union matters because a few colour roles (`--hue`,
 * `--hue-text`, `--hue-solid`, `--hue-weak`, …) are theme-agnostic and live
 * only in `:root` plus the palettes' own `[data-provider]` pin rules — never
 * in `[data-theme="light"]` itself.
 */
const COLOUR_TOKENS = new Set<string>([
  ...customPropNames(LIGHT_BLOCK.decls),
  ...PALETTE_BLOCKS.flatMap((b) => customPropNames(b.decls)),
]);

/**
 * A property is private to `paletteId` iff every block anywhere in tokens.css
 * that mentions it (as a declaration or a `var()` reference) is itself scoped
 * to that same palette id. `--oc-hue` (only ever mentioned inside
 * `html[data-palette="orange-charcoal"]…` rules) is private; `--bg` (mentioned
 * in `:root`, in every palette's block, …) is not.
 */
function isPrivateToPalette(prop: string, paletteId: string): boolean {
  const referencing = TOKEN_BLOCKS.filter((b) => propOccursIn(b.decls, prop));
  if (referencing.length === 0) return false;
  const scoped = `data-palette="${paletteId}"`;
  return referencing.every((b) => b.selectors.every((s) => s.includes(scoped)));
}

/** A palette may pick the reading face without that counting as a colour. */
const PALETTE_EXTRA_ALLOWLIST = new Set(['--font-prose']);

describe('palette blocks declare only colour tokens, private inputs, or --font-prose', () => {
  it.each(PALETTE_BLOCKS.map((b) => [b.selectors.join(', '), b] as const))('%s', (_label, block) => {
    const paletteId = paletteIdOf(block.selectors);
    const offenders = customPropNames(block.decls).filter(
      (prop) =>
        !PALETTE_EXTRA_ALLOWLIST.has(prop) &&
        !isPrivateToPalette(prop, paletteId) &&
        !COLOUR_TOKENS.has(prop),
    );
    expect(
      offenders,
      `${block.selectors.join(', ')} declares properties that are neither colour tokens, ` +
        `private to "${paletteId}", nor --font-prose`,
    ).toEqual([]);
  });
});

/* ── Look sheets: packages/ui/src/looks/*.css ─────────────────────────────── */

describe('every non-default look has a look sheet', () => {
  const nonDefaultLooks = LOOK_IDS.filter((id) => id !== 'soft');

  // Passes vacuously today (LOOK_IDS === ['soft'], so there is nothing to
  // check yet), but the mechanism fires the moment a second look (e.g.
  // Phase 3's `terminal`) joins the registry. `it.each` on an empty array
  // errors ("No test found in suite") rather than skipping quietly, so the
  // vacuous case gets its own explicit assertion instead.
  if (nonDefaultLooks.length === 0) {
    it('has no non-default look to check yet', () => {
      expect(nonDefaultLooks).toEqual([]);
    });
  } else {
    it.each(nonDefaultLooks)('%s → packages/ui/src/looks/%s.css exists', (id) => {
      expect(
        existsSync(join(LOOKS_DIR, `${id}.css`)),
        `expected ${join(LOOKS_DIR, `${id}.css`)}`,
      ).toBe(true);
    });
  }
});

const lookFiles = existsSync(LOOKS_DIR)
  ? readdirSync(LOOKS_DIR, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith('.css'))
      .map((entry) => entry.name)
  : [];

/** Colour-bearing standard (non-custom-property) declarations. */
const COLOUR_BEARING_PROPS = new Set([
  'color',
  'background',
  'background-color',
  'border-color',
  'outline-color',
  'fill',
  'stroke',
  'box-shadow',
]);

/**
 * CSS Color Module Level 4's named colour keywords, minus the three the
 * contract explicitly allows (`transparent`, `currentColor`, `inherit` — none
 * of which are in this list to begin with, so no exclusion is needed beyond
 * simply not adding them).
 */
const NAMED_COLORS = [
  'aliceblue','antiquewhite','aqua','aquamarine','azure','beige','bisque','black',
  'blanchedalmond','blue','blueviolet','brown','burlywood','cadetblue','chartreuse',
  'chocolate','coral','cornflowerblue','cornsilk','crimson','cyan','darkblue','darkcyan',
  'darkgoldenrod','darkgray','darkgreen','darkgrey','darkkhaki','darkmagenta',
  'darkolivegreen','darkorange','darkorchid','darkred','darksalmon','darkseagreen',
  'darkslateblue','darkslategray','darkslategrey','darkturquoise','darkviolet','deeppink',
  'deepskyblue','dimgray','dimgrey','dodgerblue','firebrick','floralwhite','forestgreen',
  'fuchsia','gainsboro','ghostwhite','gold','goldenrod','gray','green','greenyellow','grey',
  'honeydew','hotpink','indianred','indigo','ivory','khaki','lavender','lavenderblush',
  'lawngreen','lemonchiffon','lightblue','lightcoral','lightcyan','lightgoldenrodyellow',
  'lightgray','lightgreen','lightgrey','lightpink','lightsalmon','lightseagreen',
  'lightskyblue','lightslategray','lightslategrey','lightsteelblue','lightyellow','lime',
  'limegreen','linen','magenta','maroon','mediumaquamarine','mediumblue','mediumorchid',
  'mediumpurple','mediumseagreen','mediumslateblue','mediumspringgreen','mediumturquoise',
  'mediumvioletred','midnightblue','mintcream','mistyrose','moccasin','navajowhite','navy',
  'oldlace','olive','olivedrab','orange','orangered','orchid','palegoldenrod','palegreen',
  'paleturquoise','palevioletred','papayawhip','peachpuff','peru','pink','plum','powderblue',
  'purple','rebeccapurple','red','rosybrown','royalblue','saddlebrown','salmon','sandybrown',
  'seagreen','seashell','sienna','silver','skyblue','slateblue','slategray','slategrey',
  'snow','springgreen','steelblue','tan','teal','thistle','tomato','turquoise','violet',
  'wheat','white','whitesmoke','yellow','yellowgreen',
];
const NAMED_COLOR_RE = new RegExp(`\\b(?:${NAMED_COLORS.join('|')})\\b`, 'i');

function hasColorLiteral(value: string): boolean {
  if (/#[0-9a-fA-F]{3,8}\b/.test(value)) return true;
  if (/\b(?:rgb|rgba|hsl|hsla)\s*\(/i.test(value)) return true;
  return NAMED_COLOR_RE.test(value);
}

describe.each(lookFiles)('look sheet: %s', (filename) => {
  const id = filename.replace(/\.css$/, '');
  const raw = readFileSync(join(LOOKS_DIR, filename), 'utf8').replace(/\r\n/g, '\n');
  const stripped = stripComments(raw);
  const blocks = parseBlocks(raw);
  const scope = `html[data-look="${id}"]`;

  it('has no @import', () => {
    expect(/@import\b/i.test(stripped)).toBe(false);
  });

  it('has no @font-face', () => {
    expect(/@font-face\b/i.test(stripped)).toBe(false);
  });

  it('has no url(...)', () => {
    expect(/\burl\(/i.test(stripped)).toBe(false);
  });

  it(`every selector is scoped under ${scope} (matching the filename)`, () => {
    const offenders = blocks.flatMap((b) => b.selectors).filter((s) => !s.startsWith(scope));
    expect(offenders).toEqual([]);
  });

  it('declares no custom property from the colour-token set', () => {
    const offenders: string[] = [];
    for (const b of blocks) {
      for (const prop of customPropNames(b.decls)) {
        if (COLOUR_TOKENS.has(prop)) offenders.push(prop);
      }
    }
    expect(offenders, 'these belong to the palette axis, not the look axis').toEqual([]);
  });

  it('declares no literal colour value in a custom property', () => {
    const offenders: string[] = [];
    for (const b of blocks) {
      for (const { prop, value } of splitDecls(b.decls)) {
        if (prop.startsWith('--') && hasColorLiteral(value)) {
          offenders.push(`${prop}: ${value}`);
        }
      }
    }
    expect(offenders, 'a look may reference colour via var(), never declare it').toEqual([]);
  });

  it('colour-bearing properties use var(), not literal colours', () => {
    const offenders: string[] = [];
    for (const b of blocks) {
      for (const { prop, value } of splitDecls(b.decls)) {
        if (COLOUR_BEARING_PROPS.has(prop) && hasColorLiteral(value)) {
          offenders.push(`${prop}: ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
