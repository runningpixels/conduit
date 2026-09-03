import { describe, expect, it, beforeEach } from 'vitest';
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
    expect(screen.getByText(/Thought for \d+s/)).toBeInTheDocument();
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
