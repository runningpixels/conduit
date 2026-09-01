import { describe, expect, it } from 'vitest';
import { draftFromControls, emptyGenerationDraft, parseGenerationDraft } from './GenerationFields';

describe('parseGenerationDraft', () => {
  it('returns null controls when all fields are empty', () => {
    const parsed = parseGenerationDraft(emptyGenerationDraft());
    expect(parsed.error).toBeUndefined();
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
    expect(parsed.error).toBeUndefined();
    expect(parsed.controls).toEqual({ temperature: 0.2, stopSequences: ['END', 'STOP'] });
    expect(parsed.userInstructions).toBe('Be brief.');
  });

  it('rejects temperature above 2', () => {
    const parsed = parseGenerationDraft({
      ...emptyGenerationDraft(),
      temperature: '2.5',
    });
    expect(parsed.error).toMatch(/Temperature/);
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
