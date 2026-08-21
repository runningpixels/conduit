import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { CodeRenderer, JsonRenderer, PlainTextRenderer } from './renderers';

describe('PlainTextRenderer', () => {
  it('renders text in a <pre> (whitespace preserved, escaped)', () => {
    const { container } = render(<PlainTextRenderer text={'line1\nline2 <b>not bold</b>'} />);
    const pre = container.querySelector('pre');
    expect(pre?.textContent).toBe('line1\nline2 <b>not bold</b>');
    expect(container.querySelector('b')).toBeNull();
  });
});

describe('CodeRenderer', () => {
  it('renders a line-number gutter + language chip', () => {
    const { container } = render(<CodeRenderer code={'a\nb\nc'} language="rust" />);
    expect(container.querySelector('.lang-chip')?.textContent).toBe('rust');
    expect(container.querySelectorAll('.line-no').length).toBe(3);
    expect(container.querySelectorAll('.line-text').length).toBe(3);
  });

  it('falls back to a muted "text" chip when no language is given', () => {
    const { container } = render(<CodeRenderer code={'x'} />);
    expect(container.querySelector('.lang-chip')?.textContent).toBe('text');
  });

  it('renders a single (empty) line for empty code', () => {
    const { container } = render(<CodeRenderer code={''} />);
    expect(container.querySelectorAll('.line-no').length).toBe(1);
  });

  it('escapes HTML in the code (no injected markup)', () => {
    const { container } = render(<CodeRenderer code={'<script>alert(1)</script>'} language="html" />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });

  it('renders syntax-highlighted token spans for supported languages', () => {
    const { container } = render(<CodeRenderer code={'def main():\n  pass'} language="python" />);
    expect(container.querySelector('.keyword')?.textContent).toBe('def');
  });

  it('falls back to plain text for unsupported languages', () => {
    const { container } = render(<CodeRenderer code={'let x = 1'} language="funkylang" />);
    expect(container.querySelector('.keyword')).toBeNull();
    expect(container.querySelector('.line-text')?.textContent).toBe('let x = 1');
  });
});

describe('JsonRenderer', () => {
  it('renders an object tree with type-tinted value spans', () => {
    const data = { name: 'Conduit', count: 3, on: true, nothing: null, list: [1, 'two'] };
    const { container } = render(<JsonRenderer data={data} />);
    expect(container.querySelector('.json-key')?.textContent).toBe('"name"');
    expect(container.querySelector('.json-str')?.textContent).toBe('"Conduit"');
    expect(container.querySelector('.json-num')?.textContent).toBe('3');
    expect(container.querySelector('.json-bool')?.textContent).toBe('true');
    expect(container.querySelector('.json-null')?.textContent).toBe('null');
    // Nested array is a details node with a summary.
    expect(container.textContent).toContain('Array(2)');
  });

  it('renders an empty object and empty array compactly', () => {
    const { container } = render(<JsonRenderer data={{ empty: {}, list: [] }} />);
    expect(container.textContent).toContain('{ }');
    expect(container.textContent).toContain('[ ]');
  });

  it('renders a primitive (string) without crashing', () => {
    const { container } = render(<JsonRenderer data="hello" />);
    expect(container.querySelector('.json-str')?.textContent).toBe('"hello"');
  });
});