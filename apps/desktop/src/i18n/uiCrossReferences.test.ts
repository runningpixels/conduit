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

const en = enMessages as Catalog;

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
  /* The command palette entry that opens the chip. It briefly read "Settings
   * for this chat", which matched its siblings ("Archive this chat") and broke
   * the one thing a palette is for: typing the name on the chip stopped
   * finding it. Registered so the two names stay one name. */
  { prose: 'workspace.commandPalette.command.chatSettings', names: 'chat.composer.chatSettings.ariaLabel' },
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

  /* The `error.validation.*` twins. Each named its field by a name the field
   * does not have — "Wall-clock budget" for a control labelled "Turn time
   * limit", "Max steps" for "Max agent steps", "Instructions" for "User
   * instructions" — which is "Provider & Model" again, surviving only because
   * the status twin was registered and the validation twin was not. Found by
   * the Japanese lead while deciding terminology, before a line was
   * translated. */
  { prose: 'error.validation.agentMaxStepsRange', names: 'settings.agent.maxSteps.label' },
  { prose: 'error.validation.userInstructionsLength', names: 'chat.generation.userInstructions.label' },
  { prose: 'settings.diagnostics.actions.exportDisabledTitle', names: 'shell.settingsSheet.nav.privacy' },
  { prose: 'settings.diagnostics.disabledHint', names: 'shell.settingsSheet.nav.privacy' },
  { prose: 'settings.privacy.header', names: 'shell.settingsSheet.nav.privacy' },
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
  // English
  'a', 'an', 'and', 'or', 'the', 'of', 'in', 'on', 'to', 'for', 'under', 'with', 'from',
  // German
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'und', 'im', 'unter', 'zum', 'zur',
  // Spanish
  'el', 'la', 'los', 'las', 'un', 'una', 'del', 'de', 'y', 'e', 'en', 'al', 'con', 'para', 'por',
  // French
  'le', 'les', 'du', 'et', 'une', 'aux', 'au', 'dans', 'des', 'avec', 'pour', 'par',
  /* Portuguese. Every one of these is a preposition fused with an article, and
   * that fusion is the whole problem: a chip labelled "Configurações do chat"
   * keeps `do` as a content word, so the correct sentence "Configurações
   * salvas somente para este chat." was reported as missing it. The guard
   * would have failed good Portuguese on three of its eleven labels before a
   * line was translated — found by the pt-BR lead reading the guard rather
   * than by running it. */
  'do', 'da', 'dos', 'das', 'no', 'na', 'nos', 'nas', 'ao', 'aos', 'à', 'às',
  'pelo', 'pela', 'pelos', 'pelas', 'num', 'numa', 'os', 'as', 'uma', 'sob',
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

/* Kana, CJK ideographs and Hangul. */
const SCRIPT_WITHOUT_SPACES = /[぀-ヿ㐀-䶿一-鿿가-힯ｦ-ﾟ]/;

/**
 * The content-word check above cannot see these scripts at all.
 *
 * `contentWords` accumulates runs of `a-z0-9`, so a Japanese label folds to an
 * empty word list, `missing` is empty by construction, and every pair passes.
 * The guard was not lenient for ja/ko/zh — it was inert, which is worse than
 * absent, because the suite reports it green.
 *
 * These languages need a different primitive rather than a different word list:
 * they have no spaces to tokenise on, so the label is compared as a
 * **subsequence** of the sentence, over significant characters only. That
 * tolerates exactly what a translator legitimately does — inserting a particle,
 * so that a chip labelled チャット設定 may be pointed at as チャットの設定 — while
 * still failing when the sentence uses a different word.
 */
function significantChars(value: string): string[] {
  return Array.from(value.toLowerCase()).filter((char) => /[\p{L}\p{N}]/u.test(char));
}

function containsSubsequence(sentence: string, label: string): boolean {
  const needle = significantChars(label);
  if (needle.length === 0) return true;
  let at = 0;
  for (const char of significantChars(sentence)) {
    if (char === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return false;
}

/**
 * Elements the copy points at by name, but which carry no label of their own.
 *
 * G12 below compares a sentence against the label of the thing it names. That
 * only works when the thing *has* a label. The composer has none — it is a
 * region, and the one place it is named to the user is a visually-hidden skip
 * link. Registering that link as a G12 target does not work either: its text
 * is "Skip to composer", so every sentence merely mentioning the composer
 * would be required to contain "skip", and correct translations would fail.
 *
 * So these are pinned the other way round — by naming the word each locale
 * settled on. That is the glossary in executable form, and it is deliberately
 * a hard-coded table: a new locale has to add a row, which is the point. The
 * alternative, inferring the rendering from the catalog, can only discover
 * what is already there and would bless a split rather than catch it.
 *
 * Both entries were settled by hand after the same defect appeared twice.
 * English called the composer "the composer" in seven strings and "the chat
 * bar" in three; underneath that, German had three names for it, French five,
 * Spanish five. Every locale independently rejected the obvious calque —
 * `Composer` reads as *Komponist*, and *compositor* / *compositeur* are the
 * people who write music.
 */
const ELEMENT_NAMES: ReadonlyArray<{
  element: string;
  /** Matches the English values that name this element. */
  english: RegExp;
  /** The one rendering per locale. English is the key it was settled from. */
  renderings: Readonly<Record<string, string>>;
  /** Names that lost, and must not come back. */
  rejected: readonly string[];
}> = [
  {
    element: 'composer',
    english: /composer/i,
    renderings: {
      en: 'composer',
      de: 'Eingabebereich',
      es: 'campo de mensaje',
      fr: 'zone de saisie',
    },
    /* Scanned across the whole catalog, so this list may hold only names that
     * are wrong *everywhere*. The generic field words are deliberately absent
     * — `Eingabefeld`, `champ de saisie`, `campo de entrada`, `入力欄` are the
     * correct words for an ordinary text input, of which this app has many.
     * Listing them would fail a correct translation somewhere else in the
     * catalog, which is the failure mode that gets a guard deleted. Using one
     * of them *as the composer's name* is still caught, by the check above.
     *
     * The Japanese lead spotted this while deciding their own reject list, and
     * it was already live in the German and French rows. */
    rejected: [
      'Composer', // German: reads as Komponist
      'compositor', // Spanish: writes music
      'compositeur', // French: writes music
      'コンポーザー', // Japanese: also a music composer — the fourth locale to reject the calque
      'Chat-Leiste', // calque of English's own abandoned second name
      'barre de saisie',
      'チャットバー',
      'cuadro de mensaje', // Spanish for a modal MessageBox
      'zone de message', // reads as the transcript, the opposite element
    ],
  },
  {
    element: 'sidebar',
    english: /sidebar/i,
    renderings: {
      en: 'Sidebar',
      de: 'Seitenleiste',
      es: 'barra lateral',
      fr: 'barre latérale',
    },
    rejected: [],
  },
];

describe('the CJK matcher itself', () => {
  /* Tested directly rather than through a catalog, because no CJK catalog
   * exists yet. Wiring a matcher for ja/ko/zh and shipping it unexercised
   * until wave 2 lands would repeat the mistake it was written to fix: a check
   * that reports green without ever having run. */

  it('accepts a label the sentence carries verbatim', () => {
    expect(containsSubsequence('チャット設定を保存しました', 'チャット設定')).toBe(true);
  });

  it('accepts a particle inserted inside the label', () => {
    // A translator writing チャットの設定 for a chip labelled チャット設定 has
    // pointed at the right element, and must not be reported.
    expect(containsSubsequence('チャットの設定を保存しました', 'チャット設定')).toBe(true);
  });

  it('rejects a sentence that uses a different word', () => {
    // 会話 rather than チャット — the drift this whole file exists to catch.
    expect(containsSubsequence('会話の設定を保存しました', 'チャット設定')).toBe(false);
  });

  it('works for Hangul, which has spaces but no Latin letters', () => {
    expect(containsSubsequence('채팅 설정이 저장되었습니다', '채팅 설정')).toBe(true);
    expect(containsSubsequence('대화 설정이 저장되었습니다', '채팅 설정')).toBe(false);
  });

  it('ignores punctuation and spacing differences', () => {
    expect(containsSubsequence('「チャット設定」を保存しました。', 'チャット設定')).toBe(true);
  });

  it('is not vacuous the way the content-word check was', () => {
    /* The bug that prompted this: `contentWords` accumulates runs of a-z0-9,
     * so every CJK label folded to nothing and every pair passed. */
    expect(contentWords('チャット設定')).toEqual([]);
    expect(containsSubsequence('まったく別の文', 'チャット設定')).toBe(false);
  });

  it('routes CJK labels away from the content-word path', () => {
    expect(SCRIPT_WITHOUT_SPACES.test('チャット設定')).toBe(true);
    expect(SCRIPT_WITHOUT_SPACES.test('채팅 설정')).toBe(true);
    expect(SCRIPT_WITHOUT_SPACES.test('简体中文')).toBe(true);
    expect(SCRIPT_WITHOUT_SPACES.test('Chat settings')).toBe(false);
    expect(SCRIPT_WITHOUT_SPACES.test('Paramètres de la conversation')).toBe(false);
  });
});

describe('element names (G13)', () => {
  for (const { element, english, renderings, rejected } of ELEMENT_NAMES) {
    const named = Object.keys(en).filter((key) => english.test(en[key]));

    it(`${element}: English names it in at least one string`, () => {
      // Guards the guard. A regex that stops matching would make every
      // assertion below vacuously true.
      expect(named.length).toBeGreaterThan(0);
    });

    for (const [locale, catalog] of CATALOGS) {
      it(`${element}: ${locale} uses one name for it`, () => {
        const expected = renderings[locale];
        /* A locale with no row is the failure, not an exemption: it means a
         * wave-2 translator picked a word and nothing recorded which. */
        expect(expected, `no ${element} rendering recorded for ${locale}`).toBeDefined();

        const wrong = named.filter((key) => {
          const value = catalog[key];
          if (typeof value !== 'string') return false;
          /* Same split as G12, for the same reason: a plain substring check
           * fails a Japanese sentence that inserts a particle inside the name,
           * which is correct Japanese rather than a second name. */
          return SCRIPT_WITHOUT_SPACES.test(expected)
            ? !containsSubsequence(value, expected)
            : !value.toLowerCase().includes(expected.toLowerCase());
        });
        expect(wrong, `${locale} strings naming the ${element} some other way`).toEqual([]);
      });
    }

    if (rejected.length > 0) {
      it(`${element}: the names that lost stay gone`, () => {
        const survivors: string[] = [];
        for (const [locale, catalog] of CATALOGS) {
          for (const [key, value] of Object.entries(catalog)) {
            for (const name of rejected) {
              if (value.includes(name)) survivors.push(`${locale} ${key}: "${name}"`);
            }
          }
        }
        expect(survivors).toEqual([]);
      });
    }
  }
});

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

        if (SCRIPT_WITHOUT_SPACES.test(label)) {
          if (!containsSubsequence(sentence, label)) {
            broken.push(
              `${prose}\n    points at ${names} ("${label}")\n` +
                `    but says: "${sentence}"\n` +
                `    the label does not appear in it`,
            );
          }
          continue;
        }

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

    it(`${locale}: the comparison is actually capable of failing`, () => {
      /* Guard the guard. This check reported green for every CJK locale not
       * because the names agreed but because it could not see them: the
       * content-word tokeniser keeps `a-z0-9` runs, so a Japanese label folded
       * to an empty list and "nothing missing" was true by construction.
       *
       * Fixed above by routing those scripts to a subsequence match — but the
       * next script with no Latin letters would reintroduce it silently, and a
       * check that cannot fail is worse than one that is absent, because the
       * suite reports it as passing. So: assert that at least one comparison
       * per locale had something to compare. */
      const vacuous: string[] = [];
      let compared = 0;

      for (const { prose, names } of CROSS_REFERENCES) {
        const sentence = catalog[prose];
        const label = catalog[names];
        if (typeof sentence !== 'string' || typeof label !== 'string') continue;
        compared += 1;
        const empty = SCRIPT_WITHOUT_SPACES.test(label)
          ? significantChars(label).length === 0
          : contentWords(label).length === 0;
        if (empty) vacuous.push(`${names} ("${label}") yields nothing to match on`);
      }

      expect(compared).toBeGreaterThan(0);
      expect(vacuous).toEqual([]);
    });
  }
});
