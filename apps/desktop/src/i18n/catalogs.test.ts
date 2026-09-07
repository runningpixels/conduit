import { describe, expect, it } from 'vitest';
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { DEFAULT_BRAND } from '../brand';
import { SHIPPED_LOCALE_CODES } from './locales';
import enMessages from './messages/en.json';
import deMessages from './messages/de.json';

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

/** Catalogs that exist on disk today. Grows one row per wave (D1). */
const TRANSLATIONS: ReadonlyArray<readonly [locale: string, catalog: Catalog]> = [
  ['de', deMessages as Catalog],
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
      default:
        break;
    }
  }
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
    ];
    for (const key of Object.keys(en)) {
      expect(key, `${key} is not dot.namespaced`).toMatch(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/);
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
});

describe.each(TRANSLATIONS)('%s catalog', (locale, catalog) => {
  it('is a locale we actually ship', () => {
    // Not `LOCALE_CODES`: that includes the generated pseudo-locale, which is
    // never translated and must never be graded against the English catalog.
    expect(SHIPPED_LOCALE_CODES).toContain(locale);
  });

  it('has exactly the English key set — no missing, no orphans', () => {
    // Missing keys would silently render English (D5), which is correct
    // behaviour at runtime and a bug at build time: a shipped locale is
    // supposed to be complete. Orphans mean English moved on without it.
    const missing = Object.keys(en).filter((k) => !(k in catalog));
    const orphaned = Object.keys(catalog).filter((k) => !(k in en));
    expect({ missing, orphaned }).toEqual({ missing: [], orphaned: [] });
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

  it('leaves no value untranslated by accident', () => {
    // Identical-to-English is legitimate for proper nouns and loanwords
    // ("Connectors", "Ollama"), so this is a floor, not a per-key rule: if
    // most of a catalog matches English it was never really translated.
    const identical = Object.keys(catalog).filter((k) => catalog[k] === en[k]);
    expect(identical.length / Object.keys(en).length).toBeLessThan(0.25);
  });
});
