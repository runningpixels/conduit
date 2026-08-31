import { describe, expect, it } from 'vitest';
import {
  parseMessageSegments,
  summarizeFenceForPreview,
  summarizeMessageContentForPreview,
} from './messageSegments';
import { detectArtifactCandidates } from './artifactCandidates';

const NL = String.fromCharCode(10);

describe('parseMessageSegments', () => {
  it('does not let a nested fence close a longer one', () => {
    // CommonMark: a closing run must be at least as long as the opener. Only
    // comparing the character meant the inner ``` closed the ```` wrapper, so
    // the quoted example was torn in half and its tail reparsed as a new fence.
    const src = ['````markdown', 'Quoting a fence:', '', '```mermaid', 'flowchart TD', 'A-->B', '```', '````'].join(NL);
    const segs = parseMessageSegments(src);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe('fence');
    if (segs[0].type === 'fence') {
      expect(segs[0].candidate.body).toContain('```mermaid');
      expect(segs[0].candidate.body).toContain('A-->B');
      // The wrapper's own closing run is not part of what it wraps.
      expect(segs[0].candidate.body.endsWith('```')).toBe(true);
    }
  });

  it('keeps an unlabeled ```` wrapper whole instead of splitting it in two', () => {
    // Too short to resolve a kind, so it stays prose — but as *one* run of
    // prose. The length bug closed it early and left the trailing ```` as a
    // second, empty fence.
    const src = ['````', 'Quoting:', '```mermaid', 'flowchart TD', '```', '````'].join(NL);
    const segs = parseMessageSegments(src);
    expect(segs).toHaveLength(1);
    expect(segs[0].type).toBe('prose');
    if (segs[0].type === 'prose') expect(segs[0].text).toBe(src);
  });

  it('titles a card from content, not from a fence delimiter nested in it', () => {
    // A model asked to "reply with only this markdown" wraps the whole answer
    // in ```markdown, whose first body line is then ```mermaid — punctuation,
    // and useless as the name on a card.
    const src = ['```markdown', '```mermaid', 'flowchart TD', 'A-->B', '```', '```'].join(NL);
    const segs = parseMessageSegments(src);
    const fence = segs.find((seg) => seg.type === 'fence');
    expect(fence?.type).toBe('fence');
    if (fence?.type === 'fence') {
      expect(fence.candidate.title).toBe('flowchart TD');
    }
  });

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
