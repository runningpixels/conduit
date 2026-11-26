import { describe, expect, it } from 'vitest';
import { parseStandaloneAppRoute } from './standaloneRoute';

describe('parseStandaloneAppRoute', () => {
  it('reads a well-formed app id', () => {
    expect(parseStandaloneAppRoute('?app=3f2a-9bC')).toBe('3f2a-9bC');
    expect(parseStandaloneAppRoute('?x=1&app=abc')).toBe('abc');
  });

  it('is null without the parameter', () => {
    expect(parseStandaloneAppRoute('')).toBeNull();
    expect(parseStandaloneAppRoute('?ask=1')).toBeNull();
    expect(parseStandaloneAppRoute('?app=')).toBeNull();
  });

  it('rejects ids outside [A-Za-z0-9-]{1,64}', () => {
    expect(parseStandaloneAppRoute('?app=../x')).toBeNull();
    expect(parseStandaloneAppRoute('?app=a%20b')).toBeNull();
    expect(parseStandaloneAppRoute('?app=a_b')).toBeNull();
    expect(parseStandaloneAppRoute(`?app=${'a'.repeat(65)}`)).toBeNull();
    expect(parseStandaloneAppRoute(`?app=${'a'.repeat(64)}`)).toBe('a'.repeat(64));
  });
});
