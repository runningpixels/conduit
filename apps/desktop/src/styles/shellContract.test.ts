/**
 * Shell contract guards — the frameless window's survival kit.
 *
 * `tauri.conf.json` sets `decorations: false` on Windows and Linux, so the app
 * supplies two things the OS is not providing: the drag region, and the
 * minimise/maximise/close cluster. Lose either and the window cannot be moved
 * or closed at all. Both now live in one place — `.titlebar`, the caption row
 * that is the first row of the `.app` grid — which is what these guards pin.
 *
 * Nothing else in the toolchain can see that failure:
 *   - `tsc -b` type-checks an attribute it knows nothing about.
 *   - vitest runs in jsdom, where `__TAURI_INTERNALS__` is absent and
 *     `WindowControls` deliberately renders null.
 *   - `dev:web` no-ops the component for the same reason.
 * It only shows up in a packaged build, which is the definition of a defect
 * worth pinning statically. Same reasoning as cssContract.test.ts.
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

const tsxFiles = walk(srcRoot).filter((f) => /\.tsx$/.test(f) && !/\.test\./.test(f));
const cssFiles = [
  ...walk(join(srcRoot, 'styles')).filter((f) => f.endsWith('.css')),
  join(repoRoot, 'packages', 'ui', 'src', 'tokens.css'),
];
const allCss = cssFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

/**
 * The opening tag of the first element carrying `className="… cls …"`, so an
 * attribute can be asserted on the element that actually renders the class.
 */
function openingTagFor(cls: string): { file: string; tag: string } | null {
  for (const file of tsxFiles) {
    const src = readFileSync(file, 'utf8');
    const idx = src.search(new RegExp(`className=["'\`][^"'\`]*\\b${cls}\\b`));
    if (idx === -1) continue;
    const start = src.lastIndexOf('<', idx);
    const end = src.indexOf('>', idx);
    if (start === -1 || end === -1) continue;
    return { file: relative(repoRoot, file).replace(/\\/g, '/'), tag: src.slice(start, end + 1) };
  }
  return null;
}

/**
 * The caption row is the window's only drag surface. Tauri stops the drag at
 * interactive descendants, so the control buttons inside it keep their clicks
 * without opting out.
 */
describe('window drag region', () => {
  it.each(['titlebar'])('.%s carries data-tauri-drag-region', (cls) => {
    const found = openingTagFor(cls);
    expect(found, `no element renders className "${cls}"`).not.toBeNull();
    expect(found!.tag, `${cls} in ${found!.file}`).toContain('data-tauri-drag-region');
  });

  /**
   * ...and so must every non-interactive child added inside it.
   *
   * Tauri hit-tests the element directly under the cursor; it does not walk up
   * to an ancestor carrying the attribute. So a plain <span> label inside the
   * drag region swallows the drag over its own box. `.main-title` shipped that
   * way back when the title strip was the drag region, and made most of it
   * dead, because a long chat name stretches the span across nearly the whole
   * strip — while every static gate passed, since the header itself was tagged
   * exactly as the spec asks. Only dragging the packaged shell surfaced it.
   *
   * The bar holds nothing but `<WindowControls />` today, so this passes
   * trivially; it is here to stay true when something is added to it.
   *
   * Buttons are excluded: an interactive descendant is *supposed* to take its
   * own clicks instead of dragging.
   */
  it.each(['titlebar'])('every non-interactive child of .%s carries it too', (cls) => {
    const found = openingTagFor(cls);
    const src = readFileSync(join(repoRoot, found!.file), 'utf8');
    const start = src.indexOf(found!.tag);
    // The container's block: up to its closing tag. Both are single-parent
    // blocks, so the first matching close is the right one.
    const closeTag = `</${found!.tag.slice(1).match(/^[a-z]+/)![0]}>`;
    const block = src.slice(start, src.indexOf(closeTag, start));
    // Drop <button …>…</button> subtrees before looking for plain elements.
    const withoutButtons = block.replace(/<button[\s\S]*?<\/button>/g, '');
    const plainTags = Array.from(withoutButtons.matchAll(/<(?:span|div|p|h[1-6])\b[^>]*>/g))
      .map((m) => m[0])
      .filter((t) => /className=/.test(t))
      .slice(1); // the container's own opening tag
    const undraggable = plainTags.filter((t) => !t.includes('data-tauri-drag-region'));
    expect(
      undraggable,
      `these swallow the drag inside .${cls} (${found!.file}); add data-tauri-drag-region`,
    ).toEqual([]);
  });

  /**
   * `-webkit-app-region` is an Electron property. WebView2 ignores it silently,
   * so a stylesheet using it looks correct and does nothing — which is exactly
   * how the V7 mockup's drag region shipped broken (workspace.css documents
   * it). The V9 proposal's CSS uses it throughout, so this is the guard that
   * stops it being pasted in a second time.
   */
  it('no stylesheet uses -webkit-app-region', () => {
    const offenders = cssFiles.filter((f) =>
      readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').includes('-webkit-app-region'),
    );
    expect(
      offenders.map((f) => relative(repoRoot, f).replace(/\\/g, '/')),
      'use data-tauri-drag-region; WebView2 ignores -webkit-app-region',
    ).toEqual([]);
  });
});

describe('window controls', () => {
  // Rendered from exactly one place — `TitleBar` — so the caption row is the
  // single owner of the cluster. `<TitleBar />` itself is used more than once
  // (the workspace plus the two pre-workspace routes), which is why the count
  // is asserted here and not on the bar.
  it('are mounted exactly once in the tree', () => {
    const uses = tsxFiles.flatMap((f) => {
      // Comments stripped first: this counts renders, and TitleBar's own doc
      // block names the tag while explaining why the bar is its only home.
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      return Array.from(src.matchAll(/<WindowControls\s*\/?>/g)).map(
        () => relative(repoRoot, f).replace(/\\/g, '/'),
      );
    });
    expect(uses).toHaveLength(1);
  });

  // ...and that one place is inside the caption row. Rendering them anywhere
  // else puts the window's only close affordance over app content again.
  it('are rendered inside the caption row', () => {
    const found = openingTagFor('titlebar');
    expect(found, 'nothing renders .titlebar').not.toBeNull();
    const src = readFileSync(join(repoRoot, found!.file), 'utf8');
    const start = src.indexOf(found!.tag);
    const block = src.slice(start, src.indexOf('</div>', start));
    expect(block, `.titlebar in ${found!.file}`).toMatch(/<WindowControls\s*\/?>/);
  });

  // All three window operations must stay reachable; a cluster that lost
  // `close` leaves no way to shut a decorationless window. Asserted on the
  // calls rather than the labels, because the maximise button's label is
  // stateful ("Restore" once maximised).
  it.each(['minimize', 'toggleMaximize', 'close'])('keep the %s control', (op) => {
    const src = readFileSync(join(srcRoot, 'shell', 'WindowControls.tsx'), 'utf8');
    expect(src).toContain(`w.${op}()`);
  });
});

/**
 * The reveal button is the only pointer affordance that reopens a collapsed
 * sidebar now that the top bar is gone; without it the collapse is a dead end
 * for anyone not using the hotkey.
 */
describe('collapsed sidebar', () => {
  it('has a reveal affordance shown when the sidebar is closed', () => {
    expect(openingTagFor('sb-reveal'), 'nothing renders .sb-reveal').not.toBeNull();
    expect(allCss.replace(/\/\*[\s\S]*?\*\//g, '')).toMatch(
      /html\[data-sidebar="closed"\]\s+\.sb-reveal\s*\{[^}]*display\s*:\s*grid/,
    );
  });
});

/**
 * The caption row has to be a real, non-zero row of the `.app` grid.
 *
 * This is what replaced the previous arrangement, where the cluster floated
 * `position: fixed` over the corner and three separate rules made the title
 * strip and the artifact panel dodge it. If the row collapses — a dropped
 * `grid-template-rows`, a `--titlebar-h` that resolves to nothing — the buttons
 * are drawn on top of app content again, which nothing else in the toolchain
 * can see.
 */
describe('caption row', () => {
  const css = allCss.replace(/\/\*[\s\S]*?\*\//g, '');

  it('is the first row of the app grid', () => {
    expect(css).toMatch(/\.app\s*\{[^}]*grid-template-rows:\s*var\(--titlebar-h\)/);
  });

  it('is sized by --titlebar-h', () => {
    const rule = css.match(/(^|\})\s*\.titlebar\s*\{([^}]*)\}/);
    expect(rule, 'no `.titlebar { … }` rule found').not.toBeNull();
    expect(rule?.[2] ?? '').toMatch(/height:\s*var\(--titlebar-h\)/);
  });

  it('reserves a non-zero height', () => {
    const declared = css.match(/--titlebar-h:\s*([^;]+);/);
    expect(declared, '--titlebar-h is not declared in the token layer').not.toBeNull();
    expect(declared![1].trim()).toMatch(/^[1-9]\d*px$/);
  });
});
