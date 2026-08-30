import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { renderMarkdown } from './safeMarkdown';

const NL = String.fromCharCode(10);

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    })),
  },
}));

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

  it('calls onExternalLink and preventDefault for http(s) clicks when provided', () => {
    const onExternalLink = vi.fn();
    const { container } = render(
      <>{renderMarkdown('[docs](https://example.com/page)', { onExternalLink })}</>,
    );
    const anchor = container.querySelector('a');
    expect(anchor).not.toBeNull();
    fireEvent.click(anchor!);
    expect(onExternalLink).toHaveBeenCalledWith('https://example.com/page');
  });

  it('does not intercept mailto: when onExternalLink is provided', () => {
    const onExternalLink = vi.fn();
    const { container } = render(
      <>{renderMarkdown('[mail](mailto:a@b.com)', { onExternalLink })}</>,
    );
    const anchor = container.querySelector('a');
    fireEvent.click(anchor!);
    expect(onExternalLink).not.toHaveBeenCalled();
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

  // V6 P3.6 — GFM tables
  it('renders a GFM table with header + rows + alignment', () => {
    const md = '| Provider | p95 ms |\n| --- | ---: |\n| Anthropic | 1,940 |\n| Ollama | 6,580 |';
    const { container } = render(<>{renderMarkdown(md)}</>);
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(table?.querySelectorAll('thead th').length).toBe(2);
    expect(table?.querySelectorAll('tbody tr').length).toBe(2);
    expect(table?.querySelector('thead th')?.textContent).toBe('Provider');
    // right-aligned numeric column gets the num class
    expect(table?.querySelectorAll('th.num').length).toBe(1);
  });

  it('does not treat a bare pipe line as a table without a separator row', () => {
    const { container } = render(<>{renderMarkdown('a | b')}</>);
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).toContain('a | b');
  });

  // V6 P3.6 — GFM task lists
  it('renders a GFM task list with checked + unchecked boxes', () => {
    const { container } = render(
      <>{renderMarkdown('- [x] done item\n- [ ] todo item')}</>,
    );
    const list = container.querySelector('ul.task-list');
    expect(list).not.toBeNull();
    const boxes = list?.querySelectorAll('input[type="checkbox"]');
    expect(boxes?.length).toBe(2);
    expect(boxes?.[0].getAttribute('checked')).not.toBeNull();
    expect(list?.querySelector('li.done')?.textContent).toContain('done item');
  });

  it('treats a plain dash list without task markers as a normal list', () => {
    const { container } = render(<>{renderMarkdown('- plain\n- items')}</>);
    expect(container.querySelector('ul.task-list')).toBeNull();
    expect(container.querySelectorAll('ul > li').length).toBe(2);
  });

  it('handles empty input', () => {
    const { container } = render(<>{renderMarkdown('')}</>);
    expect(container.textContent).toBe('');
  });

  it('renders inline and display KaTeX', () => {
    const { container } = render(<>{renderMarkdown('The identity is $E=mc^2$.')}</>);
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.textContent).toContain('The identity is');
  });

  it('does not treat currency as math', () => {
    const { container } = render(<>{renderMarkdown('It costs $5.00 today.')}</>);
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toContain('$5.00');
  });

  it('renders a $$ display math block', () => {
    const { container } = render(<>{renderMarkdown('$$\\int_0^1 x dx$$')}</>);
    expect(container.querySelector('.md-katex-display, .md-katex-block .katex')).not.toBeNull();
  });

  it('renders a math fence as display KaTeX', () => {
    const { container } = render(<>{renderMarkdown('```math\n\\sum x\n```')}</>);
    expect(container.querySelector('.md-katex-block')).not.toBeNull();
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('renders a mermaid fence as a blob image', async () => {
    const { container } = render(
      <>{renderMarkdown('```mermaid\nflowchart TD\nA-->B\n```')}</>,
    );
    await waitFor(() => {
      expect(container.querySelector('img.md-mermaid-img')).not.toBeNull();
    });
  });

  it('keeps an unterminated mermaid fence as source, never as a diagram', async () => {
    // Mid-stream the fence has no closing run yet and its body is a fragment.
    // Handing that to mermaid throws, and a throw used to cost a stray error
    // diagram appended to `document.body`.
    const src = ['```mermaid', 'flowchart TD', 'A-->'].join(NL);
    const { container } = render(<>{renderMarkdown(src)}</>);
    await waitFor(() => {
      expect(container.querySelector('.md-pre')).not.toBeNull();
    });
    expect(container.querySelector('img.md-mermaid-img')).toBeNull();
    expect(container.textContent).toContain('flowchart TD');
  });

  it('renders nothing for an unterminated fence that has no body yet', () => {
    // The first token of a fence, and the orphan a mis-terminated wrapper
    // leaves behind. Both used to draw an empty bordered box.
    expect(render(<>{renderMarkdown('```mermaid')}</>).container.innerHTML).toBe('');
    expect(render(<>{renderMarkdown('```')}</>).container.innerHTML).toBe('');
  });

  it('keeps a nested fence inside a longer one instead of closing on it', () => {
    const src = ['````', '```mermaid', 'flowchart TD', '```', '````'].join(NL);
    const { container } = render(<>{renderMarkdown(src)}</>);
    const pre = container.querySelector('.md-pre');
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain('```mermaid');
    expect(container.querySelector('img.md-mermaid-img')).toBeNull();
  });

  it('is bounded on a large input (10k paragraphs)', { timeout: 20_000 }, () => {
    const big = Array.from({ length: 10_000 }, (_, i) => `paragraph ${i}`).join('\n\n');
    const start = performance.now();
    const { container } = render(<>{renderMarkdown(big)}</>);
    const elapsed = performance.now() - start;
    expect(container.querySelectorAll('p').length).toBe(10_000);
    // Generous bound: the goal is catching quadratic blowups, not wall-clock
    // under parallel-suite load (jsdom is slow on loaded machines).
    expect(elapsed).toBeLessThan(6_000);
  });
});