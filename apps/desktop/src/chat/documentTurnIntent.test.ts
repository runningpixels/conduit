import { describe, expect, it } from 'vitest';
import {
  classifyDocumentTurnIntent,
  informationalDeveloperPromptFor,
  looksLikeArtifactEditFollowUp,
  looksLikeInformationalQuestion,
} from './documentTurnIntent';

describe('looksLikeInformationalQuestion', () => {
  it('detects capability and explanatory questions', () => {
    expect(looksLikeInformationalQuestion('what types of documents can you create?')).toBe(true);
    expect(looksLikeInformationalQuestion('how do exports work?')).toBe(true);
    expect(looksLikeInformationalQuestion('can you edit markdown?')).toBe(true);
    expect(looksLikeInformationalQuestion('tell me about artifacts')).toBe(true);
  });

  it('does not flag explicit edit requests', () => {
    expect(looksLikeInformationalQuestion('can you update the header?')).toBe(false);
    expect(looksLikeInformationalQuestion('make it dark mode')).toBe(false);
    expect(looksLikeInformationalQuestion('can you add urls to the document?')).toBe(false);
  });

  it('does not flag explicit creation requests', () => {
    expect(looksLikeInformationalQuestion('create a new html artifact')).toBe(false);
  });
});

describe('looksLikeArtifactEditFollowUp', () => {
  it('does not flag capability questions about document types', () => {
    expect(looksLikeArtifactEditFollowUp('can you edit markdown?')).toBe(false);
  });

  it('treats polite revision asks as edit follow-ups', () => {
    expect(looksLikeArtifactEditFollowUp('can you add urls to the document?')).toBe(true);
    expect(looksLikeArtifactEditFollowUp('can you update the header?')).toBe(true);
    expect(looksLikeArtifactEditFollowUp('could you remove the footer?')).toBe(true);
  });
});

describe('classifyDocumentTurnIntent', () => {
  it('classifies creation, edit, info, and general turns', () => {
    expect(classifyDocumentTurnIntent('create a new html artifact')).toBe('create');
    expect(classifyDocumentTurnIntent('make it dark mode')).toBe('edit');
    expect(classifyDocumentTurnIntent('can you add urls to the document?')).toBe('edit');
    expect(classifyDocumentTurnIntent('what types of documents can you create?')).toBe('info');
    expect(classifyDocumentTurnIntent('hello')).toBe('general');
  });

  it('reads imperative revisions of a page as edits', () => {
    // The follow-up that produced a second page instead of fixing the first.
    expect(
      classifyDocumentTurnIntent(
        'Two fixes: clear the error banner as soon as a refresh succeeds, and give the request 30 seconds before timing out. Also, when the page is wider than 900px, put the three stat cards in one row.',
      ),
    ).toBe('edit');
    expect(classifyDocumentTurnIntent('shorten the intro and center the header')).toBe('edit');
    // Code verbs stay out, so workspace edits keep their write tools.
    expect(classifyDocumentTurnIntent('rename the helper in utils')).toBe('general');
  });

  it('reads a one-page build request as a creation, even when it also says add', () => {
    expect(
      classifyDocumentTurnIntent(
        'Then build a one-page "Ferry upgrade plan" with a table per crate. Add a two-sentence recommendation under the table.',
      ),
    ).toBe('create');
  });
});

describe('informationalDeveloperPromptFor', () => {
  it('returns guidance for informational questions only', () => {
    expect(informationalDeveloperPromptFor('what can you create?')).toContain('text only');
    expect(informationalDeveloperPromptFor('make it dark mode')).toBeUndefined();
  });
});
