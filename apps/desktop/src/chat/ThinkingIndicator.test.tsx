import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThinkingIndicator } from './ThinkingIndicator';

describe('ThinkingIndicator', () => {
  it('does not double the ellipsis a phase label already carries', () => {
    render(
      <ThinkingIndicator phase={{ label: 'Thinking…', round: 1, subPhase: 'thinking' }} />,
    );
    expect(screen.getByText('Thinking…')).toBeInTheDocument();
  });

  it('shows document-write progress after the label', () => {
    render(
      <ThinkingIndicator
        phase={{
          label: 'Writing “Plan”…',
          round: 1,
          subPhase: 'writing_document',
          detail: '12 lines · 1 KB',
          lastActivityAt: Date.now(),
        }}
      />,
    );
    expect(screen.getByText('Writing “Plan”…')).toBeInTheDocument();
    expect(screen.getByText('12 lines · 1 KB')).toBeInTheDocument();
    expect(screen.queryByText(/still working/)).not.toBeInTheDocument();
  });

  it('adds "still working" when the write has been silent past the stall window', () => {
    render(
      <ThinkingIndicator
        phase={{
          label: 'Writing HTML document…',
          round: 1,
          subPhase: 'writing_document',
          lastActivityAt: Date.now() - 60_000,
        }}
      />,
    );
    expect(screen.getByText('still working')).toBeInTheDocument();
  });
});
