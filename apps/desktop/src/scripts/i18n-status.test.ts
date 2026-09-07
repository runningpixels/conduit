import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Repo-root tooling script (Phase 1 i18n, docs/plans/localization.md). Plain
// ESM JS with no type bindings; vitest runs it directly. `@ts-ignore` keeps
// `tsc -b` (`pnpm check`) quiet about the missing declaration, the same
// precedent as generate-update-manifest.test.ts.
// @ts-ignore
import { acceptLocale, classifyLocale, hashMessage, REPO_ROOT } from '../../../../scripts/i18n-status.mjs';

const repoRoot: string = REPO_ROOT;
const scriptPath = join(repoRoot, 'scripts', 'i18n-status.mjs');

/**
 * A scratch `i18n/` directory (`messages/en.json`, `messages/de.json`,
 * `provenance.json`) under `os.tmpdir()`, so the mutation tests below can
 * remove or stale a key without ever touching the real, committed catalogs.
 * `--dir=<path>` (scripts/i18n-status.mjs) is exactly the seam this needs.
 */
function makeI18nDir(en: Record<string, string>, de: Record<string, string>, provenance: object) {
  const dir = mkdtempSync(join(tmpdir(), 'conduit-i18n-status-'));
  mkdirSync(join(dir, 'messages'), { recursive: true });
  writeFileSync(join(dir, 'messages', 'en.json'), JSON.stringify(en, null, 2));
  writeFileSync(join(dir, 'messages', 'de.json'), JSON.stringify(de, null, 2));
  writeFileSync(join(dir, 'provenance.json'), JSON.stringify(provenance, null, 2));
  return dir;
}

function runStatus(i18nDir: string, extraArgs: string[] = []) {
  return execFileSync('node', [scriptPath, `--dir=${i18nDir}`, ...extraArgs], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
}

describe('i18n-status: on the real, current tree', () => {
  it('`node scripts/i18n-status.mjs` exits 0 — the seeded German catalog is fully current', () => {
    expect(() => execFileSync('node', [scriptPath], { cwd: repoRoot, stdio: 'pipe' })).not.toThrow();
  });
});

describe('i18n-status: classifyLocale', () => {
  const en = { a: 'Hello', b: 'World', c: 'Again' };

  it('classifies missing, stale, current and orphaned independently', () => {
    const catalog = { a: 'Hallo', c: 'Nochmal', d: 'Orphan' }; // b missing, d orphaned
    const provenance = { a: hashMessage('Hello'), c: hashMessage('an old English value') }; // a current, c stale
    const result = classifyLocale(en, catalog, provenance);
    expect(result.missing).toEqual(['b']);
    expect(result.current).toEqual(['a']);
    expect(result.stale).toEqual(['c']);
    expect(result.orphaned).toEqual(['d']);
  });
});

describe('i18n-status: acceptLocale', () => {
  it('stamps every key present in the catalog to the current English hash, and leaves missing keys alone', () => {
    const en = { a: 'Hello', b: 'World' };
    const catalog = { a: 'Hallo' }; // b not translated yet
    const next = acceptLocale(en, catalog, {});
    expect(next).toEqual({ a: hashMessage('Hello') });
    expect(next.b).toBeUndefined();
  });
});

describe('i18n-status: mutation tests against a scratch catalog (never the real one)', () => {
  it('exits 1 when a key is removed from a locale catalog (missing)', () => {
    const en = { 'onboarding.actions.back': 'Back', 'onboarding.actions.continue': 'Continue' };
    const de = { 'onboarding.actions.back': 'Zurück' }; // "continue" removed
    const provenance = { de: { 'onboarding.actions.back': hashMessage('Back') } };
    const dir = makeI18nDir(en, de, provenance);
    try {
      expect(() => runStatus(dir)).toThrow();
      try {
        runStatus(dir);
      } catch (err) {
        const status = (err as { status?: number }).status;
        expect(status).toBe(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stale key is reported but does not fail the build', () => {
    const en = { 'onboarding.actions.back': 'Back' };
    const de = { 'onboarding.actions.back': 'Zurück' };
    // Provenance hash is for a DIFFERENT English string than what en.json has now.
    const provenance = { de: { 'onboarding.actions.back': hashMessage('Back (old copy)') } };
    const dir = makeI18nDir(en, de, provenance);
    try {
      let output = '';
      expect(() => {
        output = execFileSync('node', [scriptPath, `--dir=${dir}`], {
          cwd: repoRoot,
          stdio: 'pipe',
        }) as unknown as string;
      }).not.toThrow();
      // stdio: 'pipe' with no encoding returns a Buffer; stringify defensively either way.
      const text = output ? output.toString() : '';
      expect(text).toContain('de');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--accept=<locale> rewrites that locale\'s provenance to the current English hash', () => {
    const en = { 'onboarding.actions.back': 'Back' };
    const de = { 'onboarding.actions.back': 'Zurück' };
    const provenance = { de: { 'onboarding.actions.back': hashMessage('an old value') } };
    const dir = makeI18nDir(en, de, provenance);
    try {
      execFileSync('node', [scriptPath, `--dir=${dir}`, '--accept=de'], { cwd: repoRoot, stdio: 'pipe' });
      const written = JSON.parse(readFileSync(join(dir, 'provenance.json'), 'utf8'));
      expect(written.de['onboarding.actions.back']).toBe(hashMessage('Back'));
      // Accepted, so a subsequent status run is clean.
      expect(() => runStatus(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
