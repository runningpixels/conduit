/**
 * Shell contract guards — the frameless window's survival kit.
 *
 * V9 deletes the top bar. That bar carried two things the OS is not providing,
 * because `tauri.conf.json` sets `decorations: false` on Windows and Linux:
 * the drag region, and the minimise/maximise/close cluster. Lose either and the
 * window cannot be moved or closed at all.
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
 * Both surfaces that reach the top of the window carry the drag region: the
 * title strip owns the centre column's top edge, `.sb-head` the sidebar's.
 * Tauri stops the drag at interactive descendants, so buttons inside them keep
 * their clicks without opting out.
 */
describe('window drag region', () => {
  it.each(['main-head', 'sb-head'])('.%s carries data-tauri-drag-region', (cls) => {
    const found = openingTagFor(cls);
    expect(found, `no element renders className "${cls}"`).not.toBeNull();
    expect(found!.tag, `${cls} in ${found!.file}`).toContain('data-tauri-drag-region');
  });

  /**
   * ...and so does every non-interactive child inside them.
   *
   * Tauri hit-tests the element directly under the cursor; it does not walk up
   * to an ancestor carrying the attribute. So a plain <span> label inside the
   * drag region swallows the drag over its own box. `.main-title` shipped that
   * way and made most of the title bar dead, because a long chat name stretches
   * the span across nearly the whole strip — while every static gate passed,
   * since the header itself was tagged exactly as the spec asks. Only dragging
   * the packaged shell surfaced it.
   *
   * Buttons are excluded: an interactive descendant is *supposed* to take its
   * own clicks instead of dragging.
   */
  it.each(['main-head', 'sb-head'])('every non-interactive child of .%s carries it too', (cls) => {
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
  // Rendered once, at the app root: the cluster is position:fixed, so a second
  // instance would stack invisibly on the first rather than fail loudly.
  it('are mounted exactly once in the tree', () => {
    const uses = tsxFiles.flatMap((f) => {
      const src = readFileSync(f, 'utf8');
      return Array.from(src.matchAll(/<WindowControls\s*\/?>/g)).map(
        () => relative(repoRoot, f).replace(/\\/g, '/'),
      );
    });
    expect(uses).toHaveLength(1);
  });

  // With no bar to sit in, the cluster is only reachable if it is pinned to the
  // window's corner itself.
  it('are pinned to the window corner', () => {
    const rule = allCss
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .match(/(^|\})\s*\.wincontrols\s*\{([^}]*)\}/);
    expect(rule, 'no `.wincontrols { … }` rule found').not.toBeNull();
    expect(rule?.[2] ?? '').toMatch(/position\s*:\s*fixed/);
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
