// Phase 1 i18n tooling — pseudo-localization.
//
// No shebang: this file is imported directly by
// apps/desktop/src/scripts/i18n-pseudo.test.ts, and vitest's Vite/Rolldown
// SSR transform fails to parse a leading `#!` (see
// apps/desktop/src/scripts/apply-brand-identity.test.ts's module comment for
// the same call on that script, and generate-update-manifest.mjs — which
// keeps its shebang and pays exactly this cost in its own test file).
//
// Generates apps/desktop/src/i18n/messages/en-XA.json from en.json. This is
// the single highest-leverage tool in the localization plan
// (docs/plans/localization.md, Phase 1 "Tooling"): it makes German-length
// layout breakage visible before any German translation exists, by
// synthesizing a fake locale that is ~40% longer and full of accented glyphs
// — the two properties that actually break fixed-width buttons and
// truncated labels.
//
//   node scripts/i18n-pseudo.mjs           # (re)writes messages/en-XA.json
//   node scripts/i18n-pseudo.mjs --check   # exits 1 if the committed file is stale
//
// `--check` is the freshness gate: CI regenerates the catalog in memory and
// compares it against what is committed, the same shape as the
// packages/config-schema bindings check, so en.json and en-XA.json can never
// drift apart silently.
//
// THE HARD PART: ICU MUST SURVIVE INTACT
// ---------------------------------------
// A naive character substitution over the raw string would accent the ICU
// syntax itself: `{count, plural, one {# backup file} other {# backup
// files}}` would come back with `plural`, `one`, `other` and `count` all
// mangled, and the result would not parse. Only the literal text — the parts
// a translator would actually rewrite — may be touched.
//
// `@formatjs/icu-messageformat-parser` (already a devDependency of
// apps/desktop; see `loadIcuParser` below for why this script reaches into
// that package rather than depending on it itself) parses each message with
// `captureLocation: true`, which stamps every AST node with its
// `location.start/end.offset` into the ORIGINAL string. Walking the AST and
// collecting only `TYPE.literal` node spans — including literal text nested
// inside `plural`/`select` arms, e.g. the "backup file" text above — gives
// exactly the byte ranges that are safe to rewrite. Everything else
// (argument names, the `plural`/`select` keywords, arm names, `#`) is never
// touched: it is copied through unchanged because it was never collected.
// Spans are replaced back-to-front (descending start offset) so replacing
// one span never invalidates the offsets of another.
//
// Every generated message is re-parsed and checked against English's
// placeholder set before anything is written, so a bug in this script fails
// loudly here rather than shipping a broken pseudo-catalog.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = dirname(here);
const EN_PATH = join(REPO_ROOT, 'apps/desktop/src/i18n/messages/en.json');
const EN_XA_PATH = join(REPO_ROOT, 'apps/desktop/src/i18n/messages/en-XA.json');

/**
 * `@formatjs/icu-messageformat-parser` is a devDependency of apps/desktop,
 * not of the repo root, so a plain `import` from this file (which lives at
 * the repo root) cannot resolve it — pnpm's workspace node_modules is not
 * hoisted that far. Rather than add a duplicate root-level dependency for a
 * package the desktop app already ships, resolve it the same way Node would
 * if this code lived inside apps/desktop: build a `require` scoped to
 * apps/desktop/package.json and use it to find the real file, then import
 * that. The package is ESM (`"type": "module"`), so the resolved path still
 * has to go through `import()`, not `require()`.
 */
async function loadIcuParser() {
  const scopedRequire = createRequire(
    pathToFileURL(join(REPO_ROOT, 'apps/desktop/package.json')).href,
  );
  const resolved = scopedRequire.resolve('@formatjs/icu-messageformat-parser');
  return import(pathToFileURL(resolved).href);
}

/**
 * One accented Unicode codepoint per ASCII letter, lowercase. Uppercase is
 * derived with `.toUpperCase()` (verified below to round-trip to a single
 * codepoint for every entry, so string lengths never shift under case).
 * Chosen from Latin Extended-A/B and IPA Extensions for a shape that still
 * reads as the original letter — this is meant to be skimmed by a developer
 * checking layout, not decoded letter-by-letter.
 */
export const ACCENT_MAP = {
  a: 'à', b: 'ḅ', c: 'ç', d: 'ḍ', e: 'é', f: 'ḟ', g: 'ĝ', h: 'ĥ', i: 'î',
  j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ḿ', n: 'ñ', o: 'ö', p: 'ṕ', q: 'ɋ', r: 'ŕ',
  s: 'š', t: 'ť', u: 'ü', v: 'ṽ', w: 'ŵ', x: 'ẍ', y: 'ý', z: 'ž',
};

/** Fraction of total literal length appended as `—` padding (see module comment). */
const PAD_RATIO = 0.4;

/** Accent every ASCII letter in a run of literal text; everything else (spaces, punctuation, `…`) passes through untouched. */
export function accentLiteral(text) {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    const accented = ACCENT_MAP[lower];
    if (accented === undefined) {
      out += ch;
    } else {
      out += ch === lower ? accented : accented.toUpperCase();
    }
  }
  return out;
}

/**
 * Collect the `[start, end)` offset span of every literal text node in an
 * ICU AST, recursing into `plural`/`select` arms and `tag` children — the
 * three element kinds that carry nested sub-messages of their own. Requires
 * the AST to have been parsed with `captureLocation: true`.
 */
export function collectLiteralSpans(elements, TYPE, spans = []) {
  for (const el of elements) {
    switch (el.type) {
      case TYPE.literal:
        if (!el.location) {
          throw new Error('i18n-pseudo: literal node missing location (parse with captureLocation: true)');
        }
        spans.push({ start: el.location.start.offset, end: el.location.end.offset });
        break;
      case TYPE.select:
      case TYPE.plural:
        for (const option of Object.values(el.options)) collectLiteralSpans(option.value, TYPE, spans);
        break;
      case TYPE.tag:
        collectLiteralSpans(el.children, TYPE, spans);
        break;
      default:
        // argument, number, date, time, pound: no literal text of their own.
        break;
    }
  }
  return spans;
}

/**
 * Collect the placeholder names an ICU message reads, including inside
 * plural/select arms. Mirrors `apps/desktop/src/i18n/catalogs.test.ts`'s
 * `placeholders()` — duplicated rather than imported because that file lives
 * in a TypeScript app with its own module graph and this script must run as
 * plain Node with no build step.
 */
function collectPlaceholders(elements, TYPE, found = new Set()) {
  for (const el of elements) {
    switch (el.type) {
      case TYPE.argument:
      case TYPE.number:
      case TYPE.date:
      case TYPE.time:
        found.add(el.value);
        break;
      case TYPE.select:
      case TYPE.plural:
        found.add(el.value);
        for (const option of Object.values(el.options)) collectPlaceholders(option.value, TYPE, found);
        break;
      default:
        break;
    }
  }
  return found;
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((v) => b.has(v));
}

/**
 * Pseudo-localize one ICU message: accent every literal span, then wrap the
 * whole thing in `[` … `]—…` padding. `[`, `]` and `—` are not ICU-special
 * characters, so wrapping is always safe regardless of what the message
 * contains.
 */
export function pseudoLocalizeMessage(message, icu) {
  const { parse, TYPE } = icu;
  const ast = parse(message, { captureLocation: true });
  const spans = collectLiteralSpans(ast, TYPE).sort((a, b) => b.start - a.start);

  let rebuilt = message;
  let totalLiteralLength = 0;
  for (const { start, end } of spans) {
    const original = message.slice(start, end);
    totalLiteralLength += original.length;
    rebuilt = rebuilt.slice(0, start) + accentLiteral(original) + rebuilt.slice(end);
  }

  const padCount = Math.ceil(totalLiteralLength * PAD_RATIO);
  return `[${rebuilt}${'—'.repeat(padCount)}]`;
}

/**
 * Build the full en-XA catalog from an English catalog object, and verify
 * every entry: it must still parse as ICU, and it must keep exactly the
 * placeholder set English uses. Returns `{ catalog, errors }` rather than
 * throwing on the first bad key, so a run names every offending key at once.
 */
export async function generateCatalog(en) {
  const icu = await loadIcuParser();
  const { parse, TYPE } = icu;
  const catalog = {};
  const errors = [];

  for (const [key, message] of Object.entries(en)) {
    let pseudo;
    try {
      pseudo = pseudoLocalizeMessage(message, icu);
    } catch (err) {
      errors.push(`${key}: failed to pseudo-localize (${err.message})`);
      continue;
    }
    try {
      const pseudoAst = parse(pseudo, { captureLocation: true });
      const expected = collectPlaceholders(parse(message), TYPE);
      const actual = collectPlaceholders(pseudoAst, TYPE);
      if (!sameSet(expected, actual)) {
        errors.push(
          `${key}: placeholder mismatch after pseudo-localizing (expected {${[...expected].join(', ')}}, got {${[...actual].join(', ')}})`,
        );
        continue;
      }
    } catch (err) {
      errors.push(`${key}: pseudo-localized output is not valid ICU (${err.message})`);
      continue;
    }
    catalog[key] = pseudo;
  }

  return { catalog, errors };
}

/**
 * Compare ignoring line endings.
 *
 * This file is generated with LF, but git checks it out with CRLF wherever
 * `core.autocrlf` is on — every Windows clone. Comparing raw text there would
 * report the catalog as stale on a tree nobody has touched, and the fix a
 * developer would reach for (regenerate, commit) just flips the bytes back and
 * forth forever. Content is what this gate is about, so normalise first.
 */
function sameIgnoringEol(a, b) {
  return normaliseEol(a) === normaliseEol(b);
}

function normaliseEol(text) {
  return text.split('\r\n').join('\n');
}

function serialize(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

/** Names every key whose value differs, plus keys added or removed, for a `--check` failure report. */
function diffSummary(committedText, freshText) {
  let committed = {};
  try {
    committed = JSON.parse(committedText);
  } catch {
    return 'en-XA.json is not valid JSON';
  }
  const fresh = JSON.parse(freshText);
  const lines = [];
  const removed = Object.keys(committed).filter((k) => !(k in fresh));
  const added = Object.keys(fresh).filter((k) => !(k in committed));
  const changed = Object.keys(fresh).filter((k) => k in committed && committed[k] !== fresh[k]);
  for (const key of removed) lines.push(`  - ${key} (removed)`);
  for (const key of added) lines.push(`  + ${key} (added): ${fresh[key]}`);
  for (const key of changed) {
    lines.push(`  ~ ${key}`);
    lines.push(`      - ${committed[key]}`);
    lines.push(`      + ${fresh[key]}`);
  }
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const check = argv.includes('--check');
  const en = JSON.parse(readFileSync(EN_PATH, 'utf8'));
  const { catalog, errors } = await generateCatalog(en);

  if (errors.length > 0) {
    console.error(`i18n-pseudo: ${errors.length} key(s) failed verification:`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
    return;
  }

  const fresh = serialize(catalog);

  if (check) {
    let committed;
    try {
      committed = readFileSync(EN_XA_PATH, 'utf8');
    } catch {
      console.error(`i18n-pseudo: ${EN_XA_PATH} does not exist — run "node scripts/i18n-pseudo.mjs" to generate it`);
      process.exit(1);
      return;
    }
    if (!sameIgnoringEol(committed, fresh)) {
      console.error('i18n-pseudo: en-XA.json is stale relative to en.json:');
      console.error(diffSummary(committed, fresh));
      console.error('Run "node scripts/i18n-pseudo.mjs" to regenerate it.');
      process.exit(1);
      return;
    }
    console.log(`i18n-pseudo: en-XA.json is fresh (${Object.keys(catalog).length} keys).`);
    return;
  }

  writeFileSync(EN_XA_PATH, fresh, 'utf8');
  console.log(`i18n-pseudo: wrote ${EN_XA_PATH} (${Object.keys(catalog).length} keys).`);
}

// Run when invoked directly, not when imported by tests.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main();
}
