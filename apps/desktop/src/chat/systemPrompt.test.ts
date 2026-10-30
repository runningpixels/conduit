import { describe, expect, it } from 'vitest';
import type { AppSettings, GenerationControls } from '@conduit/config-schema';
import {
  composeSystemPrompt,
  joinExtraSystemSections,
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

  it('inserts extra sections between auto-composed blocks and user instructions', () => {
    const result = composeSystemPrompt(['Base.'], 'Be brief.', '## Skills\n\nBANANA-SKILL');
    expect(result.startsWith('Base.')).toBe(true);
    expect(result).toContain('BANANA-SKILL');
    expect(result).toContain(USER_INSTRUCTIONS_HEADING);
    expect(result.indexOf('BANANA-SKILL')).toBeLessThan(result.indexOf(USER_INSTRUCTIONS_HEADING));
  });

  it('drops extra sections when they are empty', () => {
    expect(composeSystemPrompt(['Base.'], null, '   ')).toBe('Base.');
  });

  it('places the memory heading before user instructions', () => {
    const extra = joinExtraSystemSections('## Skills\n\nBANANA-SKILL', '## Memory\n\nBANANA-MEMORY');
    const result = composeSystemPrompt(['Base.'], 'Be brief.', extra);
    expect(result.indexOf('BANANA-MEMORY')).toBeLessThan(result.indexOf(USER_INSTRUCTIONS_HEADING));
    expect(result.indexOf('BANANA-SKILL')).toBeLessThan(result.indexOf('BANANA-MEMORY'));
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
  it('passes a single source through unlabelled', () => {
    expect(resolveUserInstructions({} as AppSettings, 'Chat only.')).toBe('Chat only.');
    expect(
      resolveUserInstructions({} as AppSettings, null, { name: 'Ferry', userInstructions: 'Use British English.' }),
    ).toBe('Use British English.');
  });

  it('stacks settings, project and chat, labelled, most specific last', () => {
    const result = resolveUserInstructions(settings, 'Keep it short.', {
      name: 'Ferry',
      userInstructions: 'Use British English.',
    })!;
    const app = result.indexOf('### From your settings\n\nBe a pirate.');
    const project = result.indexOf('### From the project "Ferry"\n\nUse British English.');
    const chat = result.indexOf('### From this chat\n\nKeep it short.');
    expect(app).toBeGreaterThanOrEqual(0);
    expect(project).toBeGreaterThan(app);
    expect(chat).toBeGreaterThan(project);
    expect(result).toContain('more specific ones take precedence');
  });

  it('keeps the settings when a chat adds its own', () => {
    const result = resolveUserInstructions(settings, 'Chat only.')!;
    expect(result).toContain('Be a pirate.');
    expect(result).toContain('Chat only.');
  });

  it('skips a project without instructions', () => {
    expect(resolveUserInstructions(settings, null, { name: 'Ferry', userInstructions: null })).toBe(
      'Be a pirate.',
    );
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

describe('mergeGenerationControls for one-off retries', () => {
  it('keeps reasoning effort and lets an undefined key clear a default', () => {
    expect(mergeGenerationControls({ maxTokens: 9000 }, { reasoningEffort: 'low' })).toEqual({
      maxTokens: 9000,
      reasoningEffort: 'low',
    });
    expect(mergeGenerationControls({ maxTokens: 9000 }, { maxTokens: undefined })).toBeUndefined();
    expect(
      mergeGenerationControls({ maxTokens: 9000, temperature: 0.2 }, { maxTokens: undefined }),
    ).toEqual({ temperature: 0.2 });
  });
});
