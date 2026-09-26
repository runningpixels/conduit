import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import type { ChatTurn } from '../chat/conversationHydration';
import { createAssistantStreamState, type AssistantStreamState, type ToolCallState } from '../chat/streamState';
import { ActivityView } from './ActivityView';
import { SourcesView } from './SourcesView';
import { InspectorTabs, type InspectorTab } from './InspectorTabs';

const openExternalUrl = vi.fn(async (_url: string) => undefined);
vi.mock('../ipc/client', () => ({
  openExternalUrl: (url: string) => openExternalUrl(url),
  getKnowledgePassage: vi.fn(async () => null),
}));

function state(over: Partial<AssistantStreamState> = {}): AssistantStreamState {
  return { ...createAssistantStreamState('req'), streaming: false, ...over };
}

function call(over: Partial<ToolCallState> & { toolCallId: string; name: string }): ToolCallState {
  return { toolId: over.name, argumentsText: '', complete: true, status: 'completed', ...over };
}

const user = (id: string): ChatTurn => ({ id, role: 'user', content: 'q' });
const assistant = (id: string, s?: AssistantStreamState): ChatTurn => ({
  id,
  role: 'assistant',
  content: '',
  streamState: s,
});

const searchTurn = assistant(
  'a1',
  state({
    toolCalls: [
      call({
        toolCallId: 's1',
        name: 'web_search',
        arguments: { query: 'rust async' },
        sources: [{ raw: { title: 'Tokio tutorial', url: 'https://tokio.rs/tutorial' } }],
      }),
    ],
    usage: { inputTokens: 100n, outputTokens: 20n },
  }),
);

const docTurn = assistant(
  'a2',
  state({
    toolCalls: [
      call({
        toolCallId: 'd1',
        name: 'write_html_document',
        arguments: { title: 'Q3 report', html: '<p>x</p>' },
        startedAt: 0,
        endedAt: 2400,
      }),
    ],
    usage: { inputTokens: 50n, outputTokens: 5n },
  }),
);

describe('ActivityView', () => {
  it('shows an empty state when nothing happened', () => {
    render(<ActivityView turns={[user('u1'), assistant('a1')]} />);
    expect(screen.getByText(/No steps yet/)).toBeInTheDocument();
  });

  it('shows the latest turn as a timeline, earlier turns collapsed', () => {
    render(<ActivityView turns={[user('u1'), searchTurn, user('u2'), docTurn]} />);
    const steps = document.querySelectorAll('.activity-steps .activity-step');
    expect(steps).toHaveLength(1);
    expect(steps[0].querySelector('.activity-step-name')?.textContent).toBe('write_html_document');
    expect(steps[0].textContent).toContain('Q3 report');
    expect(steps[0].querySelector('.activity-step-dur')?.textContent).toBe('2.4s');
    expect(screen.getByText('Turn 2')).toBeInTheDocument();

    const row = screen.getByRole('button', { name: /Turn 1 · 1 step/ });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelectorAll('.activity-step')).toHaveLength(2);
  });

  it('focuses the requested turn and lists its searches', () => {
    render(<ActivityView turns={[user('u1'), searchTurn, user('u2'), docTurn]} focusTurnId="a1" />);
    expect(screen.getByText('Turn 1')).toBeInTheDocument();
    expect(screen.getByText('Web search')).toBeInTheDocument();
    expect(screen.getAllByText('rust async').length).toBeGreaterThan(0);
  });

  it('selects an earlier turn', () => {
    const onSelectTurn = vi.fn();
    render(<ActivityView turns={[searchTurn, docTurn]} onSelectTurn={onSelectTurn} />);
    fireEvent.click(screen.getByRole('button', { name: /Turn 1/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Show this turn' }));
    expect(onSelectTurn).toHaveBeenCalledWith('a1');
    expect(screen.getByText('Turn 1')).toBeInTheDocument();
  });

  it('summarises the chat: tools, sites the page contacted and usage', () => {
    render(
      <ActivityView
        turns={[searchTurn, docTurn]}
        networkLog={[
          { origin: 'https://api.example.com', method: 'GET', url: 'https://api.example.com/a', status: 200 },
          { origin: 'https://api.example.com', method: 'GET', url: 'https://api.example.com/b', status: 500 },
          { origin: 'https://cdn.example.net', method: 'GET', url: 'https://cdn.example.net/x', status: 200 },
        ]}
      />,
    );
    expect(screen.getByText('This chat')).toBeInTheDocument();
    expect(screen.getByText('https://api.example.com').closest('li')?.textContent).toContain('2 requests · 1 failed');
    expect(screen.getByText('https://cdn.example.net').closest('li')?.textContent).toContain('1 request');
    expect(document.querySelector('.activity-usage')?.textContent).toContain('in: 150');
    expect(document.querySelector('.activity-usage')?.textContent).toContain('2 turns');
  });

  it('shows the network log even with no tool steps', () => {
    render(
      <ActivityView
        turns={[assistant('a1')]}
        networkLog={[{ origin: 'https://x.test', method: 'GET', url: 'https://x.test/' }]}
      />,
    );
    expect(screen.queryByText(/No steps yet/)).toBeNull();
    expect(screen.getByText('https://x.test')).toBeInTheDocument();
  });
});

describe('SourcesView', () => {
  beforeEach(() => openExternalUrl.mockClear());

  it('shows an empty state', () => {
    render(<SourcesView turns={[user('u1'), assistant('a1')]} />);
    expect(screen.getByText(/No sources yet/)).toBeInTheDocument();
  });

  it('lists web sources by turn, newest first, and opens them through the safe link flow', () => {
    const later = assistant(
      'a2',
      state({
        blocks: [
          {
            blockId: 'b',
            blockKind: 'text',
            content: 'x',
            citations: [{ index: 1, url: 'https://news.example.org/a', title: 'News', startIndex: 0, endIndex: 1 }],
          },
        ],
      }),
    );
    render(<SourcesView turns={[user('u1'), searchTurn, user('u2'), later]} />);
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Turn 2', 'Turn 1']);
    const link = screen.getByRole('link', { name: /Tokio tutorial/ });
    expect(link).toHaveAttribute('href', 'https://tokio.rs/tutorial');
    expect(link.textContent).toContain('tokio.rs');
    fireEvent.click(link);
    expect(openExternalUrl).toHaveBeenCalledWith('https://tokio.rs/tutorial');
  });

  it('shows document citations under the turn that answered', () => {
    render(
      <SourcesView
        turns={[user('u1'), assistant('a1')]}
        knowledgeCitations={{
          u1: [
            { documentId: 'doc', documentTitle: 'Handbook', chunkId: 'k1', ordinal: 2, charStart: 0, charEnd: 5 },
          ],
        }}
      />,
    );
    expect(screen.getByText('Turn 1')).toBeInTheDocument();
    expect(screen.getByText(/Handbook/)).toBeInTheDocument();
  });

  it('ignores non-http source urls', () => {
    const odd = assistant(
      'a1',
      state({ searchSources: [{ raw: { title: 'Bad', url: 'javascript:alert(1)' } }] }),
    );
    render(<SourcesView turns={[odd]} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

function TabsHarness({ hasPage = true, onClose = () => {} }: { hasPage?: boolean; onClose?: () => void }) {
  const [tab, setTab] = useState<InspectorTab>(hasPage ? 'page' : 'activity');
  return (
    <InspectorTabs tab={tab} onTab={setTab} hasPage={hasPage} counts={{ activity: 3 }} onClose={onClose} />
  );
}

describe('InspectorTabs', () => {
  it('renders ARIA tabs with the selection and counts', () => {
    render(<TabsHarness />);
    const list = screen.getByRole('tablist', { name: 'Inspector' });
    const tabs = within(list).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual(['Page', 'Activity3', 'Sources']);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('aria-controls', 'inspector-panel-page');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
  });

  it('moves between tabs with the arrow keys, Home and End', () => {
    render(<TabsHarness />);
    const tabs = screen.getAllByRole('tab');
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /Activity/ })).toHaveAttribute('aria-selected', 'true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /Activity/ }));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Page' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Sources' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Page' })).toHaveAttribute('aria-selected', 'true');
  });

  it('offers no Page tab without a page', () => {
    render(<TabsHarness hasPage={false} />);
    expect(screen.queryByRole('tab', { name: 'Page' })).toBeNull();
    expect(screen.getByRole('tab', { name: /Activity/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('closes', () => {
    const onClose = vi.fn();
    render(<TabsHarness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close inspector' }));
    expect(onClose).toHaveBeenCalled();
  });
});
