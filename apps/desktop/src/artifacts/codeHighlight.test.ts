import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  normalizeCodeLanguage,
  tokenizeHighlightedCode,
  useHighlightTokens,
} from './codeHighlight';

describe('normalizeCodeLanguage', () => {
  it('maps common aliases via CODE_LANG', () => {
    expect(normalizeCodeLanguage('py')).toBe('python');
    expect(normalizeCodeLanguage('rs')).toBe('rust');
    expect(normalizeCodeLanguage('js')).toBe('javascript');
  });

  it('maps shell-family aliases to bash for Prism', () => {
    expect(normalizeCodeLanguage('sh')).toBe('bash');
    expect(normalizeCodeLanguage('shell')).toBe('bash');
    expect(normalizeCodeLanguage('zsh')).toBe('bash');
  });

  it('returns undefined for empty input', () => {
    expect(normalizeCodeLanguage('')).toBeUndefined();
    expect(normalizeCodeLanguage('   ')).toBeUndefined();
  });
});

describe('tokenizeHighlightedCode', () => {
  it('returns null for unknown languages', () => {
    expect(tokenizeHighlightedCode('x = 1', 'funkylang')).toBeNull();
    expect(tokenizeHighlightedCode('x = 1', undefined)).toBeNull();
  });

  it('tokenizes supported languages without throwing', () => {
    const tokens = tokenizeHighlightedCode('def main():\n  pass', 'python');
    expect(tokens).not.toBeNull();
    expect(tokens!.length).toBeGreaterThan(0);
    const flat = tokens!.flat();
    expect(flat.some((t) => t.types.includes('keyword') && t.content === 'def')).toBe(true);
  });

  it('never throws on malformed input', () => {
    expect(() => tokenizeHighlightedCode('<script>alert(1)</script>', 'python')).not.toThrow();
    expect(tokenizeHighlightedCode('<script>alert(1)</script>', 'python')).not.toBeNull();
  });
});

describe('useHighlightTokens', () => {
  it('returns null for unsupported languages', () => {
    const { result } = renderHook(() => useHighlightTokens('let x = 1', 'funkylang'));
    expect(result.current).toBeNull();
  });

  it('returns tokens for supported languages', () => {
    const { result } = renderHook(() => useHighlightTokens('fn main() {}', 'rust'));
    expect(result.current).not.toBeNull();
  });
});
