import { describe, expect, it } from 'vitest';
import {
  buildCitationSegments,
  dedupeCitationsByUrl,
  uniqueFootnotes,
} from './citationUtils';
import type { CitationAnnotation } from './streamState';

describe('dedupeCitationsByUrl', () => {
  it('remaps duplicate URLs to the same footnote index', () => {
    const citations: CitationAnnotation[] = [
      { index: 1, url: 'https://a.com', title: 'A', startIndex: 0, endIndex: 5 },
      { index: 2, url: 'https://a.com', title: 'A dup', startIndex: 10, endIndex: 15 },
      { index: 3, url: 'https://b.com', title: 'B', startIndex: 20, endIndex: 25 },
    ];
    const deduped = dedupeCitationsByUrl(citations);
    expect(deduped[0].index).toBe(1);
    expect(deduped[1].index).toBe(1);
    expect(deduped[2].index).toBe(2);
    expect(uniqueFootnotes(deduped)).toHaveLength(2);
  });
});

describe('buildCitationSegments', () => {
  it('places citation markers at startIndex boundaries', () => {
    const text = 'Hello world';
    const citations: CitationAnnotation[] = [
      { index: 1, url: 'https://x.com', title: 'X', startIndex: 0, endIndex: 5 },
    ];
    const segments = buildCitationSegments(text, citations);
    expect(segments[0].citationsAtStart).toHaveLength(1);
    expect(segments[0].text).toBe('Hello');
  });
});
