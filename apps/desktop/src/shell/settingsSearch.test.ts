import { describe, expect, it } from 'vitest';
import deMessages from '../i18n/messages/de.json';
import { createAppIntl, EN_MESSAGES, type Translate } from '../i18n';
import {
  foldForSearch,
  PREFIX_SECTIONS,
  searchSettings,
  SETTINGS_SEARCH_ENTRIES,
  UNSECTIONED_PREFIXES,
} from './settingsSearch';
import type { SettingsSection } from './SettingsSheet';

const SECTIONS: { id: SettingsSection; labelId: string }[] = [
  'providers', 'chat', 'web-search', 'workspace', 'connectors', 'prompts',
  'skills', 'memory', 'appearance', 'branding', 'privacy', 'about',
].map((id) => ({ id: id as SettingsSection, labelId: `shell.settingsSheet.nav.${id}` }));

function translator(locale: string, messages: Record<string, string>): Translate {
  const intl = createAppIntl(locale, messages);
  return (id, values) => intl.formatMessage({ id, defaultMessage: EN_MESSAGES[id] }, values) as string;
}

const tEn = translator('en', EN_MESSAGES);

describe('the settings search index', () => {
  /**
   * A settings area added to the catalog without a section here would be
   * unsearchable, silently — nothing else notices. Every `settings.<area>` and
   * every `shell.settingsSheet.<section>` block must be claimed.
   */
  it('assigns every settings area in the catalog to a section', () => {
    const areas = new Set(
      Object.keys(EN_MESSAGES)
        .filter((key) => key.startsWith('settings.') || key.startsWith('shell.settingsSheet.'))
        .map((key) => {
          const parts = key.split('.');
          return key.startsWith('settings.') ? `${parts[0]}.${parts[1]}.` : `${parts[0]}.${parts[1]}.${parts[2]}.`;
        }),
    );
    const chrome = ['shell.settingsSheet.nav.', 'shell.settingsSheet.search.'];
    const unclaimed = [...areas].filter(
      (area) =>
        !chrome.includes(area) &&
        !area.startsWith('shell.settingsSheet.ariaLabel') &&
        !area.startsWith('shell.settingsSheet.footnote') &&
        !UNSECTIONED_PREFIXES.includes(area) &&
        !PREFIX_SECTIONS.some(([prefix]) => prefix === area),
    );
    expect(unclaimed).toEqual([]);
  });

  it('indexes names, not prose or dialog chrome', () => {
    const keys = SETTINGS_SEARCH_ENTRIES.map((entry) => entry.key);
    expect(keys).toContain('settings.privacy.keychainMode.label');
    expect(keys).toContain('settings.appearance.density.label');
    expect(keys.some((key) => /AriaLabel$|Dialog\.|\.intro$|\.help$/.test(key))).toBe(false);
  });

  it('finds a setting by its name, in its section', () => {
    const found = searchSettings('keychain', tEn, SECTIONS);
    expect([...found.keys()]).toEqual(['privacy']);
    expect(found.get('privacy')).toContain('Keychain mode');
  });

  it('matches a section on its own nav label', () => {
    expect([...searchSettings('memory', tEn, SECTIONS).keys()]).toContain('memory');
  });

  it('ignores case and accents', () => {
    expect(foldForSearch('Élément ACCENTUÉ')).toBe('element accentue');
    expect([...searchSettings('DENSITY', tEn, SECTIONS).keys()]).toEqual(['appearance']);
  });

  /**
   * Theming Phase 2 added the theme picker, the look/palette Advanced
   * disclosure, and a "dark only" badge — each has to be findable by the word
   * a reader would actually type, not only by the catalog key it happens to
   * live under.
   */
  it.each(['theme', 'look', 'palette', 'dark only', 'reading font'])(
    'finds the appearance section for "%s"',
    (query) => {
      expect([...searchSettings(query, tEn, SECTIONS).keys()]).toContain('appearance');
    },
  );

  it('searches the reader’s language', () => {
    const tDe = translator('de', deMessages as Record<string, string>);
    expect([...searchSettings('erscheinungsbild', tDe, SECTIONS).keys()]).toContain('appearance');
  });

  it('returns nothing for a blank query', () => {
    expect(searchSettings('   ', tEn, SECTIONS).size).toBe(0);
  });
});
