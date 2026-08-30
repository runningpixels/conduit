import { describe, expect, it, vi } from 'vitest';
import { render, waitFor, screen } from '@testing-library/react';
import { ChatProse } from './ChatProse';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({
      svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    })),
  },
}));

describe('ChatProse mermaid and math fences', () => {
  it('renders a closed mermaid fence as a diagram image', async () => {
    const src = '```mermaid\nflowchart TD\nA-->B\n```';
    const { container } = render(<ChatProse content={src} />);
    await waitFor(() => {
      expect(container.querySelector('img.md-mermaid-img')).not.toBeNull();
    });
    expect(container.querySelector('.inline-code-block')).toBeNull();
  });

  it('keeps a streaming mermaid fence as source', () => {
    const src = '```mermaid\nflowchart TD\nA-->B\n```';
    const { container } = render(<ChatProse content={src} streaming />);
    expect(container.querySelector('.inline-code-block')).not.toBeNull();
    expect(container.querySelector('img.md-mermaid-img')).toBeNull();
    expect(screen.getByText('mermaid')).toBeInTheDocument();
  });

  it('renders a math fence as KaTeX', () => {
    const { container } = render(<ChatProse content={'```math\nE=mc^2\n```'} />);
    expect(container.querySelector('.md-katex-block')).not.toBeNull();
    expect(container.querySelector('.katex')).not.toBeNull();
  });

  it('renders inline math in prose', () => {
    const { container } = render(<ChatProse content={'Energy is $E=mc^2$.'} />);
    expect(container.querySelector('.katex')).not.toBeNull();
  });
});
