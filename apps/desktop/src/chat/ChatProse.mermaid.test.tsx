import { describe, expect, it, vi } from 'vitest';
import { render, waitFor, screen } from '@testing-library/react';
import { ChatProse } from './ChatProse';

const NL = String.fromCharCode(10);

const mermaidRender = vi.fn(async (_id: string, text: string) => {
  // Stand in for the real parser closely enough to matter: it rejects anything
  // that is not a diagram, and — as 11.17.2 does with `suppressErrorRendering`
  // off — it leaves its error diagram behind in `document.body` on the way out.
  const keyword = text.trim().split(/[^A-Za-z]/)[0];
  if (!['flowchart', 'graph', 'sequenceDiagram'].includes(keyword)) {
    const orphan = document.createElement('div');
    orphan.id = `d${_id}`;
    orphan.textContent = 'Syntax error in text';
    document.body.appendChild(orphan);
    throw new Error('No diagram type detected');
  }
  return { svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' };
});

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: (id: string, text: string) => mermaidRender(id, text),
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

  it('never renders a half-arrived mermaid fence while the message streams', async () => {
    // Replay the message a token at a time, the way it actually reached the
    // transcript. `parseMessageSegments` hands a fence with an empty body back
    // to the prose path, which had no streaming guard — so the instant the
    // opening delimiter arrived, mermaid was asked to parse ''. It threw, and
    // left a bomb graphic at the end of the page. StrictMode made it two.
    mermaidRender.mockClear();
    const full = ['```mermaid', 'sequenceDiagram', '  U->>C: prompt', '```'].join(NL);
    for (let n = 1; n < full.length; n++) {
      const { unmount } = render(<ChatProse content={full.slice(0, n)} streaming />);
      unmount();
    }
    // Mermaid is only ever handed the finished diagram — never '' (which is
    // what the opening delimiter alone parsed to) and never a partial body.
    const body = ['sequenceDiagram', '  U->>C: prompt'].join(NL);
    for (const [, text] of mermaidRender.mock.calls) {
      expect(text).toBe(body);
    }
    expect(document.body.querySelector('[id^="dconduitMmd"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Syntax error in text');
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
