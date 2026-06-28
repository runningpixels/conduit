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
  });

  it('does not flag explicit creation requests', () => {
    expect(looksLikeInformationalQuestion('create a new html artifact')).toBe(false);
  });
});

describe('looksLikeArtifactEditFollowUp', () => {
  it('does not flag capability questions about document types', () => {
    expect(looksLikeArtifactEditFollowUp('can you edit markdown?')).toBe(false);
  });
});

describe('classifyDocumentTurnIntent', () => {
  it('classifies creation, edit, info, and general turns', () => {
    expect(classifyDocumentTurnIntent('create a new html artifact')).toBe('create');
    expect(classifyDocumentTurnIntent('make it dark mode')).toBe('edit');
    expect(classifyDocumentTurnIntent('what types of documents can you create?')).toBe('info');
    expect(classifyDocumentTurnIntent('hello')).toBe('general');
  });
});

describe('informationalDeveloperPromptFor', () => {
  it('returns guidance for informational questions only', () => {
    expect(informationalDeveloperPromptFor('what can you create?')).toContain('text only');
    expect(informationalDeveloperPromptFor('make it dark mode')).toBeUndefined();
  });
});
