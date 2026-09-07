import { describe, expect, it } from 'vitest';
import { draftFromControls, emptyGenerationDraft, parseGenerationDraft } from './GenerationFields';
import { enTranslate } from '../test/enTranslate';

describe('parseGenerationDraft', () => {
  it('returns null controls when all fields are empty', () => {
    const parsed = parseGenerationDraft(emptyGenerationDraft());
    expect(parsed.errorId).toBeUndefined();
    expect(parsed.controls).toBeNull();
    expect(parsed.userInstructions).toBeNull();
  });

  it('parses temperature and stop sequences', () => {
    const parsed = parseGenerationDraft({
      ...emptyGenerationDraft(),
      temperature: '0.2',
      stopSequences: 'END\nSTOP',
      userInstructions: '  Be brief.  ',
    });
    expect(parsed.errorId).toBeUndefined();
    expect(parsed.controls).toEqual({ temperature: 0.2, stopSequences: ['END', 'STOP'] });
    expect(parsed.userInstructions).toBe('Be brief.');
  });

  it('rejects temperature above 2', () => {
    const parsed = parseGenerationDraft({
      ...emptyGenerationDraft(),
      temperature: '2.5',
    });
    // The id is the contract now, not the sentence. Rendering it through the
    // real English catalog keeps the assertion honest about what a user reads
    // while still failing if the key is ever deleted.
    expect(parsed.errorId).toBe('error.validation.temperatureRange');
    expect(enTranslate(parsed.errorId!)).toMatch(/Temperature/);
  });
});

describe('draftFromControls', () => {
  it('round-trips a populated bundle', () => {
    const draft = draftFromControls(
      { temperature: 0.7, maxTokens: 1024, stopSequences: ['END'] },
      'Hello',
    );
    const parsed = parseGenerationDraft(draft);
    expect(parsed.controls).toEqual({
      temperature: 0.7,
      maxTokens: 1024,
      stopSequences: ['END'],
    });
    expect(parsed.userInstructions).toBe('Hello');
  });
});
