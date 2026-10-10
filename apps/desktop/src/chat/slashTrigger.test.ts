import { describe, expect, it } from 'vitest';
import { findSlashTrigger, removeSlashCommand, slashCommandMatches } from './slashTrigger';

describe('findSlashTrigger', () => {
  it('opens on a leading / and reads the word up to the caret', () => {
    expect(findSlashTrigger('/', 1)).toEqual({ query: '', end: 1 });
    expect(findSlashTrigger('/res', 4)).toEqual({ query: 'res', end: 4 });
    // Caret mid-word: the query stops at the caret, the word does not.
    expect(findSlashTrigger('/research', 3)).toEqual({ query: 're', end: 9 });
  });

  it('is inert anywhere but the first character', () => {
    expect(findSlashTrigger('and/or', 6)).toBeNull();
    expect(findSlashTrigger(' /web', 5)).toBeNull();
    expect(findSlashTrigger('', 0)).toBeNull();
  });

  it('closes once whitespace follows the word', () => {
    expect(findSlashTrigger('/web ', 5)).toBeNull();
    expect(findSlashTrigger('/usr/bin is', 11)).toBeNull();
  });

  it('ignores a caret outside the text', () => {
    expect(findSlashTrigger('/web', 0)).toBeNull();
    expect(findSlashTrigger('/web', 9)).toBeNull();
  });
});

describe('removeSlashCommand', () => {
  it('drops the command word and one following space', () => {
    expect(removeSlashCommand('/web', { query: 'web', end: 4 })).toBe('');
    expect(removeSlashCommand('/we rust 2026', { query: 'we', end: 3 })).toBe('rust 2026');
  });
});

describe('slashCommandMatches', () => {
  it('matches the command word or the start of a word in its description', () => {
    expect(slashCommandMatches('folder', 'Work in a folder', 'fo')).toBe(true);
    expect(slashCommandMatches('folder', 'Work in a folder', 'wor')).toBe(true);
    expect(slashCommandMatches('file', 'Ask about a file', 'sk')).toBe(false);
    expect(slashCommandMatches('web', 'Search the web', '')).toBe(true);
  });
});
