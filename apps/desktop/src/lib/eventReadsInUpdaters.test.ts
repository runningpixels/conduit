/**
 * No change handler reads `e.target` inside a state updater.
 *
 * `onChange={(e) => set((d) => ({ ...d, name: e.target.value }))}` reads the
 * field when React runs the updater, not when the event fires. React runs it
 * at once only when nothing else is queued for that component; otherwise it
 * runs at the next render, after React has put the controlled field's old
 * value back, and the edit is lost. That is how ProjectSettingsDialog's test
 * saved the loaded instructions instead of the typed ones in CI. Read the
 * value in the handler instead: `({ target: { value } }) => set(...)`.
 *
 * Scanned as text: the pattern compiles and usually works, so only the
 * source shows it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** A functional state update: `setX((x) =>`, `set((d) =>` or `update((s) =>`. */
const UPDATER = /\b(?:set(?:[A-Z]\w*)?|update)\(\(\s*\w+\s*\)\s*=>/g;
const EVENT_READ = /\be\.(target|currentTarget)\./;

/** The text of the call opened at `start` (the `(` after the name), to its matching `)`. */
function callText(source: string, start: number): string {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

function lazyEventReads(source: string): number[] {
  const lines: number[] = [];
  for (const m of source.matchAll(UPDATER)) {
    const open = m.index + m[0].indexOf('(');
    if (EVENT_READ.test(callText(source, open))) lines.push(source.slice(0, m.index).split('\n').length);
  }
  return lines;
}

describe('event reads in state updaters', () => {
  it('finds the pattern it guards against', () => {
    expect(lazyEventReads('onChange={(e) => set((d) => ({ ...d, x: e.target.value }))}')).toEqual([1]);
    expect(lazyEventReads('onChange={(e) =>\n  update((s) =>\n    f(s, e.currentTarget.checked),\n  )}')).toEqual([2]);
    expect(lazyEventReads('onChange={({ target: { value } }) => set((d) => ({ ...d, x: value }))}')).toEqual([]);
    expect(lazyEventReads('const v = e.target.value; set((d) => ({ ...d, x: v }));')).toEqual([]);
  });

  it('no source file reads e.target inside a state updater', () => {
    const offenders = walk(srcRoot).flatMap((file) =>
      lazyEventReads(readFileSync(file, 'utf8')).map(
        (line) => `${relative(srcRoot, file).split(sep).join('/')}:${line}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
