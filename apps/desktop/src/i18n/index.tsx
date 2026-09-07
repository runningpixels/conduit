/**
 * The translation seam.
 *
 * Shape, and why (see `docs/plans/localization.md`):
 *
 *   - `en.json` is the source of truth and is **statically** imported. Every
 *     other catalog is loaded with a dynamic `import()`, so Vite code-splits
 *     them and a launch only ever parses two catalogs at most (D4).
 *   - A missing or malformed key renders the English string, never the key
 *     (D5). That is what makes wave-based shipping safe: a half-translated
 *     locale degrades to English, not to `settings.privacy.deleteData.title`
 *     in the middle of a dialog. It is implemented by handing every
 *     `formatMessage` call the English value as its `defaultMessage`.
 *   - `{appName}` is injected into every message automatically (D8), so call
 *     sites write `t('onboarding.welcome.title')` and never think about it.
 *     Messages must never bake in a literal product name; Guard G10 will
 *     enforce that, and G9 already enforces the same rule in source.
 *
 * The one structural decision worth flagging: `useT()` reads react-intl's
 * context but **falls back to a module-level English `IntlShape`** when there
 * is no provider above it. `useIntl()` throws in that situation. Falling back
 * instead means the ~90 existing component tests that call bare
 * `render(<Thing />)` keep working with no wrapper and no edit, which is the
 * difference between "extract 300 strings" and "extract 300 strings and touch
 * 92 test files". Production always has a provider; the fallback is for tests
 * and for any component rendered outside the tree (error boundaries).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  createIntl,
  createIntlCache,
  IntlContext,
  RawIntlProvider,
  type IntlShape,
  type PrimitiveType,
} from 'react-intl';
import enMessages from './messages/en.json';
import { appName } from '../brand';
import { DEFAULT_LOCALE, isSupportedLocale, resolveLocale } from './locales';

export type Messages = Record<string, string>;

/** The English catalog, exported so tooling and tests can assert against it. */
export const EN_MESSAGES: Messages = enMessages as Messages;

/* react-intl memoises its Intl.* formatters here. One cache for the process:
 * constructing an Intl.NumberFormat is expensive enough that re-creating one
 * per render is a real cost, and the cache is keyed by locale + options, so
 * sharing it across locale switches is safe. */
const cache = createIntlCache();

function handleIntlError(err: Error): void {
  /* Production stays silent: `defaultMessage` has already substituted English,
   * so the user sees correct text and there is nothing actionable at runtime.
   * Development is loud, because a message that reaches here is either a typo
   * in a key or a translation whose ICU syntax does not parse — both are bugs
   * that must be caught before a catalog ships. */
  if (import.meta.env.DEV) {
    console.warn('[i18n]', err.message);
  }
}

export function createAppIntl(locale: string, messages: Messages): IntlShape {
  return createIntl(
    {
      locale,
      defaultLocale: DEFAULT_LOCALE,
      messages,
      onError: handleIntlError,
    },
    cache,
  );
}

/** The provider-less fallback described in the module comment. English. */
const fallbackIntl = createAppIntl(DEFAULT_LOCALE, EN_MESSAGES);

/**
 * Catalog loaders, one per `messages/*.json`, resolved by Vite at build time.
 * A glob rather than a hand-maintained map so adding `messages/ko.json` is the
 * whole change — there is no second list to forget.
 */
const CATALOG_LOADERS = import.meta.glob<{ default: Messages }>('./messages/*.json');

export async function loadMessages(locale: string): Promise<Messages> {
  if (locale === DEFAULT_LOCALE) return EN_MESSAGES;
  const loader = CATALOG_LOADERS['./messages/' + locale + '.json'];
  if (!loader) {
    /* A supported locale with no catalog on disk is normal mid-rollout: the
     * locale table lists all eight from day one, and catalogs land wave by
     * wave (D1). English is the correct answer, and D5 already guarantees it
     * per-key, so this is just the whole-file case of the same rule. */
    return EN_MESSAGES;
  }
  const mod = await loader();
  return mod.default;
}

/**
 * Last-known language preference, mirrored into localStorage.
 *
 * The authoritative value is `AppSettings.language`, which lives behind IPC —
 * and IPC is far too late: `get_settings` resolves after first paint, so a
 * German user would read a frame of English on every launch. This is the same
 * problem `applyCachedBrand` solves in `main.tsx`, solved the same way, and
 * for the same reason its comment gives: replay the last-known-good value
 * synchronously at boot, then let App reconcile against Rust once it lands.
 *
 * Being a cache rather than a source of truth is what makes it safe. If it is
 * missing, stale, or garbage, the worst case is one frame in the wrong
 * language before the real setting arrives.
 */
const LANGUAGE_CACHE_KEY = 'conduit:v1-language';

export function readCachedLanguage(): string {
  try {
    return window.localStorage.getItem(LANGUAGE_CACHE_KEY) ?? 'system';
  } catch {
    return 'system';
  }
}

export function writeCachedLanguage(preference: string): void {
  try {
    window.localStorage.setItem(LANGUAGE_CACHE_KEY, preference);
  } catch {
    // Storage unavailable. The next launch shows one English frame; nothing
    // else depends on this having worked.
  }
}

export interface I18nBootstrap {
  /** What was asked for: a locale code, or `'system'`. */
  preference: string;
  /** What that resolves to on this machine. Always a locale we can load. */
  locale: string;
  /** The catalog, already parsed — the point of doing this before render. */
  messages: Messages;
}

/**
 * Resolve the language and load its catalog *before* the first render.
 *
 * Called from `main.tsx`. The await is a dynamic `import()` of a JSON module
 * that is already inside the app bundle — not a network request and not IPC —
 * so it costs a microtask, and English costs not even that (`en.json` is
 * statically imported and `loadMessages` returns it synchronously).
 *
 * @param override  a preference that outranks the cache, used by the dev
 *                  locale switch. `undefined` means "use the cache".
 */
export async function bootstrapI18n(override?: string): Promise<I18nBootstrap> {
  const preference = override && override !== 'system' ? override : readCachedLanguage();
  const locale = resolveLocale(preference, navigatorLanguages());
  const messages = await loadMessages(locale);
  return { preference, locale, messages };
}

export type TranslateValues = Record<string, PrimitiveType>;

/** Format one message by id. Always returns a string. */
export type Translate = (id: string, values?: TranslateValues) => string;

function translateWith(intl: IntlShape): Translate {
  return (id, values) =>
    intl.formatMessage(
      /* `defaultMessage` is the English text for this id. This single line is
       * the whole of D5: react-intl renders it whenever `messages[id]` is
       * absent from the active catalog or fails to parse. */
      { id, defaultMessage: EN_MESSAGES[id] },
      { appName: appName(), ...values },
    ) as string;
}

/**
 * The hook every call site uses.
 *
 * Returns a stable `t(id, values?)`. `appName` is always available as a
 * placeholder without being passed.
 */
export function useT(): Translate {
  const intl = useContext(IntlContext) ?? fallbackIntl;
  return useCallback(translateWith(intl), [intl]);
}

/**
 * Escape hatch for the formatters `t()` cannot express — dates, numbers,
 * relative times, and rich text with embedded elements. Same provider-less
 * fallback as `useT()`.
 */
export function useIntlSafe(): IntlShape {
  return useContext(IntlContext) ?? fallbackIntl;
}

/** Imperative `t` for code outside React (IPC error mapping, plain modules). */
export function translate(intl: IntlShape, id: string, values?: TranslateValues): string {
  return translateWith(intl)(id, values);
}

interface LocaleControl {
  /** The locale actually being rendered — always a supported code. */
  locale: string;
  /** What the user chose: a code, or `'system'` to follow the OS. */
  preference: string;
  /**
   * True when a dev override (`?locale=`, `__setLocale`) is pinning the
   * language. `setPreference` is inert while it is set, so that App's
   * reconcile against `AppSettings.language` cannot silently undo the
   * override a developer just asked for — which is the only way to reach the
   * pseudo-locale, since it has no `LanguageSetting` variant to persist to.
   */
  overridden: boolean;
  setPreference: (next: string) => void;
}

const LocaleControlContext = createContext<LocaleControl | null>(null);

/**
 * Read and change the active language.
 *
 * Phase 0 backs `setPreference` with component state only. Phase 1 persists it
 * to `AppSettings.language`; this hook's shape does not change when it does,
 * so the picker written against it survives.
 */
export function useLocale(): LocaleControl {
  const ctx = useContext(LocaleControlContext);
  if (ctx) return ctx;
  /* Outside a provider (tests), report the truth: English, not switchable. */
  return {
    locale: DEFAULT_LOCALE,
    preference: DEFAULT_LOCALE,
    overridden: false,
    setPreference: () => {},
  };
}

export function I18nProvider({
  initialPreference = 'system',
  initialMessages,
  overridden = false,
  children,
}: {
  initialPreference?: string;
  /**
   * The catalog for `initialPreference`, already loaded by `bootstrapI18n`.
   * Supplying it is what makes a non-English launch paint in that language on
   * the *first* frame instead of the second. Omitting it is fine — tests do,
   * and get one English frame before the catalog resolves.
   */
  initialMessages?: Messages;
  overridden?: boolean;
  children: ReactNode;
}) {
  const [preference, setPreferenceState] = useState(initialPreference);

  const locale = useMemo(() => resolveLocale(preference, navigatorLanguages()), [preference]);

  const [messages, setMessages] = useState<Messages>(initialMessages ?? EN_MESSAGES);

  useEffect(() => {
    let cancelled = false;
    void loadMessages(locale).then((next) => {
      if (!cancelled) setMessages(next);
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const intl = useMemo(() => createAppIntl(locale, messages), [locale, messages]);

  const setPreference = useCallback(
    (next: string) => {
      if (overridden) {
        if (import.meta.env.DEV) {
          console.warn(`[i18n] ignoring language "${next}": a dev override is active`);
        }
        return;
      }
      /* Written before the state update, not after, so the cache is correct
       * even if this render never commits. */
      writeCachedLanguage(next);
      setPreferenceState(next);
    },
    [overridden],
  );

  const control = useMemo<LocaleControl>(
    () => ({ locale, preference, overridden, setPreference }),
    [locale, preference, overridden, setPreference],
  );

  /* `key` on the provider is deliberate: switching language must re-mount the
   * subtree so that anything holding formatted text in state (a memo, a
   * `useState` initialiser) recomputes instead of showing the old language
   * until it happens to re-render for another reason. */
  return (
    <LocaleControlContext.Provider value={control}>
      <RawIntlProvider value={intl} key={locale}>
        {children}
      </RawIntlProvider>
    </LocaleControlContext.Provider>
  );
}

function navigatorLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

export { DEFAULT_LOCALE, isSupportedLocale, resolveLocale };
export {
  LOCALES,
  LOCALE_CODES,
  PSEUDO_LOCALE,
  SHIPPED_LOCALES,
  SHIPPED_LOCALE_CODES,
  localeEntry,
  type LocaleEntry,
} from './locales';
