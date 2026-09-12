import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALES,
  LOCALE_CODES,
  PSEUDO_LOCALE,
  SHIPPED_LOCALES,
  SHIPPED_LOCALE_CODES,
  isSupportedLocale,
  localeEntry,
  resolveLocale,
} from './locales';

/// The locale table is duplicated across two repositories on purpose (see the
/// module comment), so the first block pins the contract that duplication
/// rests on. The rest pins `resolveLocale`, which is the only piece of logic
/// in the file and the one place a user can end up in the wrong language.

describe('locale table', () => {
  it('matches the website locale set exactly', () => {
    // pixel-website/i18n/locales.json. If a locale is added there, this fails
    // until it is added here too — which is the entire point of the assertion.
    expect(SHIPPED_LOCALE_CODES).toEqual(['en', 'de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'zh-CN']);
  });

  it('names every locale in its own language', () => {
    // A picker that says "German" to a German speaker has failed at the one
    // job it has, so this checks the two-word cases and the non-Latin ones.
    expect(localeEntry('de')?.nativeName).toBe('Deutsch');
    expect(localeEntry('ja')?.nativeName).toBe('日本語');
    expect(localeEntry('zh-CN')?.nativeName).toBe('简体中文');
    for (const entry of LOCALES) {
      expect(entry.nativeName.trim()).not.toBe('');
    }
  });

  it('is all ltr, which is what D19 assumes', () => {
    expect(LOCALES.every((l) => l.dir === 'ltr')).toBe(true);
  });

  it('keeps the pseudo-locale out of the shipped set', () => {
    // `LOCALES` carries it so the loader and resolver can find it;
    // `SHIPPED_LOCALES` is what the settings picker renders, and a user must
    // never be offered `[Šààvvéé———]` as a language.
    expect(LOCALE_CODES).toContain(PSEUDO_LOCALE);
    expect(SHIPPED_LOCALE_CODES).not.toContain(PSEUDO_LOCALE);
    expect(SHIPPED_LOCALES.every((l) => !l.pseudo)).toBe(true);
    expect(localeEntry(PSEUDO_LOCALE)?.pseudo).toBe(true);
  });

  it('recognises exactly the codes it lists', () => {
    expect(isSupportedLocale('pt-BR')).toBe(true);
    expect(isSupportedLocale('pt')).toBe(false);
    expect(isSupportedLocale('')).toBe(false);
  });
});

describe('resolveLocale', () => {
  it('honours an explicit stored choice over the OS', () => {
    expect(resolveLocale('de', ['fr-FR', 'fr'])).toBe('de');
  });

  it('follows the OS when the preference is "system"', () => {
    expect(resolveLocale('system', ['fr-FR', 'fr'])).toBe('fr');
  });

  it('follows the OS when nothing is stored', () => {
    expect(resolveLocale(null, ['de-DE'])).toBe('de');
    expect(resolveLocale(undefined, ['de-DE'])).toBe('de');
  });

  it('falls back to the OS rather than trapping the user in a withdrawn locale', () => {
    // A code that was shipped once and later removed, or a hand-edited
    // settings.json. Honouring it literally would mean a catalog that does not
    // exist; ignoring the OS as well would mean English for no reason.
    expect(resolveLocale('kl-GL', ['de-DE'])).toBe('de');
  });

  it('prefers an exact match so pt-BR does not collapse to a missing pt', () => {
    // The comment this mirrors is in the website's site.js, where the bug was
    // found the first time.
    expect(resolveLocale('system', ['pt-BR'])).toBe('pt-BR');
  });

  it('matches case-insensitively, which is how some browsers report tags', () => {
    expect(resolveLocale('system', ['pt-br'])).toBe('pt-BR');
    expect(resolveLocale('system', ['ZH-cn'])).toBe('zh-CN');
  });

  it('falls back to the primary subtag for a region we do not ship', () => {
    expect(resolveLocale('system', ['de-AT'])).toBe('de');
    expect(resolveLocale('system', ['fr-CA'])).toBe('fr');
    expect(resolveLocale('system', ['es-419'])).toBe('es');
  });

  it('maps bare pt and zh to the regional catalogs we actually ship', () => {
    // The step the website does not have: its table has no `pt` or `zh` key,
    // so both fall through to English there.
    expect(resolveLocale('system', ['pt'])).toBe('pt-BR');
    expect(resolveLocale('system', ['zh'])).toBe('zh-CN');
  });

  it('serves Brazilian Portuguese to any Portuguese region', () => {
    // One written standard, close enough that pt-BR beats English for a
    // European Portuguese reader.
    expect(resolveLocale('system', ['pt-PT'])).toBe('pt-BR');
  });

  it('does not serve Simplified Chinese to a Traditional Chinese user', () => {
    // zh-TW and zh-HK are Traditional — a different translation, not a region
    // variant of zh-CN. English is the honest answer until someone writes one.
    expect(resolveLocale('system', ['zh-TW'])).toBe('en');
    expect(resolveLocale('system', ['zh-HK'])).toBe('en');
    expect(resolveLocale('system', ['zh-Hant-HK'])).toBe('en');
  });

  it('reaches the pseudo-locale only by explicit choice', () => {
    // Deliberate: a developer picks it.
    expect(resolveLocale(PSEUDO_LOCALE, ['de-DE'])).toBe(PSEUDO_LOCALE);
    // Accidental: nothing an OS reports may ever select it. The primary
    // subtag `en` is a real locale, so this lands on English, not on pseudo.
    expect(resolveLocale('system', [PSEUDO_LOCALE])).toBe('en');
    expect(resolveLocale('system', ['en-XA', 'de'])).toBe('en');
  });

  it('walks the candidate list in order and takes the first it can serve', () => {
    expect(resolveLocale('system', ['kl-GL', 'is-IS', 'ja-JP', 'de'])).toBe('ja');
  });

  it('lands on English when nothing matches, or when asked for nothing', () => {
    expect(resolveLocale('system', ['is-IS'])).toBe(DEFAULT_LOCALE);
    expect(resolveLocale('system', [])).toBe(DEFAULT_LOCALE);
    expect(resolveLocale('system', [''])).toBe(DEFAULT_LOCALE);
  });
});

describe('LanguageSetting (Rust) agrees with the locale table (TypeScript)', () => {
  /**
   * The one cross-language contract in the whole feature, and the one that
   * fails silently: `AppSettings.language` is a Rust enum, this table is
   * TypeScript, and nothing but this test connects them. Add a locale here
   * and forget the enum and the setting cannot be persisted; add it to the
   * enum and forget here and `resolveLocale` drops a stored preference on the
   * floor and falls back to the OS. Neither shows up as a type error.
   *
   * Read as text rather than imported, because the binding is a TypeScript
   * *type* — there is no runtime value to enumerate. Same technique the other
   * guards in this repo use, for the same reason.
   */
  const here = dirname(fileURLToPath(import.meta.url));
  const binding = join(here, '..', '..', '..', '..', 'packages', 'config-schema', 'src', 'generated', 'language_setting.ts');

  function variants(): string[] {
    const src = readFileSync(binding, 'utf8');
    const union = src.match(/export type LanguageSetting =([^;]*);/);
    expect(union, 'no `export type LanguageSetting` in the generated binding').not.toBeNull();
    return Array.from(union![1].matchAll(/"([^"]+)"/g)).map((m) => m[1]);
  }

  it('offers "system" plus exactly the shipped locales, in order', () => {
    expect(variants()).toEqual(['system', ...SHIPPED_LOCALE_CODES]);
  });

  it('spells the region-qualified tags the BCP 47 way, not the camelCase way', () => {
    // ts-rs derives from the Rust variant names, so `PtBr` would arrive here
    // as "ptBr" without an explicit serde rename — and `resolveLocale` would
    // then never match it against the catalog.
    const codes = variants();
    expect(codes).toContain('pt-BR');
    expect(codes).toContain('zh-CN');
    expect(codes).not.toContain('ptBr');
    expect(codes).not.toContain('zhCn');
  });

  it('has no variant for the pseudo-locale', () => {
    // en-XA must not be persistable: it is a dev override, and a user must
    // never be able to store it as their language.
    expect(variants()).not.toContain(PSEUDO_LOCALE);
  });
});
