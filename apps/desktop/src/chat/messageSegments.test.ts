import { describe, expect, it } from 'vitest';
import {
  parseMessageSegments,
  summarizeFenceForPreview,
  summarizeMessageContentForPreview,
} from './messageSegments';
import { detectArtifactCandidates } from './artifactCandidates';

describe('parseMessageSegments', () => {
  it('splits prose + html fence into 2 segments with correct kind', () => {
    const src = 'Intro text.\n```html\n<div>hi</div>\n```\nMore.';
    const segs = parseMessageSegments(src);
    expect(segs).toHaveLength(3);
    expect(segs[0].type).toBe('prose');
    expect(segs[1].type).toBe('fence');
    if (segs[1].type === 'fence') {
      expect(segs[1].candidate.kind).toBe('html');
    }
    expect(segs[2].type).toBe('prose');
  });

  it('keeps small unlabeled fence in prose', () => {
    const src = 'Text before.\n```\nlet x=1\n```\nAfter.';
    const segs = parseMessageSegments(src);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe('prose');
    if (segs[0].type === 'prose') {
      expect(segs[0].text).toContain('let x=1');
    }
  });

  it('detects a short unlabeled HTML fence as an html candidate', () => {
    // Previously the size gate dropped this, so detectArtifactCandidates() saw
    // zero candidates and the "No artifact content detected" warning fired.
    const src = 'Here it is:\n```\n<div>hi</div>\n```';
    const segs = parseMessageSegments(src);
    const fence = segs.find((s) => s.type === 'fence');
    expect(fence).toBeDefined();
    if (fence && fence.type === 'fence') {
      expect(fence.candidate.kind).toBe('html');
    }
  });

  it('detects a short unlabeled JSON fence as a json candidate', () => {
    const src = '```\n{"a":1}\n```';
    const segs = parseMessageSegments(src);
    const fence = segs.find((s) => s.type === 'fence');
    if (fence && fence.type === 'fence') {
      expect(fence.candidate.kind).toBe('json');
    }
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

describe('summarizeMessageContentForPreview', () => {
  it('replaces html fence with compact artifact summary', () => {
    const src =
      "Here's a complete artifact.\n```html\n<!DOCTYPE html><html><head><title>Python overview</title></head><body><p>x</p></body></html>\n```";
    const preview = summarizeMessageContentForPreview(src);
    expect(preview).toContain("Here's a complete artifact.");
    expect(preview).toContain('HTML artifact');
    expect(preview).toContain('Python overview');
    expect(preview).not.toContain('<!DOCTYPE');
  });

  it('uses markdown heading in artifact summary', () => {
    const src = '```md\n# My Doc Title\n\nBody text here.\n```';
    const preview = summarizeMessageContentForPreview(src);
    expect(preview).toContain('Markdown artifact');
    expect(preview).toContain('My Doc Title');
    expect(preview).not.toContain('Body text here');
  });

  it('truncates very long previews', () => {
    const src = 'word '.repeat(80);
    const preview = summarizeMessageContentForPreview(src);
    expect(preview).toMatch(/…$/);
    expect(preview!.length).toBeLessThanOrEqual(121);
  });

  it('summarizeFenceForPreview includes line count and title when available', () => {
    const segs = parseMessageSegments('```html\n<div>\nline2\n</div>\n```');
    const fence = segs.find((s) => s.type === 'fence');
    expect(fence?.type).toBe('fence');
    if (fence?.type === 'fence') {
      expect(summarizeFenceForPreview(fence.candidate)).toBe('HTML artifact · <div> · 3 lines');
    }
  });
});
