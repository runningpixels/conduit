import { describe, expect, it } from 'vitest';
import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { DEFAULT_BRAND } from '../brand';
import { RICH_TAG_NAMES } from './index';
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

/**
 * Locales we have told users exist, and which must therefore be complete.
 *
 * Empty until wave 1 (de, es, fr) ships in Phase 6. `de` is on disk today as
 * the Phase 0 spike translation — real, reviewed for the screens it covers,
 * and deliberately far from complete while extraction is still running.
 */
const SHIPPED_FOR_RELEASE: readonly string[] = [];

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
