import { describe, expect, it } from 'vitest';
import type { Artifact } from '../ipc/contracts';
import {
  selectRenderer,
  resolveKind,
  buildPreviewProps,
  buildSourceProps,
  inlineText,
  languageFromMime,
} from './selectRenderer';
import { CodeRenderer, JsonRenderer, MarkdownRenderer, PlainTextRenderer } from './renderers';
import { HtmlArtifactRenderer } from './HtmlArtifactRenderer';

function art(over: Partial<Artifact>): Artifact {
  return {
    id: 'a1',
    conversationId: 'c1',
    kind: 'text',
    createdAt: '2026-06-22T00:00:00Z',
    ...over,
  };
}

describe('resolveKind', () => {
  it('applies mimeType overrides', () => {
    expect(resolveKind('text', 'application/json')).toBe('json');
    expect(resolveKind('text', 'text/markdown')).toBe('markdown');
    expect(resolveKind('text', 'text/html')).toBe('html');
    expect(resolveKind('code', 'text/plain')).toBe('code');
  });
  it('falls back to the declared kind', () => {
    expect(resolveKind('code', undefined)).toBe('code');
    expect(resolveKind('markdown', 'text/plain')).toBe('markdown');
  });
});

describe('selectRenderer dispatch', () => {
  it('markdown → Markdown preview / PlainText source', () => {
    const { Preview, Source } = selectRenderer(art({ kind: 'markdown' }));
    expect(Preview).toBe(MarkdownRenderer);
    expect(Source).toBe(PlainTextRenderer);
  });
  it('code → Code preview / PlainText source', () => {
    const { Preview } = selectRenderer(art({ kind: 'code' }));
    expect(Preview).toBe(CodeRenderer);
  });
  it('json → JSON preview / PlainText source', () => {
    const { Preview } = selectRenderer(art({ kind: 'json' }));
    expect(Preview).toBe(JsonRenderer);
  });
  it('text → PlainText preview / PlainText source', () => {
    const { Preview, Source } = selectRenderer(art({ kind: 'text' }));
    expect(Preview).toBe(PlainTextRenderer);
    expect(Source).toBe(PlainTextRenderer);
  });
  it('html → HtmlArtifactRenderer preview / PlainText source', () => {
    const { Preview, Source } = selectRenderer(art({ kind: 'html' }));
    expect(Preview).toBe(HtmlArtifactRenderer);
    expect(Source).toBe(PlainTextRenderer);
  });
  it('application/json mimeType overrides a non-json kind', () => {
    const { Preview } = selectRenderer(art({ kind: 'text', mimeType: 'application/json' }));
    expect(Preview).toBe(JsonRenderer);
  });
  it('text/html mimeType overrides a non-html kind', () => {
    const { Preview } = selectRenderer(art({ kind: 'text', mimeType: 'text/html' }));
    expect(Preview).toBe(HtmlArtifactRenderer);
  });
});

describe('buildPreviewProps', () => {
  it('returns null for a File-content artifact with no inline text', () => {
    expect(buildPreviewProps(art({ kind: 'code', contentPath: 'a/foo.txt' }), [])).toBeNull();
  });
  it('builds markdown props from contentText', () => {
    expect(buildPreviewProps(art({ kind: 'markdown', contentText: '# hi' }), [])).toEqual({ source: '# hi' });
  });
  it('builds code props with a language chip from mimeType', () => {
    expect(buildPreviewProps(art({ kind: 'code', contentText: 'fn x()', mimeType: 'text/x-rust' }), [])).toEqual({
      code: 'fn x()',
      language: 'rust',
    });
  });
  it('builds json props from contentJson', () => {
    expect(buildPreviewProps(art({ kind: 'json', contentJson: { k: 1 } }), [])).toEqual({ data: { k: 1 } });
  });
  it('builds html props with the allowlist', () => {
    expect(buildPreviewProps(art({ kind: 'html', contentText: '<p/>' }), ['https://x.example.com'])).toEqual({
      html: '<p/>',
      allowlist: ['https://x.example.com'],
    });
  });
});

describe('buildSourceProps / inlineText', () => {
  it('source is the inline text, pretty-printing json', () => {
    expect(buildSourceProps(art({ kind: 'json', contentJson: { k: 1 } })).text).toContain('"k"');
  });
  it('inlineText prefers contentText over contentJson', () => {
    expect(inlineText(art({ kind: 'text', contentText: 'T', contentJson: { x: 1 } }))).toBe('T');
  });
});

describe('languageFromMime', () => {
  it('maps known mimes', () => {
    expect(languageFromMime('text/markdown')).toBe('markdown');
    expect(languageFromMime('application/json')).toBe('json');
    expect(languageFromMime('text/html')).toBe('html');
    expect(languageFromMime('text/x-rust')).toBe('rust');
    expect(languageFromMime('text/plain')).toBeUndefined();
    expect(languageFromMime(undefined)).toBeUndefined();
  });
});