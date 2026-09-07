// Phase 1 i18n tooling — source <-> catalog cross-reference.
//
// No shebang: this file is imported directly by
// apps/desktop/src/scripts/i18n-check.test.ts, and vitest's Vite/Rolldown
// SSR transform fails to parse a leading `#!` (see
// apps/desktop/src/scripts/apply-brand-identity.test.ts's module comment).
//
// D4 of docs/plans/localization.md says `en.json` would be produced by
// `formatjs extract`. That does not apply here: extraction generates message
// ids from `defaultMessage` values written at each call site
// (`formatMessage({ id, defaultMessage })`), whereas D3 chose hand-written,
// hierarchical ids and call sites in this codebase carry only the id
// (`t('onboarding.actions.back')`) — there is no `defaultMessage` for
// `formatjs extract` to read, so there is nothing to extract. This script is
// the useful inverse: it scans source for anything that LOOKS like a catalog
// key reference and cross-references it against `en.json`, in both
// directions.
//
//   node scripts/i18n-check.mjs
//
// Two findings:
//
//   used-but-undefined  — referenced in source, absent from en.json.
//                         This is a real bug: it renders a raw key
//                         ("onboarding.actions.back") straight into the UI.
//                         Fails the build (exit 1).
//
//   defined-but-unused  — in en.json, referenced nowhere in source. Dead
//                         keys are untidy, not broken — a key can legitimately
//                         be referenced only through a dynamic expression
//                         this scan cannot see (e.g. `t(dynamicId)`). Warned,
//                         never fails the build.
//
// MATCHING ON THE KEY SHAPE, NOT ON `t(...)` CALLS
// --------------------------------------------------
// Catalog ids also appear as data, not just as `t()` arguments — e.g.
// `Onboarding.tsx`'s `STEPS` array carries `labelId: 'onboarding.steps.provider'`
// read by a later `t(s.labelId)`. A scan anchored on `t('…')` call syntax
// would miss that reference entirely and report the key as unused. Matching
// on the shape of the string literal instead catches both.
//
// KEEPING THE SHAPE SCAN FROM SWEEPING UP UNRELATED DOTTED STRINGS
// -------------------------------------------------------------------
// A bare "dot-namespaced lowercase identifier" shape also matches import
// paths, CSS custom properties, MIME types, and domain names. Run against
// the real tree as written, the unrestricted shape
// (`^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$`) matched 54 string literals, of
// which exactly 2 were not real catalog references: `api.openai.com` and
// `api.anthropic.com` in `src/chat/webSearchIntent.ts`. Restricting the
// first segment to the known feature areas — the same list
// `catalogs.test.ts` already enforces for every `en.json` key (D3) — excludes
// both without an explicit allowlist, because "api" is not a feature area.
// If a future string coincidentally starts with one of these segments and
// is not actually a catalog id, that is a real ambiguity to resolve by
// tightening this list, not a bug in the scan.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(here);
const SRC_ROOT = join(REPO_ROOT, 'apps/desktop/src');
const EN_PATH = join(SRC_ROOT, 'i18n/messages/en.json');

/** Mirrors the feature-area list `catalogs.test.ts` enforces for every en.json key (D3). */
export const FEATURE_AREAS = [
  'chat', 'common', 'consent', 'error', 'onboarding',
  'recovery', 'settings', 'shell', 'workspace', 'artifacts', 'app',
];

/** A catalog key: `<known feature area>(.<alphanumeric segment>)+`. See module comment for why the first segment is restricted. */
// A segment may carry a hyphen so a key can mirror an id the source already
// uses: `shell.settingsSheet.nav.web-search` tracks the 'web-search' section
// id, and renaming one without the other is how they drift apart.
export const KEY_SHAPE = new RegExp(`^(?:${FEATURE_AREAS.join('|')})(?:\\.[a-zA-Z0-9-]+)+$`);

/** Single- or double-quoted string literal, handling `\\`-escaped quotes. Deliberately not template literals: a dynamic `t(\`...${x}\`)` id cannot be a static reference anyway. */
const STRING_LITERAL = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Posix-style path relative to apps/desktop/src, for stable reporting. */
function rel(file) {
  return relative(SRC_ROOT, file).split(sep).join('/');
}

/** Every `.ts`/`.tsx` source file this check considers: no tests, nothing under `src/i18n/` (the catalogs themselves and their own tests, exempt per the task brief). */
export function sourceFiles(srcRoot = SRC_ROOT) {
  return walk(srcRoot)
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => !/\.test\.tsx?$/.test(f))
    .filter((f) => !rel(f).startsWith('i18n/'));
}

/**
 * Every string literal matching the catalog key shape, per file, with line
 * numbers for reporting. A key referenced twice in the same file is recorded
 * once, at its first occurrence — dedup happens by key across the whole
 * scan, not here.
 */
export function findKeyReferences(files) {
  const refs = new Map(); // key -> { file, line }[]
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      STRING_LITERAL.lastIndex = 0;
      let m;
      while ((m = STRING_LITERAL.exec(lines[i]))) {
        const value = m[1] ?? m[2];
        if (KEY_SHAPE.test(value)) {
          if (!refs.has(value)) refs.set(value, []);
          refs.get(value).push({ file: rel(file), line: i + 1 });
        }
      }
    }
  }
  return refs;
}

/**
 * Cross-reference source key references against en.json.
 *
 * @returns {{ usedButUndefined: Map<string, {file:string,line:number}[]>, definedButUnused: string[] }}
 */
export function crossReference(en, refs) {
  const usedButUndefined = new Map();
  for (const [key, occurrences] of refs) {
    if (!(key in en)) usedButUndefined.set(key, occurrences);
  }
  const referenced = refs;
  const definedButUnused = Object.keys(en).filter((key) => !referenced.has(key));
  return { usedButUndefined, definedButUnused };
}

export function main() {
  const en = JSON.parse(readFileSync(EN_PATH, 'utf8'));
  const files = sourceFiles();
  const refs = findKeyReferences(files);
  const { usedButUndefined, definedButUnused } = crossReference(en, refs);

  if (definedButUnused.length > 0) {
    console.warn(`i18n-check: ${definedButUnused.length} key(s) defined in en.json but never referenced (not a failure):`);
    for (const key of definedButUnused) console.warn(`  ${key}`);
  }

  if (usedButUndefined.size > 0) {
    console.error(`i18n-check: ${usedButUndefined.size} key(s) referenced in source but missing from en.json:`);
    for (const [key, occurrences] of usedButUndefined) {
      for (const { file, line } of occurrences) console.error(`  ${key}  (${file}:${line})`);
    }
    process.exit(1);
    return;
  }

  console.log(`i18n-check: OK — ${refs.size} key reference(s) across ${files.length} file(s), all defined in en.json.`);
}

// Run when invoked directly, not when imported by tests.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}
