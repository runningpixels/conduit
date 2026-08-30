import { describe, expect, it } from 'vitest';
import { fenceLang, isMathLang, isMermaidLang } from './fenceLang';

describe('fenceLang', () => {
  it('takes the first info-string token, lowercased', () => {
    expect(fenceLang('Mermaid extra')).toBe('mermaid');
    expect(fenceLang('  MATH  ')).toBe('math');
    expect(fenceLang('')).toBe('');
  });

  it('recognises mermaid and math languages', () => {
    expect(isMermaidLang('mermaid')).toBe(true);
    expect(isMermaidLang('python')).toBe(false);
    expect(isMathLang('math')).toBe(true);
    expect(isMathLang('latex')).toBe(true);
    expect(isMathLang('tex')).toBe(true);
    expect(isMathLang('python')).toBe(false);
  });
});
