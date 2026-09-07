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
  it('reports a missing key without failing, and fails on it under --strict', () => {
    /* The split D6 asks for, and the reason it is a split: through Phase 2
     * every extracted file adds English keys no translation has yet, so
     * "missing" is the expected state of a locale that has not shipped. A
     * command that always exits non-zero is one people stop reading. CI runs
     * `--strict` from wave 1, when a shipped locale really must be complete. */
    const en = { 'onboarding.actions.back': 'Back', 'onboarding.actions.continue': 'Continue' };
    const de = { 'onboarding.actions.back': 'Zurück' }; // "continue" removed
    const provenance = { de: { 'onboarding.actions.back': hashMessage('Back') } };
    const dir = makeI18nDir(en, de, provenance);
    try {
      // The `node:child_process` shim in vite-env.d.ts types execFileSync as
      // `unknown`, which is honest — it returns a Buffer here.
      const report = String(runStatus(dir));
      expect(report).toContain('onboarding.actions.continue');

      expect(() => runStatus(dir, ['--strict'])).toThrow();
      try {
        runStatus(dir, ['--strict']);
      } catch (err) {
        expect((err as { status?: number }).status).toBe(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails on an orphaned key whether or not --strict is passed', () => {
    /* An orphan is a key the locale has and English does not: it was renamed
     * or deleted upstream and the translation was left behind, where it can
     * never render again. That is a bug at any point in the rollout, so it is
     * the one classification that is not softened during Phase 2. */
    const en = { 'onboarding.actions.back': 'Back' };
    const de = { 'onboarding.actions.back': 'Zurück', 'onboarding.actions.gone': 'Weg' };
    const provenance = { de: { 'onboarding.actions.back': hashMessage('Back') } };
    const dir = makeI18nDir(en, de, provenance);
    try {
      expect(() => runStatus(dir)).toThrow();
      expect(() => runStatus(dir, ['--strict'])).toThrow();
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
