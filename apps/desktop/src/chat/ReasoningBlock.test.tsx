import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { ReasoningBlock } from './ReasoningBlock';
import { writeShowReasoning } from '../shell/uiPrefs';

function toggleDetails(details: HTMLDetailsElement, open: boolean) {
  details.open = open;
  details.dispatchEvent(new Event('toggle', { bubbles: true }));
}

describe('ReasoningBlock', () => {
  beforeEach(() => {
    localStorage.clear();
    writeShowReasoning('on');
  });

  it('starts expanded when always-show is on', () => {
    render(
      <ReasoningBlock
        block={{ blockId: 'r1', blockKind: 'reasoning', content: 'one two three four five', citations: [] }}
      />,
    );
    const details = document.querySelector('details.think') as HTMLDetailsElement;
    expect(details.open).toBe(true);
    // Rebuilt from the database: no timing was recorded, so no number is made up.
    expect(screen.getByText('Thought')).toBeInTheDocument();
  });

  it('reports the time the reasoning actually spanned', () => {
    // The old label estimated 15 words a second and capped it at 60, so ten
    // minutes of thinking read "Thought for 60s".
    const startedAt = 1_000_000;
    render(
      <ReasoningBlock
        block={{
          blockId: 'r1',
          blockKind: 'reasoning',
          content: 'a few words',
          citations: [],
          startedAt,
          lastDeltaAt: startedAt + 588_000,
        }}
      />,
    );
    expect(screen.getByText('Thought for 9m 48s')).toBeInTheDocument();
  });

  it('counts up while the model is still thinking', () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now() - 64_000;
      render(
        <ReasoningBlock
          live
          block={{ blockId: 'r1', blockKind: 'reasoning', content: 'hmm', citations: [], startedAt, lastDeltaAt: startedAt }}
        />,
      );
      expect(screen.getByText('Thinking… 1m 4s')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByText('Thinking… 1m 6s')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('survives a parent re-render after the user collapses the chip', () => {
    const block = {
      blockId: 'r1',
      blockKind: 'reasoning',
      content: 'stream token one',
      citations: [] as [],
    };
    const { rerender } = render(<ReasoningBlock block={block} />);
    const details = document.querySelector('details.think') as HTMLDetailsElement;
    expect(details.open).toBe(true);

    act(() => {
      toggleDetails(details, false);
    });
    expect(details.open).toBe(false);

    rerender(
      <ReasoningBlock
        block={{ ...block, content: 'stream token one two three four five six' }}
      />,
    );
    expect((document.querySelector('details.think') as HTMLDetailsElement).open).toBe(false);
  });

  it('follows a settings flip while mounted', () => {
    render(
      <ReasoningBlock
        block={{ blockId: 'r1', blockKind: 'reasoning', content: 'hello world again here', citations: [] }}
      />,
    );
    const details = () => document.querySelector('details.think') as HTMLDetailsElement;
    expect(details().open).toBe(true);

    act(() => {
      writeShowReasoning('off');
    });
    expect(details().open).toBe(false);

    act(() => {
      writeShowReasoning('on');
    });
    expect(details().open).toBe(true);
  });
});
