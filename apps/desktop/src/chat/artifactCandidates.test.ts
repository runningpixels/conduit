import { describe, expect, it } from 'vitest';
import { detectArtifactCandidates } from './artifactCandidates';

describe('detectArtifactCandidates', () => {
  it('returns no candidates for empty / streaming content', () => {
    expect(detectArtifactCandidates('')).toEqual([]);
  });

  it('maps a labeled rust fence to a code candidate with text/x-rust mime', () => {
    const src = 'Here is code:\n```rust\nfn main() {}\n```\nDone.';
    const cands = detectArtifactCandidates(src);
    expect(cands).toHaveLength(1);
    expect(cands[0].kind).toBe('code');
    expect(cands[0].mimeType).toBe('text/x-rust');
    expect(cands[0].body).toBe('fn main() {}');
    expect(cands[0].info).toBe('rust');
  });

  it('maps markdown / json / html / text info strings to their kinds', () => {
    const src = [
      '```md\n# Title\n```',
      '```json\n{"a":1}\n```',
      '```html\n<div>x</div>\n```',
      '```text\nhello\n```',
    ].join('\n\n');
    const cands = detectArtifactCandidates(src);
    expect(cands.map((c) => c.kind)).toEqual(['markdown', 'json', 'html', 'text']);
    expect(cands[0].mimeType).toBe('text/markdown');
    expect(cands[1].mimeType).toBe('application/json');
    expect(cands[2].mimeType).toBe('text/html');
    expect(cands[3].mimeType).toBe('text/plain');
  });

  it('does not promote a small unlabeled fence', () => {
    const src = '```\nlet x = 1\n```';
    expect(detectArtifactCandidates(src)).toEqual([]);
  });

  it('promotes a long unlabeled fence as markdown (or json if it parses)', () => {
    const prose = 'word '.repeat(60).trim();
    const src = '```\n' + prose + '\n```';
    const cands = detectArtifactCandidates(src);
    expect(cands).toHaveLength(1);
    expect(cands[0].kind).toBe('markdown');

    const json = '{\n  "hello": "' + 'x'.repeat(220) + '"\n}';
    const cands2 = detectArtifactCandidates('```\n' + json + '\n```');
    expect(cands2).toHaveLength(1);
    expect(cands2[0].kind).toBe('json');
  });

  it('handles tildes fences and an unclosed fence at EOF', () => {
    const closed = '~~~python\nprint(1)\n~~~';
    expect(detectArtifactCandidates(closed)[0].mimeType).toBe('text/x-python');
    const unclosed = '```js\nconst x = 1;\n'; // no closing fence
    const cands = detectArtifactCandidates(unclosed);
    expect(cands).toHaveLength(1);
    // Unclosed-at-EOF: the body runs to the end including the trailing newline.
    expect(cands[0].body).toBe('const x = 1;\n');
  });

  it('derives a title from the first non-empty body line, truncated', () => {
    const src = '```rust\n// This is a very long comment line that should be truncated to a reasonable title length yes indeed\nfn main() {}\n```';
    const title = detectArtifactCandidates(src)[0].title;
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.startsWith('// This is a very long')).toBe(true);
  });

  it('ignores a fenced block whose body is empty', () => {
    const src = '```rust\n```';
    expect(detectArtifactCandidates(src)).toEqual([]);
  });

  it('treats an unknown language label as code', () => {
    const src = '```brainfuck\n+++[->++<]>\n```';
    const cands = detectArtifactCandidates(src);
    expect(cands).toHaveLength(1);
    expect(cands[0].kind).toBe('code');
    // Unknown lang still gets a `text/x-<lang>` chip (the renderer strips the
    // prefix), so the language label is preserved.
    expect(cands[0].mimeType).toBe('text/x-brainfuck');
  });
});