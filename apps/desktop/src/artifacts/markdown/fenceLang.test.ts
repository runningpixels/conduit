import { describe, expect, it } from 'vitest';
import { fenceLang, isMathLang, isMermaidLang, mermaidSourceFromFence } from './fenceLang';

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

describe('mermaidSourceFromFence', () => {
  const diagram = ['flowchart TD', '  A[User] --> B[Conduit]', '  B --> C[Provider]'].join('\n');

  it('returns the body of a labeled mermaid fence', () => {
    expect(mermaidSourceFromFence('mermaid', diagram)).toBe(diagram);
  });

  it('unwraps a markdown fence whose only payload is a mermaid fence', () => {
    const wrapped = ['```mermaid', diagram, '```'].join('\n');
    expect(mermaidSourceFromFence('markdown', wrapped)).toBe(diagram);
  });

  it('unwraps when CommonMark stole the inner mermaid closer', () => {
    // ```markdown ... ```mermaid ... ```  — the last ``` closed the wrapper.
    const stolen = ['```mermaid', diagram].join('\n');
    expect(mermaidSourceFromFence('markdown', stolen)).toBe(diagram);
  });

  it('treats a markdown fence whose body is the diagram source as mermaid', () => {
    expect(mermaidSourceFromFence('md', diagram)).toBe(diagram);
  });

  it('does not treat a real markdown document as a diagram', () => {
    const doc = ['# Notes', '', '```mermaid', diagram, '```', '', 'See above.'].join('\n');
    expect(mermaidSourceFromFence('markdown', doc)).toBeNull();
  });

  it('does not render an unlabeled quote of a mermaid fence', () => {
    const quoted = ['```mermaid', diagram, '```'].join('\n');
    expect(mermaidSourceFromFence('', quoted)).toBeNull();
  });
});
