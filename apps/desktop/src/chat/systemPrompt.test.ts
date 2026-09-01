import { describe, expect, it } from 'vitest';
import type { AppSettings, GenerationControls } from '@conduit/config-schema';
import {
  composeSystemPrompt,
  mergeGenerationControls,
  resolveUserInstructions,
  USER_INSTRUCTIONS_HEADING,
} from './systemPrompt';

const settings = {
  userInstructions: 'Be a pirate.',
} as AppSettings;

describe('composeSystemPrompt', () => {
  it('joins auto-composed blocks and does not drop them when user text is set', () => {
    const auto = ['You are a helpful assistant.', 'Tools: search.'];
    const result = composeSystemPrompt(auto, 'Always say BANANA.');
    expect(result.startsWith('You are a helpful assistant. Tools: search.')).toBe(true);
    expect(result).toContain(USER_INSTRUCTIONS_HEADING);
    expect(result).toContain('Always say BANANA.');
    expect(result.indexOf('You are a helpful assistant.')).toBeLessThan(
      result.indexOf(USER_INSTRUCTIONS_HEADING),
    );
  });

  it('omits the user block when instructions are empty', () => {
    const result = composeSystemPrompt(['Base.'], '   ');
    expect(result).toBe('Base.');
    expect(result).not.toContain(USER_INSTRUCTIONS_HEADING);
  });
});

describe('mergeGenerationControls', () => {
  it('lets conversation keys win and inherits the rest', () => {
    const defaults: GenerationControls = { temperature: 0.7, topP: 0.9, maxTokens: 1024 };
    const override: GenerationControls = { temperature: 0.2 };
    expect(mergeGenerationControls(defaults, override)).toEqual({
      temperature: 0.2,
      topP: 0.9,
      maxTokens: 1024,
    });
  });

  it('returns undefined when both sides are empty', () => {
    expect(mergeGenerationControls(undefined, undefined)).toBeUndefined();
    expect(mergeGenerationControls({}, {})).toBeUndefined();
  });
});

describe('resolveUserInstructions', () => {
  it('uses conversation text when set', () => {
    expect(resolveUserInstructions(settings, 'Chat only.')).toBe('Chat only.');
  });

  it('inherits settings when conversation override is null or empty', () => {
    expect(resolveUserInstructions(settings, null)).toBe('Be a pirate.');
    expect(resolveUserInstructions(settings, '  ')).toBe('Be a pirate.');
    expect(resolveUserInstructions(settings, undefined)).toBe('Be a pirate.');
  });

  it('returns undefined when neither side has text', () => {
    expect(resolveUserInstructions({} as AppSettings, null)).toBeUndefined();
  });
});
