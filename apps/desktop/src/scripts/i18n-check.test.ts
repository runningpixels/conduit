import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Repo-root tooling script (Phase 1 i18n, docs/plans/localization.md). Plain
// ESM JS with no type bindings; vitest runs it directly. `@ts-ignore` keeps
// `tsc -b` (`pnpm check`) quiet about the missing declaration, the same
// precedent as generate-update-manifest.test.ts.
// @ts-ignore
import { crossReference, findKeyReferences, KEY_SHAPE, REPO_ROOT } from '../../../../scripts/i18n-check.mjs';

const repoRoot: string = REPO_ROOT;
const scriptPath = join(repoRoot, 'scripts', 'i18n-check.mjs');

describe('i18n-check: on the real, current tree', () => {
  it('`node scripts/i18n-check.mjs` exits 0 — every referenced key is defined', () => {
    expect(() => execFileSync('node', [scriptPath], { cwd: repoRoot, stdio: 'pipe' })).not.toThrow();
  });
});

describe('i18n-check: KEY_SHAPE — the false-positive tightening', () => {
  it('matches real catalog ids from a known feature area', () => {
    expect(KEY_SHAPE.test('onboarding.actions.back')).toBe(true);
    expect(KEY_SHAPE.test('recovery.discardBackup.deleted')).toBe(true);
  });

  it('rejects the two real false positives the unrestricted shape caught in this tree: domain names', () => {
    // `api.openai.com` / `api.anthropic.com` in src/chat/webSearchIntent.ts
    // match a bare "lowercase, dot-namespaced" shape but are not catalog
    // ids — "api" is not a feature area. See the module comment in
    // scripts/i18n-check.mjs for the full count (54 matches, 2 excluded).
    expect(KEY_SHAPE.test('api.openai.com')).toBe(false);
    expect(KEY_SHAPE.test('api.anthropic.com')).toBe(false);
  });

  it('rejects other dotted-string shapes that are not catalog ids', () => {
    expect(KEY_SHAPE.test('application/json')).toBe(false); // MIME type, no dot at all
    expect(KEY_SHAPE.test('@conduit/ui')).toBe(false); // package specifier
    expect(KEY_SHAPE.test('package.json')).toBe(false); // "package" is not a feature area
  });
});

describe('i18n-check: crossReference', () => {
  it('reports a source reference missing from en.json as used-but-undefined', () => {
    const en = { 'onboarding.actions.back': 'Back' };
    const refs = new Map([
      ['onboarding.actions.back', [{ file: 'a.tsx', line: 1 }]],
      ['onboarding.actions.missing', [{ file: 'b.tsx', line: 2 }]],
    ]);
    const { usedButUndefined, definedButUnused } = crossReference(en, refs);
    expect([...usedButUndefined.keys()]).toEqual(['onboarding.actions.missing']);
    expect(definedButUnused).toEqual([]);
  });

  it('reports an en.json key with no source reference as defined-but-unused, without failing', () => {
    const en = { 'onboarding.actions.back': 'Back', 'onboarding.actions.dead': 'Dead' };
    const refs = new Map([['onboarding.actions.back', [{ file: 'a.tsx', line: 1 }]]]);
    const { usedButUndefined, definedButUnused } = crossReference(en, refs);
    expect(usedButUndefined.size).toBe(0);
    expect(definedButUnused).toEqual(['onboarding.actions.dead']);
  });
});

describe('i18n-check: findKeyReferences catches ids used as data, not just t() calls', () => {
  it('matches a key referenced only through an object property (e.g. labelId), as Onboarding.tsx does', () => {
    // Mirrors the real shape in src/onboarding/Onboarding.tsx: an id stored
    // in data and read indirectly via `t(s.labelId)`, which a scan anchored
    // on `t('...')` call syntax would never see.
    const source = `const STEPS = [{ id: 'provider', labelId: 'onboarding.steps.provider' }];\n`;
    const dir = mkdtempSync(join(tmpdir(), 'conduit-i18n-check-'));
    const file = join(dir, 'Fixture.tsx');
    writeFileSync(file, source);
    try {
      const refs = findKeyReferences([file]);
      expect([...refs.keys()]).toEqual(['onboarding.steps.provider']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
