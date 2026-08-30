import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { MermaidBlock } from './MermaidBlock';

const renderFn = vi.fn(async (_id: string, _text: string) => ({
  svg: '<svg xmlns="http://www.w3.org/2000/svg" data-testid="mermaid-svg"></svg>',
}));
const initialize = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize,
    render: (id: string, text: string) => renderFn(id, text),
  },
}));

describe('MermaidBlock', () => {
  beforeEach(() => {
    renderFn.mockClear();
    initialize.mockClear();
    renderFn.mockImplementation(async (_id: string, _text: string) => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg" data-testid="mermaid-svg"></svg>',
    }));
  });

  it('renders the diagram as a blob image, not inline SVG markup', async () => {
    const { container } = render(<MermaidBlock source={'flowchart TD\nA-->B'} />);
    const img = await waitFor(() => {
      const el = container.querySelector('img.md-mermaid-img');
      expect(el).not.toBeNull();
      return el as HTMLImageElement;
    });
    expect(img.src).toMatch(/^blob:/);
    expect(container.querySelector('svg[data-testid="mermaid-svg"]')).toBeNull();
    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({ startOnLoad: false, securityLevel: 'strict' }),
    );
  });

  it('falls back to source when mermaid throws', async () => {
    renderFn.mockRejectedValueOnce(new Error('parse'));
    const { container } = render(
      <MermaidBlock source={'not a diagram'} fallback={<pre>not a diagram</pre>} />,
    );
    await waitFor(() => {
      expect(container.querySelector('.md-render-error')).not.toBeNull();
    });
    expect(container.textContent).toContain('not a diagram');
    expect(container.querySelector('img.md-mermaid-img')).toBeNull();
  });

  it('copies source from the toolbar', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = render(<MermaidBlock source={'flowchart TD\nA-->B'} />);
    await waitFor(() => expect(container.querySelector('img.md-mermaid-img')).not.toBeNull());
    fireEvent.click(container.querySelector('.md-mermaid-copy')!);
    expect(writeText).toHaveBeenCalledWith('flowchart TD\nA-->B');
  });
});
