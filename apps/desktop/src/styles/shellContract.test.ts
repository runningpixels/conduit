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
import { NARROW_BREAKPOINT, PANEL_BREAKPOINT } from '../workspace/useLayout';

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
 * A collapsed sidebar takes its own actions with it — reopen, New chat, Search
 * — so the title strip carries them while it is closed. Without them the
 * collapse is a dead end for anyone not using the hotkeys.
 */
describe('collapsed sidebar', () => {
  const css = allCss.replace(/\/\*[\s\S]*?\*\//g, '');

  it('has a reveal affordance shown when the sidebar is closed', () => {
    const found = openingTagFor('head-nav');
    expect(found, 'nothing renders .head-nav').not.toBeNull();
    const src = readFileSync(join(repoRoot, found!.file), 'utf8');
    const start = src.indexOf(found!.tag);
    const block = src.slice(start, src.indexOf('</div>', start));
    for (const handler of ['onToggleSidebar', 'onNewChat', 'onOpenPalette']) {
      expect(block, `.head-nav in ${found!.file} lost ${handler}`).toContain(`onClick={${handler}}`);
    }
    expect(css).toMatch(/html\[data-sidebar="closed"\]\s+\.head-nav\s*\{[^}]*display\s*:\s*flex/);
  });
});

/**
 * Column resizing is split across useLayout.ts (clamps, persistence, when the
 * handles are live) and workspace.css (when the columns and handles are
 * hidden). Neither side can see the other, and they had already drifted: the
 * panel's resize switched off at 820px while the stylesheet hid its handle at
 * 1100px and collapsed both columns at 900px.
 */
describe('column resize', () => {
  const css = allCss.replace(/\/\*[\s\S]*?\*\//g, '');

  it.each([
    ['NARROW_BREAKPOINT', NARROW_BREAKPOINT],
    ['PANEL_BREAKPOINT', PANEL_BREAKPOINT],
  ])('%s matches a media query in the stylesheet', (_name, px) => {
    expect(css).toContain(`@media (max-width: ${px}px)`);
  });

  it('declares no other shell breakpoint the hook does not know about', () => {
    const shellCss = readFileSync(join(srcRoot, 'styles', 'workspace.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const declared = Array.from(shellCss.matchAll(/@media \(max-width: (\d+)px\)/g)).map((m) => Number(m[1]));
    // 720px is an explicit out-of-scope placeholder (spec §2) with no rules in it.
    const unknown = declared.filter((px) => ![NARROW_BREAKPOINT, PANEL_BREAKPOINT, 720].includes(px));
    expect(unknown).toEqual([]);
  });

  // The grid's collapse transition would otherwise ease every pointermove and
  // leave the column trailing the cursor.
  it('turns the column transition off while a column is dragged', () => {
    expect(css).toMatch(/html\[data-resizing\]\s+\.body[^{]*\{[^}]*transition:\s*none/);
  });

  it('renders the sidebar sash as a keyboard-reachable separator, outside the drag region', () => {
    const found = openingTagFor('sidebar-resize');
    expect(found, 'nothing renders .sidebar-resize').not.toBeNull();
    expect(found!.tag).toContain('role="separator"');
    expect(found!.tag).toContain('tabIndex={0}');
    expect(found!.tag).not.toContain('data-tauri-drag-region');
  });

  it('hides the sidebar sash with the column, but not mid-drag', () => {
    expect(css).toMatch(
      /html\[data-sidebar="closed"\]\s+\.sidebar-resize:not\(\.dragging\)\s*\{[^}]*visibility:\s*hidden/,
    );
  });
});

/**
 * Narrow windows. Both side columns are force-collapsed below their
 * breakpoints, and before overlays existed that made every conversation and
 * every artifact unreachable by pointer: the toggles flipped an attribute the
 * forced collapse then ignored.
 */
describe('side columns on a narrow window', () => {
  const css = allCss.replace(/\/\*[\s\S]*?\*\//g, '');

  // An overlay is position: fixed, which takes it out of the grid; with
  // auto-placement the thread would slide into the sidebar's 0px track.
  it.each([
    ['sidebar', 1],
    ['center', 2],
    ['resize-handle', 3],
    ['doc-panel', 4],
  ])('places .%s in its grid column explicitly', (cls, column) => {
    expect(css).toMatch(new RegExp(`\\.body\\s*>\\s*\\.${cls}\\s*\\{[^}]*grid-column:\\s*${column}\\b`));
  });

  it.each(['sidebar', 'panel'])('shows the %s as a fixed overlay while its attribute is set', (id) => {
    const target = id === 'sidebar' ? 'sidebar' : 'doc-panel';
    expect(css).toMatch(
      new RegExp(`html\\[data-${id}-overlay="open"\\]\\s+\\.body\\s*>\\s*\\.${target}\\s*\\{[^}]*position:\\s*fixed`),
    );
    expect(css).toMatch(new RegExp(`html\\[data-${id}-overlay="open"\\]\\s+\\.overlay-scrim`));
  });

  it('renders the scrim that closes an overlay', () => {
    expect(openingTagFor('overlay-scrim')?.tag).toContain('onClick=');
  });

  it("keeps the sidebar's actions in the title strip below the narrow breakpoint", () => {
    expect(css).toMatch(
      new RegExp(`@media \\(max-width: ${NARROW_BREAKPOINT}px\\)\\s*\\{[\\s\\S]*?\\.head-nav\\s*\\{[^}]*display:\\s*flex`),
    );
  });

  // A zero-width track clips its content without taking it out of the tab order.
  it('takes a collapsed column out of the tab order', () => {
    expect(css).toMatch(/html\[data-sidebar="closed"\]:not\(\[data-sidebar-overlay\]\)\s+\.body\s*>\s*\.sidebar/);
    expect(css).toMatch(/html\[data-panel="closed"\]:not\(\[data-panel-overlay\]\)\s+\.body\s*>\s*\.doc-panel/);
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
