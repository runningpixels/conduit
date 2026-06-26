import { describe, expect, it } from 'vitest';
import { parseMessageSegments } from './messageSegments';
import { detectArtifactCandidates } from './artifactCandidates';

describe('parseMessageSegments', () => {
  it('splits prose + html fence into 2 segments with correct kind', () => {
    const src = 'Intro text.\n```html\n<div>hi</div>\n```\nMore.';
    const segs = parseMessageSegments(src);
    expect(segs).toHaveLength(3);
    expect(segs[0].type).toBe('prose');
    expect(segs[1].type).toBe('fence');
    expect(segs[1].candidate.kind).toBe('html');
    expect(segs[2].type).toBe('prose');
  });

  it('keeps small unlabeled fence in prose', () => {
    const src = 'Text before.\n```\nlet x=1\n```\nAfter.';
    const segs = parseMessageSegments(src);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe('prose');
    expect(segs[0].text).toContain('let x=1');
  });

  it('handles multiple fences', () => {
    const src = '```md\n# a\n```\n```json\n{}\n```';
    const segs = parseMessageSegments(src);
    expect(segs.filter((s) => s.type === 'fence')).toHaveLength(2);
  });

  it('preserves prose before and after', () => {
    const src = 'Start\n```rust\nfn(){}\n```\nEnd';
    const segs = parseMessageSegments(src);
    expect(segs[0].type).toBe('prose');
    expect(segs[2].type).toBe('prose');
  });

  it('treats unclosed fence at EOF as fence if promotable', () => {
    const src = '```html\n<div>partial';
    const segs = parseMessageSegments(src);
    expect(segs.some((s) => s.type === 'fence' && s.candidate.kind === 'html')).toBe(true);
  });
});

describe('detectArtifactCandidates (via segments)', () => {
  it('still returns no candidates for empty', () => {
    expect(detectArtifactCandidates('')).toEqual([]);
  });
});
