import { describe, expect, it } from 'vitest';
import { APP_PROMPT_MARK, appPrompt, appPromptLabel } from './appPrompt';

describe('appPrompt', () => {
  it('round-trips the label and keeps the model text after it', () => {
    const message = appPrompt('Build slides', 'The storyline is approved. Build the slides now.');
    expect(message.startsWith(APP_PROMPT_MARK)).toBe(true);
    expect(appPromptLabel(message)).toBe('Build slides');
    expect(message.endsWith('\nThe storyline is approved. Build the slides now.')).toBe(true);
  });

  it('keeps the label on one line', () => {
    expect(appPromptLabel(appPrompt('Fix\nslide 3', 'x'))).toBe('Fix slide 3');
  });

  it('is null for anything the user typed', () => {
    expect(appPromptLabel('Build slides')).toBeNull();
    expect(appPromptLabel('')).toBeNull();
    expect(appPromptLabel(`${APP_PROMPT_MARK}\nno label`)).toBeNull();
  });
});
