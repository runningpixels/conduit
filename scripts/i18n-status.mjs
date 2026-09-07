// Phase 1 i18n tooling — translation drift detection (D6,
// docs/plans/localization.md).
//
// No shebang: this file is imported directly by
// apps/desktop/src/scripts/i18n-status.test.ts, and vitest's Vite/Rolldown
// SSR transform fails to parse a leading `#!` (see
// apps/desktop/src/scripts/apply-brand-identity.test.ts's module comment).
//
// `apps/desktop/src/i18n/provenance.json` records, per locale per key, the
// SHA-1 of the ENGLISH STRING THAT WAS TRANSLATED:
//
//   { "de": { "onboarding.actions.back": "b3f1a2c…" } }
//
// Comparing that hash against the current English value classifies every key
// of every translated catalog as:
//
//   missing   — key absent from the locale catalog
//   stale     — present, but English moved on since the recorded translation
//   current   — present, and the hash matches
//   orphaned  — present in the locale catalog but not in en.json at all
//
// Without this, the app inherits exactly the failure mode the marketing
// site's translations have today (see the plan's risk table): a locale
// silently falls behind English with nothing to say so.
//
//   node scripts/i18n-status.mjs                # print the drift report
//   node scripts/i18n-status.mjs --accept=de     # stamp de's provenance to current English
//
// `--dir=<path>` overrides the `i18n/` directory to read (default:
// `apps/desktop/src/i18n`) — the seam the test suite uses to run this script
// against a scratch copy of the catalogs (a temp dir under `os.tmpdir()`)
// for the "missing key fails the build" and "stale key does not" cases,
// without ever touching the real, committed catalogs.
//
// `en-XA.json` is pseudo-localized (scripts/i18n-pseudo.mjs), not translated,
// and is never a locale this script considers — a generated catalog cannot
// go stale relative to a "translation" that never happened.
//
// EXIT CODE: 1 if any considered locale has `missing` or `orphaned` keys.
// `stale` is reported but never fails the build — that is exactly what D6
// specifies, because a stale translation still renders correctly; it is only
// out of date, which is a backlog item, not a broken build.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(here);
const DEFAULT_I18N_DIR = join(REPO_ROOT, 'apps/desktop/src/i18n');

/** Resolve `--dir=<path>` out of argv, falling back to the real repo's `i18n/` directory. */
function resolveI18nDir(argv) {
  const dirArg = argv.find((a) => a.startsWith('--dir='));
  return dirArg ? dirArg.slice('--dir='.length) : DEFAULT_I18N_DIR;
}

/** Catalog filenames that are never a "translation" and are never scored for drift. */
const EXCLUDED_CATALOGS = new Set(['en.json', 'en-XA.json']);

/** SHA-1 of an English message value, hex-encoded. This is the unit `provenance.json` stores. */
export function hashMessage(message) {
  return createHash('sha1').update(message, 'utf8').digest('hex');
}

/**
 * Locale codes to score: every `messages/*.json` file except English itself
 * and the generated pseudo-locale.
 */
export function discoverLocales(messagesDir) {
  return readdirSync(messagesDir)
    .filter((f) => f.endsWith('.json') && !EXCLUDED_CATALOGS.has(f))
    .map((f) => f.replace(/\.json$/, ''))
    .sort();
}

/**
 * Classify every key of one locale catalog against English + that locale's
 * provenance entries.
 *
 * @param {Record<string, string>} en English catalog.
 * @param {Record<string, string>} catalog The locale's catalog.
 * @param {Record<string, string>} provenance This locale's `provenance.json[locale]` (may be `{}`).
 */
export function classifyLocale(en, catalog, provenance) {
  const missing = [];
  const stale = [];
  const current = [];
  const orphaned = [];

  for (const key of Object.keys(en)) {
    if (!(key in catalog)) {
      missing.push(key);
      continue;
    }
    const expectedHash = hashMessage(en[key]);
    if (provenance[key] === expectedHash) {
      current.push(key);
    } else {
      stale.push(key);
    }
  }
  for (const key of Object.keys(catalog)) {
    if (!(key in en)) orphaned.push(key);
  }

  return { missing, stale, current, orphaned };
}

/** Load provenance.json, or `{}` if it does not exist yet (first run, before any locale is seeded). */
export function loadProvenance(path) {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Rewrite the provenance entries for every key CURRENTLY PRESENT in a
 * locale's catalog, stamping the current English hash. This is how a
 * completed translation pass is recorded (D6) — run after a translator hands
 * back a locale, and once, by hand, to seed a freshly-translated catalog
 * (`--accept=de` seeds German against the English it was translated from).
 *
 * Keys the locale does not have are left alone rather than stamped: stamping
 * a key that is not actually translated would make `missing` silently read
 * as `current`.
 */
export function acceptLocale(en, catalog, provenance) {
  const next = { ...provenance };
  for (const key of Object.keys(catalog)) {
    if (key in en) next[key] = hashMessage(en[key]);
  }
  return next;
}

function loadCatalog(messagesDir, locale) {
  return JSON.parse(readFileSync(join(messagesDir, `${locale}.json`), 'utf8'));
}

/** Fixed-width table row: `label` left-padded into `width` columns, columns separated by two spaces. */
function row(cells, widths) {
  return cells.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd();
}

function printReport(results) {
  const headers = ['locale', 'missing', 'stale', 'current', 'orphaned'];
  const widths = [8, 7, 5, 7, 8];
  console.log(row(headers, widths));
  const totals = { missing: 0, stale: 0, current: 0, orphaned: 0 };
  for (const r of results) {
    console.log(
      row([r.locale, r.missing.length, r.stale.length, r.current.length, r.orphaned.length], widths),
    );
    totals.missing += r.missing.length;
    totals.stale += r.stale.length;
    totals.current += r.current.length;
    totals.orphaned += r.orphaned.length;
  }
  console.log(row(['TOTAL', totals.missing, totals.stale, totals.current, totals.orphaned], widths));

  for (const r of results) {
    if (r.missing.length > 0) {
      console.log(`\n${r.locale}: missing (absent from catalog):`);
      for (const k of r.missing) console.log(`  ${k}`);
    }
    if (r.orphaned.length > 0) {
      console.log(`\n${r.locale}: orphaned (not in en.json):`);
      for (const k of r.orphaned) console.log(`  ${k}`);
    }
    if (r.stale.length > 0) {
      console.log(`\n${r.locale}: stale (English changed since translation — reported, does not fail):`);
      for (const k of r.stale) console.log(`  ${k}`);
    }
  }
}

export function main(argv = process.argv.slice(2)) {
  const i18nDir = resolveI18nDir(argv);
  const messagesDir = join(i18nDir, 'messages');
  const provenancePath = join(i18nDir, 'provenance.json');
  const acceptArg = argv.find((a) => a.startsWith('--accept='));
  const en = JSON.parse(readFileSync(join(messagesDir, 'en.json'), 'utf8'));

  if (acceptArg) {
    const locale = acceptArg.slice('--accept='.length);
    if (!locale) {
      console.error('i18n-status: --accept= requires a locale, e.g. --accept=de');
      process.exit(1);
      return;
    }
    if (!existsSync(join(messagesDir, `${locale}.json`))) {
      console.error(`i18n-status: no catalog at ${join(messagesDir, `${locale}.json`)}`);
      process.exit(1);
      return;
    }
    const catalog = loadCatalog(messagesDir, locale);
    const allProvenance = loadProvenance(provenancePath);
    const before = allProvenance[locale] ?? {};
    const after = acceptLocale(en, catalog, before);
    allProvenance[locale] = after;
    writeFileSync(provenancePath, `${JSON.stringify(allProvenance, null, 2)}\n`, 'utf8');
    console.log(`i18n-status: accepted ${locale} — stamped ${Object.keys(catalog).length} key(s) as current.`);
    return;
  }

  const locales = discoverLocales(messagesDir);
  const allProvenance = loadProvenance(provenancePath);
  const results = locales.map((locale) => {
    const catalog = loadCatalog(messagesDir, locale);
    const provenance = allProvenance[locale] ?? {};
    return { locale, ...classifyLocale(en, catalog, provenance) };
  });

  printReport(results);

  /* An orphan — a key the locale has and English does not — is always a bug:
   * English is the source of truth, so the key was renamed or deleted and the
   * translation was left behind. It fails whatever mode we are in.
   *
   * A *missing* key is only a bug once the locale has shipped. Through Phase 2
   * every extraction adds English keys no translation has yet, which is the
   * expected state for weeks, and a command that always exits non-zero is a
   * command people stop reading. So `--strict` is what CI runs from wave 1
   * (D6: CI fails on missing for any shipped locale), and the bare command
   * reports the same numbers without failing. */
  const strict = argv.includes('--strict');
  const anyOrphaned = results.some((r) => r.orphaned.length > 0);
  const anyMissing = results.some((r) => r.missing.length > 0);

  if (anyOrphaned) {
    console.error('\ni18n-status: FAIL — a locale has keys English does not. Rename or delete them.');
    process.exit(1);
    return;
  }
  if (anyMissing && strict) {
    console.error('\ni18n-status: FAIL — a shipped locale is missing keys (--strict).');
    process.exit(1);
    return;
  }
  if (anyMissing) {
    console.log(
      '\ni18n-status: OK — missing keys are reported above and not yet translated. ' +
        'CI runs --strict, which fails on them.',
    );
    return;
  }
  console.log('\ni18n-status: OK (stale keys, if any, are reported above but do not fail — D6).');
}

// Run when invoked directly, not when imported by tests.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}
