import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MarkdownRenderer } from './renderers';

/// Performance/bound test (plan §7): a large markdown artifact renders in
/// bounded time and produces a bounded DOM. jsdom is slower than a real
/// browser, so the bound is generous; the goal is to catch quadratic blowups.

describe('large artifact rendering', () => {
  it('renders a ~5MB markdown document in bounded time', () => {
    // ~5 MB of paragraph text: 50k paragraphs of ~100 chars each.
    const para = 'The quick brown fox jumps over the lazy dog. '.repeat(2).trim();
    const big = Array.from({ length: 50_000 }, () => para).join('\n\n');
    expect(big.length).toBeGreaterThan(4_000_000);

    const start = performance.now();
    const { container } = render(<MarkdownRenderer source={big} />);
    const elapsed = performance.now() - start;

    expect(container.querySelectorAll('p').length).toBe(50_000);
    expect(elapsed).toBeLessThan(15_000); // generous jsdom bound
  });
});