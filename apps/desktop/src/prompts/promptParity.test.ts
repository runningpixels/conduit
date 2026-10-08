import { describe, expect, it } from 'vitest';
import { draftSystemAppendix, draftDeveloperPrompt } from '../chat/draftPrompt';
import { appName } from '../brand';
import type { DeckDetail, DraftDetail } from '../ipc/contracts';
import { deckDeveloperPrompt, deckSystemAppendix } from '../slides/deckPrompt';
import { THEME_CONTRACT } from '../slides/themes';
import fixtureJson from './parity-fixture.json';
import { fillTemplate, promptText } from './shared';

/**
 * The Rust workflow runner builds the same prompts (`document_prompts.rs`) and
 * checks the same fixture, so a scheduled deck or draft update gives the model
 * exactly what a chat does.
 */
interface Fixture {
  themeContract: string;
  deckSystem: string;
  draftSystem: { none: string; web: string; documents: string; both: string };
  decks: { deck: DeckDetail; layoutNotes: Record<string, string>; expected: string }[];
  drafts: { draft: DraftDetail; expected: string }[];
}
const fixture = fixtureJson as unknown as Fixture;
const withApp = (text: string) => text.split('{app}').join(appName());

describe('prompt parity fixture', () => {
  it('has the system prompts the shared files produce', () => {
    expect(THEME_CONTRACT).toBe(withApp(fixture.themeContract));
    expect(deckSystemAppendix()).toBe(withApp(fixture.deckSystem));
    expect(draftSystemAppendix({})).toBe(withApp(fixture.draftSystem.none));
    expect(draftSystemAppendix({ webSearch: true })).toBe(withApp(fixture.draftSystem.web));
    expect(draftSystemAppendix({ documents: true })).toBe(withApp(fixture.draftSystem.documents));
    expect(draftSystemAppendix({ webSearch: true, documents: true })).toBe(withApp(fixture.draftSystem.both));
  });

  it('has the developer prompts the renderer builds', () => {
    expect(fixture.decks.length).toBeGreaterThanOrEqual(3);
    for (const { deck, layoutNotes, expected } of fixture.decks) {
      expect(deckDeveloperPrompt(deck, layoutNotes)).toBe(expected);
    }
    expect(fixture.drafts.length).toBeGreaterThanOrEqual(3);
    for (const { draft, expected } of fixture.drafts) {
      expect(draftDeveloperPrompt(draft, null)).toBe(expected);
    }
  });
});

describe('fillTemplate', () => {
  it('fills the app name, drops empty sections and keeps the others in place', () => {
    const template = 'Hello {app}.\n\n{a}\n\n{b}\n\nBye\n';
    expect(fillTemplate(template, 'X', { a: 'A text', b: null })).toBe('Hello X.\n\nA text\n\nBye');
    expect(fillTemplate(template, 'X', {})).toBe('Hello X.\n\nBye');
  });

  it('reads files with Windows line ends the same as Unix ones', () => {
    expect(promptText('a\r\n\r\nb\r\n')).toBe('a\n\nb');
  });
});
