import { describe, expect, it } from 'vitest';
import { resolveWebSearchForTurn, userWantsWebSearch } from './webSearchIntent';

describe('userWantsWebSearch', () => {
  it('matches explicit internet search phrasing', () => {
    expect(userWantsWebSearch('search the internet for this weeks latest market news')).toBe(true);
    expect(userWantsWebSearch('look up online what happened today')).toBe(true);
  });

  it('does not match generic chat', () => {
    expect(userWantsWebSearch('hello')).toBe(false);
    expect(userWantsWebSearch('summarize this paragraph')).toBe(false);
  });
});

describe('resolveWebSearchForTurn', () => {
  const enabled = { webSearchEnabled: true, localOnly: false };

  it('honors the per-turn toggle', () => {
    expect(resolveWebSearchForTurn(enabled, true, 'hello')).toBe(true);
  });

  it('auto-enables for search-intent prompts when globally enabled', () => {
    expect(
      resolveWebSearchForTurn(enabled, false, 'search the internet for market news'),
    ).toBe(true);
  });

  it('stays off when local-only or globally disabled', () => {
    expect(
      resolveWebSearchForTurn(
        { webSearchEnabled: true, localOnly: true },
        false,
        'search the internet',
      ),
    ).toBe(false);
    expect(
      resolveWebSearchForTurn(
        { webSearchEnabled: false, localOnly: false },
        false,
        'search the internet',
      ),
    ).toBe(false);
  });
});
