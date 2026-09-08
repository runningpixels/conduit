import { describe, expect, it } from 'vitest';

import deMessages from './messages/de.json';
import enMessages from './messages/en.json';
import esMessages from './messages/es.json';
import frMessages from './messages/fr.json';

/**
 * Guard G12 — prose that names a UI element must name it the way it is labelled.
 *
 * Some strings tell the user where to go: "switch back to the OS keychain in
 * Privacy & data", "Check Providers & keys". The name in that sentence and the
 * name on the thing being pointed at are two separate catalog entries, and
 * nothing ties them together. They drift in two ways, and both were live here:
 *
 *  - **Across a translation.** French rendered the composer chip as
 *    "Paramètres du chat" and then told the user to look for a chip called
 *    "Réglages de la conversation" — two different words for one element,
 *    written by two people who never saw each other's slice.
 *  - **In English.** `settings.privacy.trust.noKey.detail` directed the user to
 *    a section called "Provider & Model". There has never been one; it is
 *    "Providers & keys". German, Spanish and French each faithfully translated
 *    the wrong name, which is exactly what good translators do.
 *
 * The check is deliberately loose. It compares content words after folding away
 * case, accents, punctuation and articles, and matches on a prefix so that
 * inflection ("clés" against "clé", "Schlüssel" against "Schlüsseln") passes.
 * A locale that legitimately rephrases — Spanish writes "chip de ajustes de
 * chat" for a chip labelled "Ajustes del chat" — is meant to pass. It errs
 * toward silence: a lint that fires on correct translations gets switched off.
 */

type Catalog = Record<string, string>;

const CATALOGS: ReadonlyArray<readonly [locale: string, catalog: Catalog]> = [
  ['en', enMessages as Catalog],
  ['de', deMessages as Catalog],
  ['es', esMessages as Catalog],
  ['fr', frMessages as Catalog],
];

/** Prose that points somewhere, and the key that owns the name it points at. */
const CROSS_REFERENCES: ReadonlyArray<{ prose: string; names: string }> = [
  { prose: 'settings.generationControls.intro', names: 'chat.composer.chatSettings.ariaLabel' },
  { prose: 'app.status.chatSettingsUnavailable', names: 'chat.composer.chatSettings.ariaLabel' },
  { prose: 'chat.view.status.chatSettingsSaved', names: 'chat.composer.chatSettings.ariaLabel' },
  { prose: 'error.credentials.fileKeyMissing', names: 'shell.settingsSheet.nav.privacy' },
  { prose: 'shell.settingsSheet.webSearch.intro', names: 'shell.settingsSheet.nav.privacy' },
  { prose: 'shell.settingsSheet.webSearch.intro', names: 'settings.privacy.localOnlyToggle.label' },
  { prose: 'chat.modelPicker.noProviders', names: 'shell.settingsSheet.nav.providers' },
  { prose: 'settings.privacy.trust.noKey.detail', names: 'shell.settingsSheet.nav.providers' },
  { prose: 'settings.privacy.trust.localOnlyLine', names: 'settings.privacy.localOnlyToggle.label' },
  { prose: 'settings.webSearch.consent.privacyNote', names: 'settings.privacy.localOnlyToggle.label' },
  /* `onboarding.finish.needCredential` is deliberately absent. It opens with
   * "Add a provider key…", which is an instruction that happens to share three
   * words with the "Add a provider" button rather than a reference to it, and
   * German proved the difference: "Füge einen Anbieter-Schlüssel hinzu" is a
   * correct translation of the instruction and would never contain the
   * button's name. A registry entry that fires on good translations is worse
   * than no entry. */
  { prose: 'settings.agent.status.maxStepsRange', names: 'settings.agent.maxSteps.label' },
  { prose: 'error.validation.webSearchAllowedDomainsCap', names: 'settings.webSearch.allowedDomains.heading' },
  { prose: 'error.validation.webSearchBlockedDomainsCap', names: 'settings.webSearch.blockedDomains.heading' },
  { prose: 'error.validation.stopSequenceLength', names: 'chat.generation.stopSequences.label' },
  { prose: 'chat.generation.userInstructions.hint', names: 'chat.generation.userInstructions.label' },
  { prose: 'settings.webSearch.consent.intro', names: 'settings.webSearch.sourceHeading' },
  { prose: 'settings.webSearch.intro', names: 'settings.webSearch.sourceHeading' },

  /* "Settings" is one common word, which is why these were nearly left out as
   * a coincidence. They are not: each sends the user to the settings sheet by
   * name, and Spanish titled that sheet "Configuración" while telling them
   * four separate times to go to "Ajustes". */
  { prose: 'chat.skills.manageInSettings', names: 'shell.settingsSheet.nav.title' },
  { prose: 'chat.composerSettings.defaultLead', names: 'shell.settingsSheet.nav.title' },
  { prose: 'chat.composerSettings.defaultsInSettings', names: 'shell.settingsSheet.nav.title' },
  { prose: 'chat.composer.workspace.defaultsInSettings', names: 'shell.settingsSheet.nav.title' },
  { prose: 'onboarding.connectors.hint', names: 'shell.settingsSheet.nav.title' },
  { prose: 'onboarding.finish.diagnosticsHint', names: 'shell.settingsSheet.nav.title' },
];

/**
 * Articles, conjunctions and prepositions across the four locales.
 *
 * Dropped because they are exactly what a translator rearranges: Spanish turns
 * "Ajustes del chat" into "ajustes de chat" inside a sentence, and French
 * moves between "&" and "et" freely. None of that changes which element the
 * user is being sent to.
 */
const FUNCTION_WORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'of', 'in', 'on', 'to', 'for', 'under',
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'und', 'im', 'unter', 'zum', 'zur',
  'el', 'la', 'los', 'las', 'un', 'una', 'del', 'de', 'y', 'e', 'en',
  'le', 'les', 'du', 'et', 'une', 'aux', 'au', 'dans',
]);

/** Case-folded, accent-stripped, punctuation-free content words. */
function contentWords(value: string): string[] {
  const folded = value
    .normalize('NFD')
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code < 0x300 || code > 0x36f; // drop combining marks
    })
    .join('')
    .toLowerCase();

  const words: string[] = [];
  let current = '';
  for (const char of folded) {
    const isWord = (char >= 'a' && char <= 'z') || (char >= '0' && char <= '9');
    if (isWord) {
      current += char;
    } else {
      if (current) words.push(current);
      current = '';
    }
  }
  if (current) words.push(current);
  return words.filter((word) => word.length > 1 && !FUNCTION_WORDS.has(word));
}

/** Prefix match, so plurals and case endings do not count as a rename. */
function appearsIn(word: string, haystack: readonly string[]): boolean {
  const stem = word.slice(0, Math.min(6, word.length));
  return haystack.some((candidate) => candidate.startsWith(stem));
}

describe('UI cross-references (G12)', () => {
  for (const [locale, catalog] of CATALOGS) {
    it(`${locale}: names every element the way that element is labelled`, () => {
      const broken: string[] = [];

      for (const { prose, names } of CROSS_REFERENCES) {
        const sentence = catalog[prose];
        const label = catalog[names];
        /* Parity is catalogs.test.ts's job; an absent key is not this test's
         * failure to report, and reporting it twice buries the real signal. */
        if (typeof sentence !== 'string' || typeof label !== 'string') continue;

        const inSentence = contentWords(sentence);
        const missing = contentWords(label).filter((word) => !appearsIn(word, inSentence));
        if (missing.length > 0) {
          broken.push(
            `${prose}\n    points at ${names} ("${label}")\n` +
              `    but says: "${sentence}"\n` +
              `    missing from the sentence: ${missing.join(', ')}`,
          );
        }
      }

      expect(broken).toEqual([]);
    });
  }
});
