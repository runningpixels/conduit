/**
 * Guard G11 — truncated text must have a way to be read.
 *
 * Phase 4's stated failure mode, from `docs/plans/localization.md`: "truncation
 * without a tooltip is the failure mode that silently hides information in
 * German." The ordering the plan asks for is let containers grow, then wrap,
 * then truncate *with a tooltip* — this guards the last step.
 *
 * It is worth a guard rather than a one-time sweep because the bug is
 * invisible in the language it is written in. English usually fits, so the
 * ellipsis never appears, so nobody notices the value is unreachable. It shows
 * up first in German, where the same string is a third longer, and by then the
 * markup is months old.
 *
 * The check: find every CSS class that clips its text, then find the JSX using
 * that class and require a `title` (or `aria-label`) on the element, inside it,
 * or on an ancestor — `<div class="doc-title"><b title={t}>…` is fine, because
 * the reveal is there for the reader either way.
 *
 * Not a layout test. It cannot tell whether anything *actually* overflows —
 * jsdom has no layout — and it is not a substitute for running the app under
 * `en-XA`. It pins the one property that is decidable from source.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');
const desktopRoot = join(srcRoot, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const rel = (file: string) => relative(desktopRoot, file).split(sep).join('/');

/**
 * Classes that hide their overflow.
 *
 * `sr-only` is excluded: it clips to a 1px box on purpose, so that assistive
 * technology reads text that is not meant to be seen. That is the opposite of
 * this bug.
 */
function truncatingClasses(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of walk(join(srcRoot, 'styles')).filter((f) => f.endsWith('.css'))) {
    const text = readFileSync(file, 'utf8');
    for (const block of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = block[2];
      const clips =
        /text-overflow:\s*ellipsis/.test(body) ||
        (/overflow:\s*hidden/.test(body) && /white-space:\s*nowrap/.test(body));
      if (!clips) continue;
      const line = text.slice(0, block.index).split('\n').length;
      for (const cls of block[1].matchAll(/\.([a-zA-Z][\w-]*)/g)) {
        if (cls[1] !== 'sr-only' && !found.has(cls[1])) {
          found.set(cls[1], `${rel(file)}:${line}`);
        }
      }
    }
  }
  return found;
}

/**
 * Known exceptions, with the reason each is one.
 *
 * Expected to stay this short. A growing list means the rule is being routed
 * around rather than followed.
 */
const ALLOWED: { file: string; cls: string; reason: string }[] = [
  {
    file: 'src/shell/Sidebar.tsx',
    cls: 'menu-label',
    reason:
      'A section heading inside a menu, not content — its text is a fixed ' +
      'translated label, and a tooltip repeating it tells the reader nothing ' +
      'they cannot already see.',
  },
  {
    file: 'src/shell/StatusLine.tsx',
    cls: 'menu-label',
    reason:
      'The same kind of menu section heading ("This chat"). It used to pass only ' +
      'by accident — the hand-rolled wrapper div carried an aria-label, which ' +
      'the container check matched — and stopped once the popover became a Menu.',
  },
];

interface Finding {
  file: string;
  line: number;
  cls: string;
  css: string;
}

function findings(): Finding[] {
  const classes = truncatingClasses();
  const out: Finding[] = [];

  for (const file of walk(srcRoot).filter((f) => /\.tsx$/.test(f) && !/\.test\.tsx$/.test(f))) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

    const visit = (node: ts.Node): void => {
      if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
        const attrs = node.attributes.properties.filter(ts.isJsxAttribute);
        const named = new Set(
          attrs.filter((a) => ts.isIdentifier(a.name)).map((a) => (a.name as ts.Identifier).text),
        );
        const classAttr = attrs.find(
          (a) => ts.isIdentifier(a.name) && a.name.text === 'className',
        );
        if (classAttr?.initializer) {
          const mentioned = [...classAttr.initializer.getText(sf).matchAll(/[\w-]+/g)].map(
            (m) => m[0],
          );
          const cls = mentioned.find((c) => classes.has(c));
          if (cls) {
            const own = named.has('title') || named.has('aria-label');
            const container = node.parent?.parent;
            const inside = container
              ? /\stitle=/.test(container.getText(sf)) ||
                /\saria-label=/.test(container.getText(sf))
              : false;
            let ancestor = false;
            for (let a: ts.Node | undefined = node.parent; a; a = a.parent) {
              if (ts.isJsxElement(a) && /\stitle=/.test(a.openingElement.getText(sf))) {
                ancestor = true;
                break;
              }
            }
            const excused = ALLOWED.some((e) => e.file === rel(file) && e.cls === cls);
            if (!own && !inside && !ancestor && !excused) {
              out.push({
                file: rel(file),
                line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
                cls,
                css: classes.get(cls)!,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

describe('Guard G11 — clipped text can still be read', () => {
  it('finds truncating classes to check against', () => {
    // If the CSS scan ever returns nothing, this guard silently passes forever.
    expect(truncatingClasses().size).toBeGreaterThan(5);
  });

  it('gives every clipped element a title, or an excuse', () => {
    const report = findings().map((f) => `${f.file}:${f.line} .${f.cls} (from ${f.css})`);
    expect(
      report,
      'These clip their text with no way to reveal it. Add `title={theSameValue}` ' +
        '— or let the container grow or wrap instead, which the plan prefers.',
    ).toEqual([]);
  });
});
