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

describe('plain text is not highlightable', () => {
  // Prism registers `plain`/`plaintext`/`text`/`txt` as aliases of one shared
  // EMPTY object. `Boolean({})` is true, so support checks used to pass, a
  // ```text fence "tokenised" into one `plain` token per line, and callers
  // concluded it was highlighted — leaving it rendered as dim prose instead of
  // taking the code colour.
  it.each(['text', 'txt', 'plain', 'plaintext'])('returns null for %s', (lang) => {
    expect(tokenizeHighlightedCode('Expected Return = 13.5%', lang)).toBeNull();
  });

  it('still tokenizes a real grammar', () => {
    expect(tokenizeHighlightedCode('x = 1', 'python')).not.toBeNull();
  });
});

describe('grammars that were declared but never loaded', () => {
  // `CODE_LANG` accepted these fence labels while their Prism components were
  // never imported, so they silently fell back to plain text.
  it.each(['dart', 'elixir', 'haskell', 'clojure', 'makefile'])('tokenizes %s', (lang) => {
    expect(tokenizeHighlightedCode('x = 1', lang)).not.toBeNull();
  });

  it('resolves gradle to groovy, which is how Prism ships it', () => {
    expect(normalizeCodeLanguage('gradle')).toBe('groovy');
    expect(tokenizeHighlightedCode('apply plugin: "java"', 'gradle')).not.toBeNull();
  });
});
