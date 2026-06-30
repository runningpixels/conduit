import { describe, expect, it } from 'vitest';
import { COMPOSER_CAPS } from '../mock/workspace';

describe('COMPOSER_CAPS', () => {
  it('only exposes web search in the composer capabilities row', () => {
    expect(COMPOSER_CAPS).toEqual([
      { id: 'websearch', label: 'web search', state: 'none' },
    ]);
  });
});
