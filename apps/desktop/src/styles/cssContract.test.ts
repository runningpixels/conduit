/**
 * CSS contract guards.
 *
 * The V7 overhaul shipped five phases and a full review while looking badly
 * broken, because the two gates in use — `tsc -b` and vitest — cannot see a
 * grey box. Both failures below are statically detectable, so they are checked
 * here rather than left to a screenshot.
 *
 *   1. The button reset. Every V7 component class is ported from
 *      conduit-v7-proposal.html, which zeroes the UA button chrome before
 *      styling anything. Without that rule ~31 buttons across 11 classes fall
 *      back to Chromium's ButtonFace (#6b6b6b under `color-scheme: dark`).
 *   2. Orphan classes. A className with no matching rule anywhere renders as an
 *      unstyled UA default. 49 elements were in that state when this landed.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');
const repoRoot = join(srcRoot, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const cssFiles = [
  ...walk(join(srcRoot, 'styles')).filter((f) => f.endsWith('.css')),
  join(repoRoot, 'packages', 'ui', 'src', 'tokens.css'),
];

/** Every class name that appears in any selector in any stylesheet. */
function styledClasses(): Set<string> {
  const out = new Set<string>();
  for (const f of cssFiles) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(m[1]);
  }
  return out;
}

/**
 * Scan forward from a `<` to the `>` that closes the opening tag, tracking
 * brace depth and quotes so that JSX expressions containing `>` — an arrow
 * function in an `onClick`, most commonly — do not end the tag early.
 */
function openingTagEnd(src: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === quote && src[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return i;
    else if (c === '<' && i > start) return -1; // ran into the next tag
  }
  return -1;
}

interface TagRef {
  file: string;
  line: number;
  tag: string;
  classes: string[];
}

function domElementsWithClasses(): TagRef[] {
  const files = walk(srcRoot).filter((f) => /\.tsx$/.test(f) && !/\.test\./.test(f));
  const refs: TagRef[] = [];
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/<([A-Za-z][A-Za-z0-9]*)\b/g)) {
      const tag = m[1];
      // React components style themselves; only DOM elements need a rule.
      if (/^[A-Z]/.test(tag)) continue;
      const end = openingTagEnd(src, m.index! + m[0].length);
      if (end === -1) continue;
      const attrs = src.slice(m.index! + m[0].length, end);
      if (/style=\{\{/.test(attrs)) continue; // inline-styled on purpose
      const cm = attrs.match(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/);
      if (!cm) continue;
      const raw = (cm[1] || cm[2] || cm[3] || '').replace(/\$\{[^}]*\}/g, ' ');
      const classes = raw.split(/\s+/).filter(Boolean);
      if (classes.length === 0) continue;
      refs.push({
        file: relative(repoRoot, file).replace(/\\/g, '/'),
        line: src.slice(0, m.index).split('\n').length,
        tag,
        classes,
      });
    }
  }
  return refs;
}

/**
 * Elements whose styling comes from a descendant or element selector rather
 * than from a class of their own — `.composer textarea` styles the composer's
 * textarea, so `.composer-textarea` needs no rule. Each entry must name the
 * selector that does the work.
 */
const STYLED_BY_ANCESTOR: Record<string, string> = {
  'composer-textarea': '.composer textarea (chat.css)',
};

describe('button reset', () => {
  const tokens = readFileSync(join(repoRoot, 'packages', 'ui', 'src', 'tokens.css'), 'utf8');

  // The bare `button { … }` element rule, comments stripped.
  const rule = tokens
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .match(/(^|\})\s*button\s*\{([^}]*)\}/);

  it('exists as a bare element selector in tokens.css', () => {
    expect(rule, 'no `button { … }` rule found in tokens.css').not.toBeNull();
  });

  // Without all three, ported classes that declare none of their own fall back
  // to Chromium's ButtonFace / ButtonBorder / UA padding.
  it.each(['background', 'border', 'padding'])('zeroes %s', (prop) => {
    const decls = rule?.[2] ?? '';
    expect(decls).toMatch(new RegExp(`(^|[;\\s])${prop}\\s*:\\s*(none|0|transparent)`));
  });
});

/**
 * The orphan-class test below only inspects elements that *have* a `className`,
 * so unclassed DOM inheriting a UA style is its blind spot. That is exactly how
 * markdown links shipped in Chromium's periwinkle: `safeMarkdown` emits a bare
 * `<a>`, and no `a` selector existed anywhere in the product.
 */
describe('unclassed element defaults', () => {
  const allCss = cssFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

  it('styles anchors, so links never fall back to the UA colour', () => {
    const stripped = allCss.replace(/\/\*[\s\S]*?\*\//g, '');
    // Any selector ending in a bare `a` — `a {`, `.chat-prose a {`, `a:hover {`.
    const anchorRule = /(^|[},])\s*[^{}]*(^|[\s>~+])a\s*(:[a-z-]+)?\s*(,[^{}]*)?\{[^}]*color\s*:/m.test(
      stripped,
    );
    expect(anchorRule, 'no rule sets `color` on an anchor in any stylesheet').toBe(true);
  });
});

describe('user turn alignment', () => {
  // `.turn.user` holds three children: `.bubble`, the interrupted banner and
  // `.turn-actions`. As a row, the `opacity: 0` action bar still claimed ~170px
  // of track to the right of the bubble, so `justify-content: flex-end`
  // right-aligned the *pair* — every user bubble stopped short of the column
  // edge and read as centred, and long ones shrank below their max-width.
  // Invisible to tsc and to every rendering test, so it is pinned here.
  const chat = readFileSync(join(srcRoot, 'styles', 'chat.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const rule = chat.match(/(^|\})\s*\.turn\.user\s*\{([^}]*)\}/);

  it('has a .turn.user rule', () => {
    expect(rule, 'no `.turn.user { … }` rule found in chat.css').not.toBeNull();
  });

  it('stacks its children so the action bar cannot displace the bubble', () => {
    expect(rule?.[2] ?? '').toMatch(/flex-direction\s*:\s*column/);
  });

  it('right-aligns the stack via align-items, not justify-content', () => {
    const decls = rule?.[2] ?? '';
    expect(decls).toMatch(/align-items\s*:\s*flex-end/);
    // justify-content on a column would push the bubble down the cross axis,
    // not to the right — the exact confusion that produced the bug.
    expect(decls).not.toMatch(/justify-content\s*:\s*flex-end/);
  });
});

describe('no orphan classes', () => {
  it('every DOM element with a className has at least one styled class', () => {
    const styled = styledClasses();
    const orphans = domElementsWithClasses().filter(
      (r) =>
        !r.classes.some((c) => styled.has(c)) &&
        !r.classes.some((c) => c in STYLED_BY_ANCESTOR),
    );

    const report = orphans.map((r) => `  <${r.tag} class="${r.classes.join(' ')}">  ${r.file}:${r.line}`);
    expect(report, `elements with no CSS rule:\n${report.join('\n')}`).toEqual([]);
  });

  it('the ancestor-styled allowlist has no stale entries', () => {
    const used = new Set(domElementsWithClasses().flatMap((r) => r.classes));
    for (const cls of Object.keys(STYLED_BY_ANCESTOR)) {
      expect(used.has(cls), `${cls} is allowlisted but no longer used`).toBe(true);
    }
  });
});
