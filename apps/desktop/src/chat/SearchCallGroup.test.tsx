import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchCallGroup } from './SearchCallGroup';
import type { ToolCallState } from './streamState';

function makeSearchCall(id: string, query: string, complete = false): ToolCallState {
  return {
    toolCallId: id,
    toolId: 'web_search',
    name: 'web_search',
    argumentsText: '',
    arguments: { query },
    complete,
    sources: complete ? [{ raw: { url: 'https://example.com', title: 'Example' } }] : undefined,
  };
}

function toolFor(button: HTMLElement): HTMLElement | null {
  return button.closest('.tool');
}

describe('SearchCallGroup', () => {
  it('keeps the query list collapsed by default (§8.4 — one level, user-opened)', () => {
    const toolCalls = [makeSearchCall('ws-1', 'first query', true)];
    render(<SearchCallGroup toolCalls={toolCalls} cost={1} />);

    const head = screen.getByRole('button', { name: /Web search/i });
    expect(toolFor(head)).toHaveAttribute('data-open', 'false');
    // The collapsed head answers "did it do the right thing?" without the query dump.
    expect(screen.getByText(/1 query/)).toBeInTheDocument();
    // The query rows are visually collapsed (grid-rows 0fr), not removed.
    expect(toolFor(head)?.querySelector('.tool-body')).not.toBeNull();
  });

  it('does not auto-expand when a new query is added', () => {
    const initial = [makeSearchCall('ws-1', 'first query', true)];
    const { rerender } = render(<SearchCallGroup toolCalls={initial} cost={1} />);

    expect(toolFor(screen.getByRole('button', { name: /Web search/i }))).toHaveAttribute(
      'data-open',
      'false',
    );

    rerender(
      <SearchCallGroup
        toolCalls={[...initial, makeSearchCall('ws-2', 'second query', false)]}
        cost={2}
      />,
    );

    expect(toolFor(screen.getByRole('button', { name: /Web search/i }))).toHaveAttribute(
      'data-open',
      'false',
    );
    expect(screen.getByText(/2 queries/)).toBeInTheDocument();
    // Collapsed = hidden via the 0fr grid row, not absent from the DOM.
    expect(screen.getByText('second query')).toBeInTheDocument();
  });

  it('expands the flat query list only when the user clicks the head', () => {
    const toolCalls = [
      makeSearchCall('ws-1', 'first query', true),
      makeSearchCall('ws-2', 'second query', true),
    ];
    render(<SearchCallGroup toolCalls={toolCalls} cost={2} />);

    fireEvent.click(screen.getByRole('button', { name: /Web search/i }));

    expect(toolFor(screen.getByRole('button', { name: /Web search/i }))).toHaveAttribute(
      'data-open',
      'true',
    );
    expect(screen.getByText('first query')).toBeInTheDocument();
    expect(screen.getByText('second query')).toBeInTheDocument();
  });

  it('renders unavailable notice when search is unavailable', () => {
    render(
      <SearchCallGroup
        toolCalls={[makeSearchCall('ws-1', 'query', true)]}
        unavailable={{ code: 'disabled', message: 'Provider does not support search.' }}
      />,
    );

    expect(screen.getByText(/Web search unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/Provider does not support search/i)).toBeInTheDocument();
  });
});
