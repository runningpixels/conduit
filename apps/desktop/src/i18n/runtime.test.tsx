import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_BRAND, resetBrand, setBrand } from '../brand';
import {
  EN_MESSAGES,
  I18nProvider,
  TRANSLATED_LOCALE_CODES,
  bootstrapI18n,
  createAppIntl,
  loadMessages,
  readCachedLanguage,
  translate,
  useLocale,
  useT,
  writeCachedLanguage,
} from './index';
import { SHIPPED_LOCALE_CODES } from './locales';
import deMessages from './messages/de.json';

/// The four properties everything else in the project is built on:
/// English fallback (D5), automatic `{appName}` (D8), plural correctness (D2),
/// and — the one that decides whether extraction costs tens of test edits or
/// hundreds — `useT()` working with no provider above it (D18).

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  resetBrand();
});

function Probe({ id, values }: { id: string; values?: Record<string, string | number> }) {
  const t = useT();
  return <p data-testid="out">{t(id, values)}</p>;
}

describe('English fallback (D5)', () => {
  it('renders the English string when the locale is missing the key', () => {
    // A half-translated catalog is the normal state mid-wave, so this is the
    // common path, not an edge case.
    const partial = createAppIntl('de', { 'onboarding.actions.continue': 'Weiter' });
    expect(translate(partial, 'onboarding.actions.continue')).toBe('Weiter');
    expect(translate(partial, 'onboarding.actions.back')).toBe(EN_MESSAGES['onboarding.actions.back']);
  });

  it('renders the English string when the translation is malformed ICU', () => {
    // An unbalanced brace would otherwise throw or render the raw key into
    // the middle of a dialog.
    const broken = createAppIntl('de', { 'onboarding.actions.back': 'Zur{ück' });
    expect(translate(broken, 'onboarding.actions.back')).toBe('Back');
  });

  it('never renders a bare key to the user', () => {
    const intl = createAppIntl('de', deMessages as Record<string, string>);
    for (const id of Object.keys(EN_MESSAGES)) {
      // Placeholders are left unsupplied on purpose: react-intl renders them
      // as empty rather than throwing, and what matters here is that no output
      // is the key itself.
      expect(translate(intl, id), `${id} rendered as its own key`).not.toBe(id);
    }
  });
});

describe('product name injection (D8)', () => {
  it('supplies {appName} without the call site passing it', () => {
    render(<Probe id="onboarding.welcome.title" />);
    expect(screen.getByTestId('out')).toHaveTextContent(`Welcome to ${DEFAULT_BRAND.appName}`);
  });

  it('follows a runtime rebrand, in every locale', () => {
    // The white-label case this exists for: a reseller build must not have to
    // ship seven re-translated catalogs to change one word.
    setBrand({ appName: 'Northwind' });
    const intl = createAppIntl('de', deMessages as Record<string, string>);
    expect(translate(intl, 'onboarding.welcome.title')).toBe('Willkommen bei Northwind');
  });
});

describe('plurals (D2)', () => {
  it('picks the right English arm', () => {
    const intl = createAppIntl('en', EN_MESSAGES);
    expect(translate(intl, 'recovery.discardBackup.deleted', { count: 1, freed: '4.2 KB' })).toBe(
      'Deleted 1 backup file, freeing 4.2 KB.',
    );
    expect(translate(intl, 'recovery.discardBackup.deleted', { count: 3, freed: '4.2 KB' })).toBe(
      'Deleted 3 backup files, freeing 4.2 KB.',
    );
  });

  it('picks the right German arm', () => {
    // The string this replaced was `${n} backup file(s)` — English-only, and
    // wrong in every language including English.
    const intl = createAppIntl('de', deMessages as Record<string, string>);
    expect(translate(intl, 'recovery.discardBackup.deleted', { count: 1, freed: '4,2 KB' })).toBe(
      '1 Backup-Datei gelöscht, 4,2 KB freigegeben.',
    );
    expect(translate(intl, 'recovery.discardBackup.deleted', { count: 3, freed: '4,2 KB' })).toBe(
      '3 Backup-Dateien gelöscht, 4,2 KB freigegeben.',
    );
  });
});

describe('no provider required (D18)', () => {
  it('renders English from a component with nothing above it', () => {
    // This is what lets ~90 existing test files keep calling bare
    // `render(<Thing />)` after their components are converted. `useIntl()`
    // would throw here.
    render(<Probe id="onboarding.provider.stepTitle" />);
    expect(screen.getByTestId('out')).toHaveTextContent('Choose a provider and bring your key');
  });

  it('reports English and an inert setter from useLocale', () => {
    function LocaleProbe() {
      const { locale, preference } = useLocale();
      return <span data-testid="loc">{`${locale}/${preference}`}</span>;
    }
    render(<LocaleProbe />);
    expect(screen.getByTestId('loc')).toHaveTextContent('en/en');
  });
});

describe('I18nProvider', () => {
  it('loads a catalog and renders it', async () => {
    render(
      <I18nProvider initialPreference="de">
        <Probe id="onboarding.actions.back" />
      </I18nProvider>,
    );
    // One English frame first — the catalog is a dynamic import. Phase 1
    // removes it by resolving the locale before first paint.
    await waitFor(() => expect(screen.getByTestId('out')).toHaveTextContent('Zurück'));
  });

  it('exposes the resolved locale alongside the raw preference', async () => {
    function LocaleProbe() {
      const { locale, preference } = useLocale();
      return <span data-testid="loc">{`${locale}/${preference}`}</span>;
    }
    render(
      <I18nProvider initialPreference="de-AT">
        <LocaleProbe />
      </I18nProvider>,
    );
    // Resolution collapsed the region; the preference is reported unchanged so
    // a settings picker can show what the user actually chose.
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('de/de-AT'));
  });

  it('moves html[lang] to the resolved locale', async () => {
    /* `index.html` hard-codes `lang="en"`. Left there, a screen reader reads
     * German with an English voice — the one i18n defect a sighted reviewer
     * cannot see — and the font fallback engine loses the only signal that
     * separates Japanese kanji from Simplified Chinese at the same code point
     * (D17).
     *
     * Asserted on the resolved locale, not the preference: `de-AT` resolves to
     * the `de` catalog, and claiming `de-AT` would describe text that is not
     * Austrian. */
    render(
      <I18nProvider initialPreference="de-AT">
        <Probe id="onboarding.actions.back" />
      </I18nProvider>,
    );
    await waitFor(() => expect(document.documentElement.lang).toBe('de'));
    expect(document.documentElement.dir).toBe('ltr');
  });
});

describe('loadMessages', () => {
  it('returns English for English without a round trip', async () => {
    await expect(loadMessages('en')).resolves.toBe(EN_MESSAGES);
  });

  it('returns English for a listed locale whose catalog has not landed yet', async () => {
    /* This used to name `ko`, which was in the locale table from day one and
     * had no catalog until wave 3 shipped one. Every locale in the table now
     * has a catalog — the correct end state, and the reason this assertion had
     * to be rewritten rather than repointed at the next victim.
     *
     * The behaviour is still worth holding: the table is allowed to list a
     * locale before its catalog lands (D1), and D5 says that renders English
     * rather than raw keys. What the branch actually keys on is a missing
     * catalog, not a missing translation, so exercise it with a code the glob
     * has nothing for. */
    const listed = SHIPPED_LOCALE_CODES.filter((code) => !TRANSLATED_LOCALE_CODES.includes(code));
    for (const code of listed) {
      await expect(loadMessages(code)).resolves.toBe(EN_MESSAGES);
    }
    await expect(loadMessages('xx')).resolves.toBe(EN_MESSAGES);
  });

  it('loads a catalog that does exist', async () => {
    const de = await loadMessages('de');
    expect(de['onboarding.actions.back']).toBe('Zurück');
  });
});

describe('language cache', () => {
  it('reports "system" when nothing has been stored', () => {
    expect(readCachedLanguage()).toBe('system');
  });

  it('round-trips a preference', () => {
    writeCachedLanguage('de');
    expect(readCachedLanguage()).toBe('de');
  });
});

describe('bootstrapI18n', () => {
  it('resolves English and its catalog with no stored preference', async () => {
    const boot = await bootstrapI18n();
    expect(boot.preference).toBe('system');
    expect(boot.locale).toBe('en');
    expect(boot.messages).toBe(EN_MESSAGES);
  });

  it('loads the cached language before anything renders', async () => {
    // The point of the whole exercise: the catalog is in hand at boot, so the
    // first frame is German rather than the second.
    writeCachedLanguage('de');
    const boot = await bootstrapI18n();
    expect(boot.preference).toBe('de');
    expect(boot.locale).toBe('de');
    expect(boot.messages['onboarding.actions.back']).toBe('Zurück');
  });

  it('lets a dev override outrank the cache', async () => {
    writeCachedLanguage('de');
    const boot = await bootstrapI18n('en-XA');
    expect(boot.locale).toBe('en-XA');
  });

  it('ignores a "system" override and keeps using the cache', async () => {
    // `bootstrapI18n` is handed `undefined` for "no override"; `'system'` on
    // its own must not silently wipe a stored choice.
    writeCachedLanguage('de');
    expect((await bootstrapI18n('system')).locale).toBe('de');
  });
});

function LocaleSwitcher() {
  const { locale, overridden, setPreference } = useLocale();
  return (
    <div>
      <span data-testid="loc">{locale}</span>
      <span data-testid="overridden">{String(overridden)}</span>
      <button type="button" onClick={() => setPreference('de')}>
        switch
      </button>
    </div>
  );
}

describe('changing language at runtime', () => {
  it('switches locale and mirrors the choice into the cache', async () => {
    render(
      <I18nProvider>
        <LocaleSwitcher />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'switch' }));

    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('de'));
    // Written so the *next* launch paints German on its first frame.
    expect(readCachedLanguage()).toBe('de');
  });

  it('moves html[lang] with the switch, not just on mount', async () => {
    // A stale `lang` is worse than none: it asserts a language the text is not
    // in, and everything downstream — screen reader voice, font fallback,
    // line breaking — believes it.
    document.documentElement.lang = 'en';
    render(
      <I18nProvider>
        <LocaleSwitcher />
      </I18nProvider>,
    );
    expect(document.documentElement.lang).toBe('en');

    fireEvent.click(screen.getByRole('button', { name: 'switch' }));
    await waitFor(() => expect(document.documentElement.lang).toBe('de'));
  });

  it('refuses to change language while a dev override is pinned', () => {
    // App reconciles `AppSettings.language` into the provider on boot. Without
    // this guard that reconcile would immediately undo `?locale=en-XA`, and
    // the pseudo-locale would be unreachable — it has no setting to persist to.
    render(
      <I18nProvider initialPreference="en-XA" overridden>
        <LocaleSwitcher />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'switch' }));

    expect(screen.getByTestId('loc')).toHaveTextContent('en-XA');
    expect(screen.getByTestId('overridden')).toHaveTextContent('true');
    expect(readCachedLanguage()).toBe('system');
  });
});
