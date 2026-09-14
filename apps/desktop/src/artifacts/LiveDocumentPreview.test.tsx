import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { LiveDocumentPreview, withoutScripts } from './LiveDocumentPreview';
import { decodePartialContent } from '../chat/documentWriteScan';

describe('withoutScripts', () => {
  it('drops script elements, including one cut off mid-stream, and inline handlers', () => {
    expect(withoutScripts('<p>a</p><script>alert(1)</script><p>b</p>')).toBe('<p>a</p><p>b</p>');
    expect(withoutScripts('<p>a</p><script>const x = {')).toBe('<p>a</p>');
    expect(withoutScripts('<button onclick="go()" class="x">b</button>')).toBe('<button class="x">b</button>');
  });
});

describe('decodePartialContent', () => {
  it('returns the document text received so far', () => {
    expect(decodePartialContent('write_html_document', '{"title":"T","html":"<h1>Hi</h1>\\n<p>par')).toBe(
      '<h1>Hi</h1>\n<p>par',
    );
    expect(decodePartialContent('uuid', '{}')).toBeUndefined();
  });
});

describe('LiveDocumentPreview', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders partial HTML in frames with the finished preview’s containment', async () => {
    render(
      <LiveDocumentPreview
        kind="html"
        readSource={() => ({ toolName: 'write_html_document', argumentsText: '{"html":"<h1>Planets</h1><script>boom(' })}
        allowlist={[]}
      />,
    );
    await act(async () => {});
    const frames = document.querySelectorAll('iframe');
    expect(frames.length).toBe(2);
    for (const frame of frames) {
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
      expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(frame.hasAttribute('src')).toBe(false);
    }
    const shown = document.querySelector('iframe[data-shown="true"]');
    const doc = shown?.getAttribute('srcdoc') ?? '';
    expect(doc).toContain('<h1>Planets</h1>');
    expect(doc).not.toContain('boom(');
    expect(doc).toMatch(/<head><meta http-equiv="Content-Security-Policy"/);
  });

  it('renders partial markdown directly', async () => {
    render(
      <LiveDocumentPreview
        kind="markdown"
        readSource={() => ({ toolName: 'write_markdown_document', argumentsText: '{"markdown":"# Field guide\\n\\nMercury is' })}
        allowlist={[]}
      />,
    );
    await act(async () => {});
    expect(screen.getByText('Field guide')).toBeInTheDocument();
  });
});
