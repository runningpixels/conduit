/**
 * Guard G6 — settings completeness.
 *
 * A section can go wrong in two directions, and both are silent:
 *
 *   - An id in the union with a nav item but no rendered body puts a row in the
 *     sidebar that opens an empty pane.
 *   - An id with a body but no nav item strands a whole section: reachable only
 *     if something happens to deep-link it, invisible otherwise.
 *
 * The second is the one V9 makes likely. Phase F dissolves `advanced` and moves
 * five blocks into Privacy & data; a half-finished version of that edit — union
 * trimmed, body left behind, or a deep link left pointing at the retired id —
 * type-checks and renders fine until someone follows the dead route.
 *
 * Asserted against the source text rather than by rendering, because rendering
 * proves only the section the test happened to open. This reads the whole set
 * at once.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');
const sheetRaw = readFileSync(join(here, 'SettingsSheet.tsx'), 'utf8');

/**
 * Comments stripped, block then line, before any pattern below is matched --
 * consistent with G8/G9 (cssContract.test.ts / brandLiterals.test.ts), and
 * for the same reason: unstripped source lets a match live in a comment
 * instead of real code. G8's own doc comment names the incident this
 * protects against (`.tool-status` surviving its own deletion because a
 * *comment* elsewhere still mentioned the class); the equivalent failure
 * here is deleting a real `section === 'branding' && <BrandingSection …/>`
 * render and leaving behind a comment (or a dead `if (section === 'branding')`
 * with no JSX) that still contains the literal text `section === 'branding'`
 * -- G6 would keep passing over an unreachable pane.
 */
function stripComments(src: string): string {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''));
  return noBlock
    .split('\n')
    .map((line) => {
      const m = line.match(/(?<!:)\/\//);
      return m ? line.slice(0, m.index) : line;
    })
    .join('\n');
}

const sheet = stripComments(sheetRaw);

/** The `SettingsSection` union members. */
function unionIds(): string[] {
  const block = sheet.match(/export type SettingsSection =([\s\S]*?);/);
  expect(block, 'no `export type SettingsSection` found').not.toBeNull();
  return Array.from(block![1].matchAll(/'([a-z-]+)'/g)).map((m) => m[1]);
}

/** Ids that appear as `{ id: '…' }` in NAV_ITEMS. */
function navIds(): string[] {
  const block = sheet.match(/const NAV_ITEMS[\s\S]*?\n\];/);
  expect(block, 'no `NAV_ITEMS` array found').not.toBeNull();
  return Array.from(block![0].matchAll(/id: '([a-z-]+)'/g)).map((m) => m[1]);
}

/**
 * Ids that actually render something: `section === '…' &&` immediately
 * followed (allowing an intervening `&& someFlag`, as the branding guard
 * does) by a JSX open tag `<Xyz` or fragment `<>` on the same match, rather
 * than a bare `if (section === '…')` with no JSX attached, or the literal
 * surviving only in a comment (comments are already stripped above).
 *
 * This is a heuristic, not a JSX parser -- it does not verify the tag it
 * finds is actually returned/rendered rather than, say, assigned to an
 * unused variable, and it does not walk into helper components. That trade
 * is fine for a guard that runs against code written by people trying to
 * keep it green, not against code trying to defeat it (the same stance
 * G9's own comment-stripping takes about itself).
 */
function bodyIds(): string[] {
  return Array.from(
    sheet.matchAll(/section === '([a-z-]+)'(?:\s*&&\s*[\w.]+)?\s*&&[\s\S]{0,80}?<[A-Za-z]/g),
  ).map((m) => m[1]);
}

describe('settings sections', () => {
  const union = unionIds();

  it('declares the twelve settings sections', () => {
    expect([...union].sort()).toEqual(
      [
        'about',
        'appearance',
        'branding',
        'chat',
        'connectors',
        'memory',
        'privacy',
        'prompts',
        'providers',
        'skills',
        'web-search',
        'workspace',
      ].sort(),
    );
  });

  it('gives every id a nav item', () => {
    expect(union.filter((id) => !navIds().includes(id))).toEqual([]);
  });

  it('gives every id a rendered body', () => {
    expect(union.filter((id) => !bodyIds().includes(id))).toEqual([]);
  });

  it('renders no body for an id outside the union', () => {
    expect(bodyIds().filter((id) => !union.includes(id))).toEqual([]);
  });

  it('lists no nav item outside the union', () => {
    expect(navIds().filter((id) => !union.includes(id))).toEqual([]);
  });
});

/**
 * The retired id, hunted across the tree. `tsc` catches the typed call sites,
 * but `onOpenSettings` takes a bare `string` at several boundaries and App
 * widens through `as SettingsSection` — so a stale `'advanced'` deep link is
 * exactly the kind of thing that compiles and then opens nothing.
 */
describe('the retired Advanced section', () => {
  it('is not referenced anywhere in src', () => {
    const files = [
      'App.tsx',
      'shell/SettingsSheet.tsx',
      'shell/Sidebar.tsx',
      'shell/StatusLine.tsx',
      'workspace/CommandPalette.tsx',
      'workspace/DocumentPanel.tsx',
    ];
    const offenders = files.filter((rel) => {
      const src = readFileSync(join(srcRoot, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      return /openSettings\(\s*'advanced'|onOpenSettings\(\s*'advanced'|initialSection=['"]advanced/.test(src);
    });
    expect(offenders, 'these still deep-link a section that no longer exists').toEqual([]);
  });
});
