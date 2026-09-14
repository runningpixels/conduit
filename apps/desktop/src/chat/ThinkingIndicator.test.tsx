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
        }}
        lastActivityAt={Date.now()}
      />,
    );
    expect(screen.getByText('Writing “Plan”…')).toBeInTheDocument();
    expect(screen.getByText('12 lines · 1 KB')).toBeInTheDocument();
    expect(screen.queryByText(/still working/)).not.toBeInTheDocument();
  });

  it('counts the seconds of silence once the stream has gone quiet', () => {
    render(
      <ThinkingIndicator
        phase={{ label: 'Thinking…', round: 1, subPhase: 'thinking' }}
        lastActivityAt={Date.now() - 18_000}
      />,
    );
    expect(screen.getByText('still working · 18s')).toBeInTheDocument();
  });

  it('says why after half a minute of silence', () => {
    render(
      <ThinkingIndicator
        phase={{ label: 'Thinking…', round: 1, subPhase: 'thinking' }}
        lastActivityAt={Date.now() - 42_000}
      />,
    );
    expect(
      screen.getByText('still working · 42s — some models send long responses all at once'),
    ).toBeInTheDocument();
  });

  it('explains the silence up front for a model known to hold documents back', () => {
    render(
      <ThinkingIndicator
        phase={{ label: 'Thinking…', round: 1, subPhase: 'thinking' }}
        lastActivityAt={Date.now() - 12_000}
        heldDocument
      />,
    );
    expect(
      screen.getByText('still working · 12s — this model sends documents all at once'),
    ).toBeInTheDocument();
  });

  it('joins write progress and the silence notice', () => {
    render(
      <ThinkingIndicator
        phase={{ label: 'Writing HTML document…', round: 1, subPhase: 'writing_document', detail: '3 lines · 90 B' }}
        lastActivityAt={Date.now() - 12_000}
      />,
    );
    expect(screen.getByText('3 lines · 90 B · still working · 12s')).toBeInTheDocument();
  });
});
