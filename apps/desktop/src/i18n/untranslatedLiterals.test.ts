/**
 * Guard G10 — no untranslated user-facing literals in the renderer.
 *
 * The sixth guard in the family (G3, G4, G6, G7, G8, G9). Same purpose as G9,
 * one layer up: G9 stops a hardcoded product name from routing around
 * `appName()`, and this stops hardcoded *prose* from routing around the
 * catalog. Without it, the first person to add `<button>Save</button>` after
 * Phase 2 gets a green build, and the app un-translates itself one string at a
 * time — invisibly, because English is what a reviewer reading the diff
 * expects to see.
 *
 * **Why this one uses a parser when the others scan text.** G8 and G9 look for
 * a specific known string, so a regex over source is enough and the trade is
 * documented in their comments. G10 has to answer a harder question — is this
 * particular string literal rendered to a user? — and the answer depends
 * entirely on where the literal sits in the syntax tree. `'Save'` is a
 * violation as JSX text, fine as an object key, fine as a `className`, fine as
 * a test fixture, and fine as an enum value that happens to be capitalised. A
 * regex cannot tell those apart, and across ~300 sites the false positives
 * would make the guard something people silence rather than fix. TypeScript is
 * already a devDependency, so the real answer is available for free.
 *
 * **The pending list is a burn-down, not an allowlist.** Phase 2 extracts the
 * renderer area by area, so for a while some files legitimately still hold
 * literals. Those are listed in `PENDING`. The list only shrinks:
 *
 *   - a file NOT in `PENDING` may contain no user-facing literal at all;
 *   - a file IN `PENDING` that now has none must be removed from the list.
 *
 * That second rule is what stops the list from quietly becoming permanent —
 * finishing a file *forces* the edit that shortens it. When `PENDING` is empty
 * the constant and this paragraph go away, and G10 is an ordinary guard.
 *
 * Escape hatch: `// i18n-exempt: <reason>` on the offending line or the line
 * above. For developer-facing strings only — a debug label, a dev-only
 * warning. A reason is required, because the next person needs to know whether
 * the exemption still holds.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');
const desktopRoot = join(srcRoot, '..');

/** Attributes whose string value is read aloud or shown to a user. */
const USER_FACING_ATTRIBUTES = new Set(['aria-label', 'placeholder', 'title', 'alt']);

/**
 * Callbacks whose first argument is rendered to the user as a toast.
 *
 * These are the half of the surface that JSX scanning cannot see:
 * `onStatus('Saved')` is an ordinary call expression, indistinguishable by
 * shape from any other function taking a string. They were missed once
 * already — `useAutoSave.ts` has no JSX at all, so it never appeared in this
 * guard's list and no extraction pass was pointed at it, while quietly
 * rendering "Settings save failed" in English under a German UI.
 */
const STATUS_CALLBACKS = new Set(['onStatus', 'setStatus', 'pushToast', 'showToast']);

/**
 * Files that still hold literals, pending extraction. Shrinks to empty over
 * Phase 2; see the module comment. Ordered by the plan's extraction order so
 * the remaining work reads off the top.
 */
const PENDING: readonly string[] = [
  // 1. workspace/settings — the largest surface; 13 files extracted so far.
  // 2. chat — 119 sites.
  'src/chat/ThinkingIndicator.tsx',
  // 3. shell — 97 sites.
  'src/shell/SettingsSheet.tsx',
  'src/shell/Sidebar.tsx',
  'src/shell/StatusLine.tsx',
  'src/shell/WindowControls.tsx',
  // 4. workspace root — 62 sites.
  'src/workspace/DocumentPanel.tsx',
  'src/workspace/CommandPalette.tsx',
  'src/workspace/OpenExternalLinkDialog.tsx',
  'src/workspace/MainHead.tsx',
  'src/workspace/ToastStack.tsx',
  // 5. artifacts — 15 sites.
  'src/artifacts/renderers.tsx',
  'src/artifacts/ArtifactEmptyState.tsx',
  'src/artifacts/DocumentPanelErrorBoundary.tsx',
  'src/artifacts/markdown/MermaidBlock.tsx',
  'src/artifacts/markdown/KatexHtml.tsx',
  'src/artifacts/HtmlArtifactRenderer.tsx',
  // 6. the app shell itself — 10 sites.
  'src/App.tsx',
];

interface Violation {
  file: string;
  line: number;
  kind: 'jsx-text' | 'attribute' | 'status';
  text: string;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

function rel(file: string): string {
  return relative(desktopRoot, file).split(sep).join('/');
}

const sourceFiles = walkFiles(srcRoot)
  .filter((f) => /\.tsx?$/.test(f))
  .filter((f) => !/\.test\.tsx?$/.test(f))
  .map(rel)
  // `src/i18n/` is the catalog layer itself; `src/test/` is test scaffolding.
  .filter((f) => !f.startsWith('src/i18n/') && !f.startsWith('src/test/'))
  .filter((f) => !f.startsWith('src/scripts/'))
  .sort();

/** A string is prose if it contains a letter — digits and punctuation alone are not. */
function isProse(text: string): boolean {
  return /[A-Za-z]/.test(text.trim()) && text.trim().length > 1;
}

/**
 * `// i18n-exempt: reason` on this line or the one above it.
 *
 * Two lines rather than one because a violation inside a multi-line JSX
 * attribute list often has no room for a trailing comment.
 */
function isExempt(lines: string[], lineIndex: number): boolean {
  const candidates = [lines[lineIndex], lines[lineIndex - 1]].filter((l) => l !== undefined);
  return candidates.some((l) => /\/\/\s*i18n-exempt:\s*\S/.test(l));
}

/**
 * The literal text of a status argument, or `undefined` if it is not a
 * literal. A template literal counts: `` `Saved ${name}` `` is still English
 * prose with a hole in it, and is exactly the shape that has to become an ICU
 * message with a named placeholder.
 */
function statusLiteral(arg: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(arg)) return arg.text;
  if (ts.isTemplateExpression(arg)) {
    return arg.head.text + arg.templateSpans.map((span) => span.literal.text).join('');
  }
  return undefined;
}

function findViolations(file: string): Violation[] {
  const text = readFileSync(join(desktopRoot, file), 'utf8');
  const lines = text.split('\n');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: Violation[] = [];

  const record = (node: ts.Node, kind: Violation['kind'], value: string) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
    if (isExempt(lines, line)) return;
    found.push({ file, line: line + 1, kind, text: value.trim().slice(0, 60) });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : '';
      if (STATUS_CALLBACKS.has(name)) {
        for (const arg of node.arguments) {
          const literal = statusLiteral(arg);
          if (literal !== undefined && isProse(literal)) {
            record(arg, 'status', `${name}(${JSON.stringify(literal)})`);
          }
        }
      }
    }
    if (ts.isJsxText(node) && isProse(node.text)) {
      record(node, 'jsx-text', node.text);
    } else if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
      // `name` can also be a namespaced JSX name; only plain identifiers matter.
      if (USER_FACING_ATTRIBUTES.has(node.name.text) && node.initializer) {
        const init = node.initializer;
        if (ts.isStringLiteral(init) && isProse(init.text)) {
          record(node, 'attribute', `${node.name.text}="${init.text}"`);
        } else if (
          ts.isJsxExpression(init) &&
          init.expression &&
          ts.isStringLiteralLike(init.expression) &&
          isProse(init.expression.text)
        ) {
          record(node, 'attribute', `${node.name.text}={'${init.expression.text}'}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

const violationsByFile = new Map<string, Violation[]>(
  sourceFiles.map((f) => [f, findViolations(f)]),
);

describe('Guard G10 — user-facing literals live in the catalog', () => {
  it('has a pending list that names only real files', () => {
    // A stale entry would silently exempt nothing while looking like progress.
    const unknown = PENDING.filter((f) => !sourceFiles.includes(f));
    expect(unknown, 'PENDING names files that do not exist').toEqual([]);
  });

  it('finds no literal outside the pending list', () => {
    const offenders: Violation[] = [];
    for (const [file, violations] of violationsByFile) {
      if (PENDING.includes(file)) continue;
      offenders.push(...violations);
    }
    const report = offenders.map((v) => `${v.file}:${v.line} [${v.kind}] ${v.text}`);
    expect(
      report,
      'Move these into src/i18n/messages/en.json and render them with useT(), ' +
        'or mark them `// i18n-exempt: <reason>` if no user ever reads them. ' +
        'A `status` finding is a toast: same rule, it is just not in the JSX.',
    ).toEqual([]);
  });

  it('keeps the pending list shrinking — no finished file left on it', () => {
    // The rule that makes this a burn-down instead of an allowlist: extracting
    // a file's last literal forces the edit that removes it from PENDING.
    const finished = PENDING.filter((f) => (violationsByFile.get(f) ?? []).length === 0);
    expect(
      finished,
      'These files are fully extracted — delete them from PENDING in this file.',
    ).toEqual([]);
  });
});
