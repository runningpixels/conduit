/**
 * The locale table, and the rule for picking one.
 *
 * Deliberately a mirror of `pixel-website/i18n/locales.json`: the marketing
 * site and the app must agree on which languages exist and on what each one
 * is called in its own language, or a user who picked Deutsch on the website
 * and sees "German" in the app has been told two different things. Kept in
 * sync by hand — eight rows that change once a year do not justify a codegen
 * step across two repositories.
 *
 * `dir` is carried even though every current locale is `ltr` (see D19 in
 * `docs/plans/localization.md`): it costs one field now, and an RTL locale
 * arriving later should extend a table, not introduce a concept.
 */

export interface LocaleEntry {
  /** BCP 47 tag. The catalog filename is `messages/<code>.json`. */
  code: string;
  /** The language's name *in that language*, for the picker. */
  nativeName: string;
  dir: 'ltr' | 'rtl';
  /**
   * Generated for layout QA, never translated and never offered to a user.
   * Exactly one locale sets this: `en-XA`. See `PSEUDO_LOCALE` below.
   */
  pseudo?: boolean;
}

export const DEFAULT_LOCALE = 'en';

/**
 * The pseudo-locale.
 *
 * `scripts/i18n-pseudo.mjs` derives `messages/en-XA.json` from `en.json` by
 * accenting every letter and padding each string by ~40% — `Save` becomes
 * `[Saavvee———]` with accents. Running the app in it makes two classes of bug
 * visible that no amount of reading English can surface: text that will
 * overflow once German arrives, and text that was never extracted at all (it
 * stays unaccented, which is glaring on a screen where everything else is
 * not).
 *
 * `en-XA` is the conventional tag for this — `XA` is a BCP 47 private-use
 * region, so it can never collide with a real locale.
 *
 * It is reachable only by choosing it explicitly. `resolveLocale` will never
 * select it from `navigator.languages`, no matter what the OS reports.
 */
export const PSEUDO_LOCALE = 'en-XA';

export const LOCALES: readonly LocaleEntry[] = [
  { code: 'en', nativeName: 'English', dir: 'ltr' },
  { code: 'de', nativeName: 'Deutsch', dir: 'ltr' },
  { code: 'es', nativeName: 'Español', dir: 'ltr' },
  { code: 'fr', nativeName: 'Français', dir: 'ltr' },
  { code: 'ja', nativeName: '日本語', dir: 'ltr' },
  { code: 'ko', nativeName: '한국어', dir: 'ltr' },
  { code: 'pt-BR', nativeName: 'Português (Brasil)', dir: 'ltr' },
  { code: 'zh-CN', nativeName: '简体中文', dir: 'ltr' },
  { code: PSEUDO_LOCALE, nativeName: 'Pseudo (en-XA)', dir: 'ltr', pseudo: true },
] as const;

/**
 * The locales a user can actually be given — everything except the pseudo
 * one. This is the list the settings picker renders and the list the catalog
 * parity gate holds to English; `LOCALES` (with the pseudo entry) is only for
 * code that has to resolve or load a locale.
 */
export const SHIPPED_LOCALES: readonly LocaleEntry[] = LOCALES.filter((l) => !l.pseudo);

export const LOCALE_CODES: readonly string[] = LOCALES.map((l) => l.code);

export const SHIPPED_LOCALE_CODES: readonly string[] = SHIPPED_LOCALES.map((l) => l.code);

export function isSupportedLocale(code: string): boolean {
  return LOCALE_CODES.includes(code);
}

export function localeEntry(code: string): LocaleEntry | undefined {
  return LOCALES.find((l) => l.code === code);
}

/**
 * Primary subtags we can serve out of a region-qualified catalog.
 *
 * The site's chain (below) drops `pt` and `zh` on the floor, because neither
 * is a key in its table — only `pt-BR` and `zh-CN` are. A browser reporting
 * bare `pt` is far likelier to want Brazilian Portuguese than English, so the
 * app adds this one step the site does not have.
 *
 * `acceptAnyRegion` is where the two differ, and the difference is not
 * cosmetic. Portuguese regions share one written standard closely enough that
 * a `pt-PT` reader is better served by `pt-BR` than by English. Chinese does
 * not: `zh-TW` and `zh-HK` are Traditional, a different translation rather
 * than a regional variant of this one, and quietly serving them Simplified is
 * worse than serving them English. So `zh` matches only when the browser
 * reported it bare, with no region at all.
 */
const PRIMARY_SUBTAG_FALLBACKS: Record<string, { target: string; acceptAnyRegion: boolean }> = {
  pt: { target: 'pt-BR', acceptAnyRegion: true },
  zh: { target: 'zh-CN', acceptAnyRegion: false },
};

/**
 * Resolve the locale to render in.
 *
 * The first four steps mirror `pixel-website/public/js/site.js:126-131`
 * exactly — exact match, then lowercased, then primary subtag — so the two
 * surfaces cannot disagree about what `de-AT` means. Step five is the alias
 * table above. Anything unrecognised lands on English.
 *
 * @param stored  the persisted `AppSettings.language`: a locale code, or
 *                `'system'`/`null` to follow the OS.
 * @param preferred  candidates in priority order, normally
 *                `navigator.languages`. Passed in rather than read here so
 *                this stays a pure function and the tests do not have to
 *                stub a global.
 */
export function resolveLocale(
  stored: string | null | undefined,
  preferred: readonly string[] = [],
): string {
  if (stored && stored !== 'system') {
    // An explicit choice is honoured if we can serve it at all, and is never
    // overridden by the OS. A stored code we no longer ship (a locale was
    // withdrawn, or settings.json was hand-edited) falls through to the OS
    // rather than trapping the user in a language with no catalog.
    // The explicit branch is the only way to reach the pseudo-locale: it is a
    // deliberate choice a developer makes, never something an OS reports.
    const explicit = matchLocale(stored, LOCALE_CODES);
    if (explicit) return explicit;
  }
  for (const candidate of preferred) {
    const match = matchLocale(candidate, SHIPPED_LOCALE_CODES);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}

function matchLocale(candidate: string, pool: readonly string[]): string | undefined {
  if (!candidate) return undefined;
  if (pool.includes(candidate)) return candidate;

  const lower = candidate.toLowerCase();
  const lowerMatch = pool.find((code) => code.toLowerCase() === lower);
  if (lowerMatch) return lowerMatch;

  const primary = lower.split('-')[0];
  const primaryMatch = pool.find((code) => code.toLowerCase() === primary);
  if (primaryMatch) return primaryMatch;

  const fallback = PRIMARY_SUBTAG_FALLBACKS[primary];
  if (fallback && (fallback.acceptAnyRegion || lower === primary)) return fallback.target;

  return undefined;
}
