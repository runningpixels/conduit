/**
 * The developer language override.
 *
 * The user-facing control is `AppSettings.language` and the picker in
 * Settings → Appearance. This is a separate, narrower thing that sits *above*
 * it, and it exists for one reason the settings path cannot cover: the
 * pseudo-locale.
 *
 * `en-XA` is generated, not translated, and has no `LanguageSetting` variant
 * to persist into — deliberately, because it must never be reachable by a
 * user. So the only way to run the app in it is an override that outranks the
 * persisted setting and is never written back to it. That is what this is.
 * It doubles as a fast way to eyeball a real locale without changing a stored
 * preference.
 *
 * Dev-only, and not on a trust boundary: `import.meta.env.DEV` is a Vite
 * `define`, so in a production build everything below is dead code the
 * minifier drops. A packaged app cannot reach it.
 *
 * Usage:
 *   ?locale=en-XA     pin the pseudo-locale (persists until cleared)
 *   ?locale=          clear the override, fall back to the real setting
 *   __setLocale('de') from the console; stores and reloads
 */

import { DEFAULT_LOCALE, isSupportedLocale } from './locales';

const DEV_LOCALE_KEY = 'conduit:v1-dev-locale';

/**
 * The override, or `null` when there is none.
 *
 * `null` rather than `'system'` so `bootstrapI18n` can tell "no override" from
 * "overridden to follow the OS" — the latter is a real choice a developer can
 * make to check what a system-language launch looks like.
 */
export function readDevLocalePreference(): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    const url = new URLSearchParams(window.location.search);
    if (url.has('locale')) {
      const raw = url.get('locale') ?? '';
      if (!raw) {
        window.localStorage.removeItem(DEV_LOCALE_KEY);
        return null;
      }
      const next = normalise(raw);
      window.localStorage.setItem(DEV_LOCALE_KEY, next);
      return next;
    }
    return window.localStorage.getItem(DEV_LOCALE_KEY);
  } catch {
    // Private mode, a blocked storage partition, or no window at all.
    return null;
  }
}

function normalise(value: string): string {
  if (value === 'system' || isSupportedLocale(value)) return value;
  console.warn(`[i18n] ignoring unknown dev locale "${value}"`);
  return DEFAULT_LOCALE;
}

/**
 * Expose `__setLocale('en-XA')` on the console, which stores the choice and
 * reloads. A reload rather than a live swap because this is a debug affordance
 * and a reload is the one path guaranteed to exercise the same startup
 * sequence a real user gets — including the pre-paint catalog load, which is
 * the part most worth being able to look at.
 */
export function installDevLocaleSwitch(): void {
  if (!import.meta.env.DEV) return;
  try {
    (window as unknown as Record<string, unknown>).__setLocale = (next: string) => {
      if (next) window.localStorage.setItem(DEV_LOCALE_KEY, normalise(next));
      else window.localStorage.removeItem(DEV_LOCALE_KEY);
      window.location.reload();
    };
  } catch {
    // Nothing to install onto. Not worth reporting.
  }
}
