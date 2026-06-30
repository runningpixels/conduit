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

describe('SearchCallGroup', () => {
  it('keeps search query details collapsed by default', () => {
    const toolCalls = [makeSearchCall('ws-1', 'first query', true)];
    render(<SearchCallGroup toolCalls={toolCalls} cost={1} />);

    const details = screen.getByText('Search queries').closest('details');
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByText('first query', { selector: '.search-query-preview .search-query' })).toBeInTheDocument();
  });

  it('does not auto-expand when a new query is added', () => {
    const initial = [makeSearchCall('ws-1', 'first query', true)];
    const { rerender } = render(<SearchCallGroup toolCalls={initial} cost={1} />);

    const details = screen.getByText('Search queries').closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);

    rerender(
      <SearchCallGroup
        toolCalls={[...initial, makeSearchCall('ws-2', 'second query', false)]}
        cost={2}
      />,
    );

    expect(details.open).toBe(false);
    expect(screen.getByText('second query', { selector: '.search-query-preview .search-query' })).toBeInTheDocument();
  });

  it('expands query list only when the user opens details', () => {
    const toolCalls = [
      makeSearchCall('ws-1', 'first query', true),
      makeSearchCall('ws-2', 'second query', true),
    ];
    render(<SearchCallGroup toolCalls={toolCalls} cost={2} />);

    const summary = screen.getByText('Search queries');
    fireEvent.click(summary);

    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(screen.getAllByText('first query').length).toBeGreaterThan(0);
    expect(screen.getAllByText('second query').length).toBeGreaterThan(0);
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
