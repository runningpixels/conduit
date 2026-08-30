import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { KatexHtml, renderKatexHtml } from './KatexHtml';

describe('renderKatexHtml', () => {
  it('renders inline TeX to HTML that contains katex markup', () => {
    const html = renderKatexHtml('E=mc^2', false);
    expect(html).toBeTruthy();
    expect(html).toContain('katex');
    expect(html).not.toContain('<script');
  });

  it('returns null for invalid TeX when throwOnError is on', () => {
    expect(renderKatexHtml('\\notacommand{}', false)).toBeNull();
  });
});

describe('KatexHtml security', () => {
  it('does not emit a <script> element from \\html', () => {
    const { container } = render(<KatexHtml tex={'\\html{<script>alert(1)</script>}'} />);
    expect(container.querySelector('script')).toBeNull();
  });

  it('does not emit a javascript: href from \\href', () => {
    const { container } = render(
      <KatexHtml tex={'\\href{javascript:alert(1)}{x}'} />,
    );
    const anchors = [...container.querySelectorAll('a')];
    expect(anchors.every((a) => !(a.getAttribute('href') ?? '').startsWith('javascript:'))).toBe(true);
  });

  it('falls back to source for invalid TeX', () => {
    const { container } = render(<KatexHtml tex={'\\notacommand{}'} fallback="FALLBACK" />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('.katex')).toBeNull();
    expect(container.textContent).toContain('FALLBACK');
  });
});

describe('KatexHtml structure', () => {
  it('renders a known formula', () => {
    const { container } = render(<KatexHtml tex={'a^2'} />);
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('uses display class for displayMode', () => {
    const { container } = render(<KatexHtml tex={'\\int x'} displayMode />);
    expect(container.querySelector('.md-katex-display')).not.toBeNull();
  });
});
