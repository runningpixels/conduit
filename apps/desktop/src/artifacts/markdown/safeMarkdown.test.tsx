import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { renderMarkdown } from './safeMarkdown';

/// Security + structure tests for the hand-rolled safe-subset Markdown renderer.
/// jsdom does not parse/execute scripts, so these assert structure: no `<script>`
/// element is emitted, raw HTML renders as escaped visible text, and disallowed
/// URL schemes do not become anchors.

describe('safeMarkdown security', () => {
  it('renders raw <script> as escaped visible text, never as a script element', () => {
    const { container } = render(<>{renderMarkdown('<script>alert(1)</script>')}</>);
    expect(container.querySelector('script')).toBeNull();
    // The literal text is visible (escaped) — jsdom unescapes the text content.
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders an <img onerror=...> tag as escaped text, no img element', () => {
    const { container } = render(<>{renderMarkdown('<img src=x onerror=alert(1)>')}</>);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('rejects javascript: link hrefs — renders the raw markdown as text, no anchor', () => {
    const { container } = render(<>{renderMarkdown('[click](javascript:alert(1))')}</>);
    const anchor = container.querySelector('a');
    expect(anchor).toBeNull();
    expect(container.textContent).toContain('[click](javascript:alert(1))');
  });

  it('rejects data: link hrefs', () => {
    const { container } = render(<>{renderMarkdown('[x](data:text/html,<script>)')}</>);
    expect(container.querySelector('a')).toBeNull();
  });

  it('rejects a whitespace-prefixed javascript: URL', () => {
    const { container } = render(<>{renderMarkdown('[x](  javascript:alert(1))')}</>);
    expect(container.querySelector('a')).toBeNull();
  });

  it('renders an https link as a safe anchor with target=_blank + noopener', () => {
    const { container } = render(<>{renderMarkdown('[docs](https://example.com/page)')}</>);
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('https://example.com/page');
    expect(anchor?.getAttribute('target')).toBe('_blank');
    expect(anchor?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('autolinks a bare https:// URL as a safe anchor', () => {
    const { container } = render(<>{renderMarkdown('see https://example.com for more')}</>);
    const anchor = container.querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://example.com');
  });

  it('does not use dangerouslySetInnerHTML (no raw HTML injection path)', () => {
    // Structural: a fenced code block with HTML inside renders as escaped text
    // inside <pre><code>, not parsed markup.
    const { container } = render(
      <>{renderMarkdown('```html\n<div onclick=alert(1)>\n```')}</>,
    );
    expect(container.querySelector('div')).toBeNull();
    expect(container.querySelector('pre > code')?.textContent).toContain('<div onclick=alert(1)>');
  });
});

describe('safeMarkdown structure', () => {
  it('renders headings, bold, italic, code, list, quote, rule, paragraph', () => {
    const md = `# Title\n\n**bold** and *italic* and \`code\`.\n\n- a\n- b\n\n> quoted\n\n---\n\npara text`;
    const { container } = render(<>{renderMarkdown(md)}</>);
    expect(container.querySelector('h1')?.textContent).toContain('Title');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('em')?.textContent).toBe('italic');
    expect(container.querySelector('code')?.textContent).toBe('code');
    expect(container.querySelectorAll('ul > li').length).toBe(2);
    expect(container.querySelector('blockquote')?.textContent).toContain('quoted');
    expect(container.querySelector('hr')).not.toBeNull();
  });

  it('renders a fenced code block with a language chip-less pre (language stored on the block)', () => {
    const { container } = render(<>{renderMarkdown('```rust\nfn main() {}\n```')}</>);
    const pre = container.querySelector('pre');
    expect(pre?.querySelector('code')?.textContent).toBe('fn main() {}');
  });

  it('renders an ordered list', () => {
    const { container } = render(<>{renderMarkdown('1. first\n2. second')}</>);
    expect(container.querySelectorAll('ol > li').length).toBe(2);
  });

  it('handles empty input', () => {
    const { container } = render(<>{renderMarkdown('')}</>);
    expect(container.textContent).toBe('');
  });

  it('is bounded on a large input (10k paragraphs)', () => {
    const big = Array.from({ length: 10_000 }, (_, i) => `paragraph ${i}`).join('\n\n');
    const start = performance.now();
    const { container } = render(<>{renderMarkdown(big)}</>);
    const elapsed = performance.now() - start;
    expect(container.querySelectorAll('p').length).toBe(10_000);
    expect(elapsed).toBeLessThan(2000); // generous bound for jsdom under test
  });
});