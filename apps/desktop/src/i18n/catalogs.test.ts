import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { DEFAULT_BRAND } from '../brand';
import { RICH_TAG_NAMES } from './index';
import { SHIPPED_LOCALE_CODES } from './locales';
import enMessages from './messages/en.json';
import deMessages from './messages/de.json';
import esMessages from './messages/es.json';
import frMessages from './messages/fr.json';

/// The catalog gates from D14, minus G10 (which scans *source* and lands with
/// the rest of the extraction in Phase 6). These three run against the catalog
/// files themselves and are the entire safety net under a translated string:
/// nothing else in the build can tell that a translator dropped a placeholder,
/// wrote ICU that does not parse, or baked in a product name.
///
/// Every check runs per locale rather than over a merged blob, so a failure
/// names the locale and the key.

type Catalog = Record<string, string>;

const en = enMessages as Catalog;

/**
 * Locales that must be complete.
 *
 * A locale joins this list the moment it *is* complete, not when it ships —
 * the two are different decisions, and this is the one that keeps it from
 * quietly rotting. Once German is here, an English key added without a German
 * one fails the build on the commit that adds it, rather than being discovered
 * by a reader who suddenly sees an English sentence in a German dialog.
 *
 * Shipping is Phase 6's call and additionally requires native review.
 */
const SHIPPED_FOR_RELEASE: readonly string[] = ['de', 'es', 'fr'];

/** Catalogs that exist on disk today. Grows one row per wave (D1). */
const TRANSLATIONS: ReadonlyArray<readonly [locale: string, catalog: Catalog]> = [
  ['de', deMessages as Catalog],
  ['es', esMessages as Catalog],
  ['fr', frMessages as Catalog],
];

/** Placeholder names an ICU message reads, including inside plural arms. */
function placeholders(message: string): Set<string> {
  const found = new Set<string>();
  walk(parse(message), found);
  return found;
}

function walk(elements: MessageFormatElement[], found: Set<string>): void {
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
        // Arms hold their own sub-messages, and a placeholder used in only one
        // arm is still a placeholder the translation must keep.
        for (const option of Object.values(el.options)) walk(option.value, found);
        break;
      case TYPE.tag:
        // Inline markup (`<code>`, `<strong>`) is part of the contract too: a
        // translation that drops the tag loses the styling, and one that
        // invents a tag the app does not supply renders the literal angle
        // brackets to the user. Recorded in the same set as placeholders so
        // both failures are caught by the same assertion.
        found.add(`<${el.value}>`);
        walk(el.children, found);
        break;
      default:
        break;
    }
  }
}

/**
 * The names that must survive translation verbatim (D7).
 *
 * Read from `do-not-translate.txt` rather than duplicated here, so the list a
 * translator is handed and the list the build enforces cannot drift apart —
 * which is the only way a do-not-translate list ever fails.
 */
function doNotTranslate(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, 'do-not-translate.txt'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Keys whose cardinal plural has no `one` (or `=1`) arm.
 *
 * Applied to every catalog, not just English: a translation that drops the arm
 * renders "1 servidores" exactly as English rendered "Found 1 servers", and
 * the placeholder-parity check does not see it — parity compares argument
 * names, and the arms are inside the argument.
 *
 * Locale-aware, because "every catalog" is not the same as "every language".
 * A language with no `one` category is not missing an arm; it has nothing to
 * miss.
 */
function pluralsMissingSingular(locale: string, catalog: Catalog): string[] {
  /* Which categories this language actually has, from CLDR rather than from a
   * list maintained here. Japanese has only `other`: it does not inflect for
   * number, so a `one` arm would be dead code that ICU never selects, and
   * demanding one would fail correct Japanese and reward a translator for
   * adding a branch that cannot run. English, German, Spanish, French and
   * Brazilian Portuguese all have `one`, which is where the bug this catches
   * actually lives. */
  const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  if (!categories.includes('one')) return [];

  const missing: string[] = [];
  for (const [key, value] of Object.entries(catalog)) {
    const check = (elements: MessageFormatElement[]): void => {
      for (const el of elements) {
        if (el.type === TYPE.plural && el.pluralType === 'cardinal') {
          const arms = Object.keys(el.options);
          if (!arms.includes('one') && !arms.includes('=1')) {
            missing.push(`${key}: arms are ${arms.join(', ')}`);
          }
        }
        if (el.type === TYPE.plural || el.type === TYPE.select) {
          for (const option of Object.values(el.options)) check(option.value);
        }
        if (el.type === TYPE.tag) check(el.children);
      }
    };
    check(parse(value));
  }
  return missing;
}

describe('English catalog', () => {
  it('is not empty and has no blank values', () => {
    expect(Object.keys(en).length).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), `${key} is blank`).not.toBe('');
    }
  });

  it('parses as ICU', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(() => parse(value), `${key} is not valid ICU: ${value}`).not.toThrow();
    }
  });

  it('uses dot-namespaced keys from a known feature area (D3)', () => {
    // The first segment mirrors the source tree. A key that does not start
    // with one of these is either a typo or a new area that belongs on this
    // list deliberately, not by accident.
    const areas = [
      'chat',
      'common',
      'consent',
      'error',
      'onboarding',
      'recovery',
      'settings',
      'shell',
      'workspace',
      'artifacts',
      // The app shell itself: dialogs and toasts owned by App.tsx rather
      // than by any one feature.
      'app',
    ];
    for (const key of Object.keys(en)) {
      expect(key, `${key} is not dot.namespaced`).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9-]+)+$/);
      expect(areas, `${key} has an unknown feature area`).toContain(key.split('.')[0]);
    }
  });

  it('never bakes in the product name (D8)', () => {
    // The white-label seam is `{appName}`. A literal here would survive
    // translation into every locale at once and Guard G9, which only scans
    // source, would not see it.
    for (const [key, value] of Object.entries(en)) {
      expect(value, `${key} contains a literal product name`).not.toContain(DEFAULT_BRAND.appName);
    }
  });

  it('gives every plural a singular arm', () => {
    /* `{count, plural, =0 {none} other {Found # servers}}` renders "Found 1
     * servers". Six of these were found during extraction; a seventh survived
     * and was caught by a translator rather than by anything here. */
    expect(pluralsMissingSingular('en', en)).toEqual([]);
  });

  it('uses only inline tags the renderer knows how to render', () => {
    // `useRichT` supplies a fixed set of tag handlers. A message carrying any
    // other tag renders as literal text with the angle brackets showing.
    for (const [key, value] of Object.entries(en)) {
      for (const name of [...placeholders(value)].filter((p) => p.startsWith('<'))) {
        expect(RICH_TAG_NAMES, `${key} uses unsupported tag ${name}`).toContain(
          name.slice(1, -1),
        );
      }
    }
  });
});

describe.each(TRANSLATIONS)('%s catalog', (locale, catalog) => {
  it('is a locale we actually ship', () => {
    // Not `LOCALE_CODES`: that includes the generated pseudo-locale, which is
    // never translated and must never be graded against the English catalog.
    expect(SHIPPED_LOCALE_CODES).toContain(locale);
  });

  it('has no key English does not', () => {
    // An orphan is always a bug, shipped or not: English is the source of
    // truth, so the key was renamed or deleted and the translation was left
    // behind, where it will never render again.
    const orphaned = Object.keys(catalog).filter((k) => !(k in en));
    expect(orphaned).toEqual([]);
  });

  it('is complete, once it has shipped', () => {
    // Missing keys render English (D5) — correct at runtime, and a bug at
    // build time only once we have told users the locale exists.
    //
    // Through Phase 2 every extracted file adds English keys that no
    // translation has yet, which is the expected state for weeks. So this
    // holds only shipped locales to completeness, exactly as `i18n:status
    // --strict` does, and `SHIPPED_FOR_RELEASE` fills in wave by wave.
    const missing = Object.keys(en).filter((k) => !(k in catalog));
    if (!SHIPPED_FOR_RELEASE.includes(locale)) {
      expect(Object.keys(catalog).length, `${locale} has no keys at all`).toBeGreaterThan(0);
      return;
    }
    expect(missing).toEqual([]);
  });

  it('parses as ICU', () => {
    for (const [key, value] of Object.entries(catalog)) {
      expect(() => parse(value), `${key} is not valid ICU: ${value}`).not.toThrow();
    }
  });

  it('keeps every placeholder English uses, and invents none', () => {
    // The failure this exists for: a translator drops `{count}` and the user
    // reads "Deleted backup files, freeing 4.2 MB" with no number in it, or
    // adds `{name}` and gets a literal "{name}" rendered into the sentence.
    for (const [key, value] of Object.entries(catalog)) {
      const expected = [...placeholders(en[key])].sort();
      const actual = [...placeholders(value)].sort();
      expect(actual, `${locale}/${key} placeholder mismatch`).toEqual(expected);
    }
  });

  it('never bakes in the product name (D8)', () => {
    for (const [key, value] of Object.entries(catalog)) {
      expect(value, `${locale}/${key} contains a literal product name`).not.toContain(
        DEFAULT_BRAND.appName,
      );
    }
  });

  it('gives every plural a singular arm', () => {
    expect(pluralsMissingSingular(locale, catalog)).toEqual([]);
  });

  it('keeps every name that must not be translated (D7)', () => {
    /* A name that varies by locale stops being a name. This is the failure it
     * exists for: "API-Schlüssel" is right and "Schnittstellen-Schlüssel" is
     * not, and only the second one is tempting to a translator working through
     * a thousand rows without context.
     *
     * Checked in the direction that matters — a term English uses must also
     * appear in the translation. The reverse is not a rule: a translation may
     * name a format English left implicit. */
    const terms = doNotTranslate();
    expect(terms.length, 'do-not-translate.txt is empty').toBeGreaterThan(10);

    const dropped: string[] = [];
    for (const [key, english] of Object.entries(en)) {
      const translated = catalog[key];
      if (translated === undefined) continue;
      for (const term of terms) {
        const inEnglish = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\b`);
        if (inEnglish.test(english) && !translated.includes(term)) {
          dropped.push(`${key}: "${term}" is missing from ${JSON.stringify(translated)}`);
        }
      }
    }
    expect(dropped).toEqual([]);
  });

  it('leaves no value untranslated by accident', () => {
    // Identical-to-English is legitimate for proper nouns and loanwords
    // ("Connectors", "Ollama"), so this is a floor, not a per-key rule: if
    // most of a catalog matches English it was never really translated.
    // Measured against what the catalog actually holds, not against English:
    // a partially translated locale is not more suspicious for being partial.
    const identical = Object.keys(catalog).filter((k) => catalog[k] === en[k]);
    expect(identical.length / Object.keys(catalog).length).toBeLessThan(0.25);
  });
});
