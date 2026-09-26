import { describe, expect, it } from 'vitest';
import {
  parseMessageSegments,
  salvageLeakedToolCall,
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

  it('decodes character references in an HTML <title>, as the browser does', () => {
    // Seen live: the card and the panel tab read "Price, Yield &amp; the Rate
    // Seesaw" while the rendered page's own tab said "&".
    const src = ['```html', '<title>Price, Yield &amp; the Rate&#32;Seesaw &#x2014; 101</title>', '<p>x</p>', '```'].join(NL);
    const fence = parseMessageSegments(src).find((seg) => seg.type === 'fence');
    expect(fence?.type === 'fence' && fence.candidate.title).toBe('Price, Yield & the Rate Seesaw — 101');
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

describe('salvageLeakedToolCall', () => {
  const page = ['<!DOCTYPE html>', '<html lang="en">', '<head><title>Pomodoro Timer</title></head>', '<body><p>25:00</p></body>', '</html>'].join(NL);

  it('recovers the document from a call the model wrote as text (as seen live)', () => {
    // GLM 5.3 Flash on OpenRouter, head of the call lost upstream.
    const leaked = `content</arg_key><arg_value>${page}${NL}</arg_value></tool_call>`;
    const fences = parseMessageSegments(leaked).filter((s) => s.type === 'fence');
    expect(fences).toHaveLength(1);
    const fence = fences[0];
    if (fence.type !== 'fence') throw new Error('unreachable');
    expect(fence.candidate.kind).toBe('html');
    expect(fence.candidate.title).toBe('Pomodoro Timer');
    expect(fence.candidate.body).toBe(page);
    expect(salvageLeakedToolCall(leaked)).not.toMatch(/arg_value|tool_call|arg_key/);
  });

  it('drops the whole call, title argument included, and keeps the prose around it', () => {
    const leaked = [
      "Here's your timer:",
      `<tool_call>write_html_document<arg_key>title</arg_key><arg_value>Pomodoro</arg_value><arg_key>content</arg_key><arg_value>${page}</arg_value></tool_call>`,
      'Press space to start.',
    ].join(NL);
    const out = salvageLeakedToolCall(leaked);
    expect(out).not.toMatch(/arg_value|tool_call|arg_key|write_html_document/);
    expect(out.startsWith("Here's your timer:\n```html\n<!DOCTYPE html>")).toBe(true);
    expect(out.trimEnd().endsWith('Press space to start.')).toBe(true);
  });

  it('opens a fence for a call still streaming, so the card path applies', () => {
    const partial = `content</arg_key><arg_value><!DOCTYPE html>${NL}<html><body><p>25`;
    expect(salvageLeakedToolCall(partial)).toBe(`\`\`\`html${NL}<!DOCTYPE html>${NL}<html><body><p>25`);
  });

  it('leaves prose that merely mentions the markup alone', () => {
    const prose = 'The format looks like <arg_value><!DOCTYPE html></arg_value> inside a call.';
    expect(salvageLeakedToolCall(prose)).toBe(prose);
    const snippet = '<arg_value>just a title</arg_value></tool_call>';
    expect(salvageLeakedToolCall(snippet)).toBe(snippet);
  });
});

describe('fence nesting and titles (round-2 live findings)', () => {
  it('keeps ```html examples inside a ```markdown README in the README', () => {
    // Live: the README was cut at its first example's close, its tail became
    // prose and the closing remark was auto-opened as "the document".
    const src = [
      '```html', '<form>…</form>', '```', '',
      '```markdown', '# Embedding', '', 'Paste this:', '', '   ```html', '   <iframe src="form.html"></iframe>', '   ```', '', 'Done.', '```', '',
      'A couple of things worth knowing.',
    ].join(NL);
    const fences = parseMessageSegments(src).filter((s) => s.type === 'fence');
    expect(fences.map((f) => f.type === 'fence' && f.candidate.kind)).toEqual(['html', 'markdown']);
    const readme = fences[1];
    if (readme.type !== 'fence') throw new Error('unreachable');
    expect(readme.candidate.body).toContain('<iframe');
    expect(readme.candidate.body.trimEnd().endsWith('Done.')).toBe(true);
  });

  it('does not let a lone opener inside markdown swallow the rest of the reply', () => {
    const src = ['```markdown', '# Notes', '```js', 'run()', '```', '', 'After the fence.'].join(NL);
    const segs = parseMessageSegments(src);
    expect(segs[segs.length - 1]).toEqual({ type: 'prose', text: '\nAfter the fence.' });
  });

  it('titles JSON by its keys and code without its comment marker', () => {
    const json = parseMessageSegments('```json\n{\n  "root": true,\n  "parser": "x",\n  "plugins": [],\n  "rules": {}\n}\n```')[0];
    expect(json.type === 'fence' && json.candidate.title).toBe('JSON · root, parser, plugins');
    const js = parseMessageSegments('```javascript\n// server.js — Todo API\nconst x = 1;\n```')[0];
    expect(js.type === 'fence' && js.candidate.title).toBe('server.js — Todo API');
  });
});
