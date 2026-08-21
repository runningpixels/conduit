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
const sheet = readFileSync(join(here, 'SettingsSheet.tsx'), 'utf8');

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

/** Ids that actually render something: `section === '…' &&`. */
function bodyIds(): string[] {
  return Array.from(sheet.matchAll(/section === '([a-z-]+)'/g)).map((m) => m[1]);
}

describe('settings sections', () => {
  const union = unionIds();

  it('declares the six V9 sections', () => {
    expect([...union].sort()).toEqual(
      ['appearance', 'chat', 'connectors', 'privacy', 'prompts', 'providers'].sort(),
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
