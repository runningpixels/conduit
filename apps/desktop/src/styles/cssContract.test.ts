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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

/**
 * Every class name that appears in any selector in any stylesheet.
 *
 * Comments are stripped first, and that is not tidiness. Without it, a class
 * merely *named* in a comment counts as styled — so deleting a rule while some
 * unrelated file still explains why it once existed leaves the orphan check
 * green over an element with no styling at all. That is exactly how
 * `.tool-status` survived its own deletion: a token comment in tokens.css
 * mentioned `.tool-status.err` while reasoning about a contrast ratio, and the
 * guard read it as a live selector.
 */
function styledClasses(): Set<string> {
  const out = new Set<string>();
  for (const f of cssFiles) {
    const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(m[1]);
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

/**
 * Guard — reserved turn footer (no hover jitter).
 *
 * Usage used to `display: none` until hover, then flex — inserting a second
 * stacked line above `.turn-actions` and pushing the thread down. Both pieces
 * of chrome now share one reserved row that fades via opacity only.
 */
describe('turn footer reserves height (no hover layout shift)', () => {
  const chat = readFileSync(join(srcRoot, 'styles', 'chat.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

  it('hides .turn-actions with opacity, not display', () => {
    const rule = chat.match(/(^|\})\s*\.turn-actions\s*\{([^}]*)\}/);
    expect(rule, 'no `.turn-actions { … }` rule found in chat.css').not.toBeNull();
    const decls = rule?.[2] ?? '';
    expect(decls).toMatch(/opacity\s*:\s*0/);
    expect(decls).not.toMatch(/display\s*:\s*none/);
    expect(decls).toMatch(/pointer-events\s*:\s*none/);
    // Slide on reveal would still be motion-only, but opacity-only matches the
    // Claude pattern and avoids any transform side-effects on layout paint.
    expect(decls).not.toMatch(/translateY/);
  });

  it('keeps usage counts in an absolute tip, not a display-toggled row', () => {
    const rule = chat.match(/(^|\})\s*\.usage-summary\s*\{([^}]*)\}/);
    expect(rule, 'no `.usage-summary { … }` rule found in chat.css').not.toBeNull();
    expect(rule?.[2] ?? '').not.toMatch(/display\s*:\s*none/);
    // Hover reveal must not reintroduce a display toggle (the old jitter).
    expect(chat).not.toMatch(/\.turn:hover\s+\.usage-summary[^{]*\{[^}]*display\s*:\s*flex/);

    const tip = chat.match(/(^|\})\s*\.usage-summary-tip\s*\{([^}]*)\}/);
    expect(tip, 'no `.usage-summary-tip { … }` rule found in chat.css').not.toBeNull();
    const tipDecls = tip?.[2] ?? '';
    expect(tipDecls).toMatch(/position\s*:\s*absolute/);
    expect(tipDecls).toMatch(/opacity\s*:\s*0/);
  });
});

/**
 * Guard G4 — the assistant turn's provider rule.
 *
 * This one selector has now been argued twice in opposite directions. V7's
 * Pass K3 deleted it ("a colour that repeats on every turn is chrome, not
 * data"); V9 §3 reinstates it as the first item of the signature. Both were
 * right for the shape the turn had at the time: in V7 the assistant turn
 * carried weight of its own, so the rule restated a role; in V9 the turn is
 * flush prose, so the rule is the only per-turn mark of which provider produced
 * it, and a mid-thread switch is legible from the left edge alone.
 *
 * Pinned because the argument is genuinely balanced and the next reviewer will
 * meet it cold. A failure here is not "you broke a rule" — it is "this was
 * decided twice, go read why before deciding it a third time."
 */
describe('assistant turn provider rule', () => {
  const chat = readFileSync(join(srcRoot, 'styles', 'chat.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const rule = chat.match(/(^|\})\s*\.turn\.assistant\s*\{([^}]*)\}/);

  it('has a .turn.assistant rule', () => {
    expect(rule, 'no `.turn.assistant { … }` rule found in chat.css').not.toBeNull();
  });

  it('carries a 2px left border in the provider hue', () => {
    const decls = rule?.[2] ?? '';
    expect(decls).toMatch(/border-left\s*:\s*2px\s+solid/);
    expect(decls, 'the rule must be hue-derived, not a neutral line').toMatch(/--hue/);
  });

  it('insets the prose to clear the border', () => {
    // The padding and the border went together when K3 removed them, and they
    // come back together: a border with no inset puts prose against the rule.
    expect(rule?.[2] ?? '').toMatch(/padding-left\s*:/);
  });
});

/**
 * Guard G3 — the mirror of the orphan check: CSS no markup uses.
 *
 * The orphan test asks "does this className have a rule?"; this asks "does this
 * rule have a className?". Without it a deleted component leaves its styling
 * behind, and the next person reads dead rules as live ones — V7's Pass N
 * recorded `.tico`, `.tname` and `.panel-activity` as known-dead and they were
 * still here nine passes later, because nothing failed.
 *
 * The match is deliberately loose (any occurrence of the bare name anywhere in
 * a `.ts`/`.tsx`), since class names are routinely composed — `` `kind-${k}` ``,
 * `` `tool${running ? ' running' : ''}` ``. A loose test that runs beats a
 * precise one that cries wolf; the allowlist below covers what no source file
 * can mention at all.
 */
const NOT_IN_MARKUP: Record<string, string> = {
  // Prism emits these onto tokens at runtime; syntax.css colours them.
  'attr-name': 'prismjs token class',
  'attr-value': 'prismjs token class',
  constant: 'prismjs token class',
  operator: 'prismjs token class',
  prolog: 'prismjs token class',
  // Matched out of `url("…/Geist-Regular.woff2")`, not a selector at all.
  woff2: 'font filename extension inside url()',
  // Composed as `kind-${toast.kind}` in ToastStack.tsx, so the literal never
  // appears. These three are live; the pair that used to sit beside them
  // (kind-thinking / kind-active, under .panel-activity) genuinely were not.
  'kind-error': 'built from a template literal in ToastStack.tsx',
  'kind-success': 'built from a template literal in ToastStack.tsx',
  'kind-warning': 'built from a template literal in ToastStack.tsx',
};

describe('no dead rules', () => {
  it('every styled class is used by some component', () => {
    const sources = [
      ...walk(srcRoot).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f)),
      ...walk(join(repoRoot, 'packages', 'ui', 'src')).filter((f) => /\.tsx?$/.test(f)),
    ].map((f) => readFileSync(f, 'utf8'));

    const dead: string[] = [];
    for (const cls of styledClasses()) {
      if (cls in NOT_IN_MARKUP) continue;
      if (!sources.some((src) => src.includes(cls))) dead.push(cls);
    }

    expect(
      dead.sort(),
      `CSS rules no component uses — delete them, or add them to NOT_IN_MARKUP with the reason:\n  ${dead.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the not-in-markup allowlist has no stale entries', () => {
    const styled = styledClasses();
    for (const cls of Object.keys(NOT_IN_MARKUP)) {
      expect(styled.has(cls), `${cls} is allowlisted but no longer styled`).toBe(true);
    }
  });
});

/**
 * Guard G8 — the fonts stay bundled.
 *
 * Decision D3 keeps Geist local so the CSP stays `'self'` and the app launches
 * offline with identical metrics on every OS. That is one `url()` away from
 * being undone by someone "just adding a webfont", and the failure is invisible
 * in development, where the network is always there.
 */
describe('bundled fonts', () => {
  const tokens = readFileSync(join(repoRoot, 'packages', 'ui', 'src', 'tokens.css'), 'utf8');

  // `brand.generated.css` (white-label plan §5, Mode B's build-time emitter)
  // is gitignored and only exists once someone has actually run `cargo run
  // --example apply_brand -p provider-core` — a stock checkout has no such
  // file. When it does exist, its `@font-face` rules are held to the exact
  // same two invariants tokens.css is: every url resolves to a file on disk,
  // and nothing loads over the network. That is the whole reason Mode B's
  // fonts are copied into packages/ui/src/fonts/ instead of referenced by
  // path back into the brand directory — it is what lets this guard (and the
  // font-src 'self' CSP) stay satisfied with no policy exception.
  const brandCssPath = join(repoRoot, 'packages', 'ui', 'src', 'brand.generated.css');
  const brandCss = existsSync(brandCssPath) ? readFileSync(brandCssPath, 'utf8') : '';
  const allCss = tokens + brandCss;

  it('every font url resolves to a file on disk', () => {
    const urls = Array.from(allCss.matchAll(/url\(["']?([^"')]+)["']?\)/g)).map((m) => m[1]);
    expect(urls.length, 'no @font-face urls found at all').toBeGreaterThan(0);
    const shipped = new Set(
      readdirSync(join(repoRoot, 'packages', 'ui', 'src', 'fonts'), { withFileTypes: true }).map(
        (e) => e.name,
      ),
    );
    const missing = urls.filter((u) => !shipped.has(u.split('/').pop() ?? u));
    expect(missing, 'font files must ship with the app').toEqual([]);
  });

  it('loads no font over the network', () => {
    const remote = Array.from(allCss.matchAll(/url\(["']?([^"')]+)["']?\)/g))
      .map((m) => m[1])
      .filter((u) => /^(https?:)?\/\//.test(u));
    expect(remote, 'a remote font breaks CSP self and offline launch').toEqual([]);
  });

  it('--font-serif ends in a generic family', () => {
    // D3 ships the serif as a system stack. Whatever the preferred faces, the
    // last entry has to be a family every platform can satisfy.
    const decl = tokens.match(/--font-serif:\s*([^;]+);/);
    expect(decl, 'no --font-serif declared').not.toBeNull();
    expect(decl![1].trim()).toMatch(/(serif|ui-serif)\s*$/);
  });

  /**
   * The prose face is the one register the Orange Charcoal palette changes, and
   * the Terra palette must be provably untouched by it — a serif default here
   * would restyle every existing user's transcript on upgrade.
   */
  it('--font-prose defaults to the UI face', () => {
    const decl = tokens.match(/--font-prose:\s*([^;]+);/);
    expect(decl, 'no --font-prose declared').not.toBeNull();
    expect(decl![1].trim()).toBe('var(--font-ui)');
  });

  /**
   * There is one serif in the product, and it is one *token*, not two stacks
   * that happen to agree. `--font-serif` dresses artifact document titles and
   * the Orange Charcoal palette's prose, and those two render 18px apart in the
   * same view — when this was a system stack and the palette named Source Serif
   * directly, a title fell back to Georgia on Windows and Charter on macOS
   * beside prose that did neither. Restating the stack here would let them
   * drift apart again silently, so the override has to be the reference.
   */
  it('the palette dresses prose in the product serif, by reference', () => {
    const decls = [...tokens.matchAll(/--font-prose:\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(decls.length, 'the palette never overrides --font-prose').toBeGreaterThan(1);
    for (const decl of decls.slice(1)) {
      expect(decl).toBe('var(--font-serif)');
    }
  });

  /**
   * The serif is bundled now, so the fallbacks only catch a failed load — but
   * that is exactly when a missing generic family leaves prose on the UA
   * default. The `--font-serif` assertion above covers the palette too, by
   * reference; this pins the other half of the trade: bundling it means it has
   * to resolve on disk, which the url() test already enforces.
   */
  it('the product serif leads with the bundled face', () => {
    const decl = tokens.match(/--font-serif:\s*([^;]+);/);
    expect(decl![1].trim()).toMatch(/^"Source Serif 4"/);
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
