import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AppSummary, Artifact, ConversationSummary, DeckSummary, DraftSummary } from '../ipc/contracts';
import { listAllArtifacts, listDecks, listDrafts } from '../ipc/client';
import { buildArtifactItems, countByTab, filterArtifactItems } from '../artifacts/artifactItems';
import { ArtifactsPage } from './ArtifactsPage';

vi.mock('../ipc/client', () => ({
  listAllArtifacts: vi.fn(),
  listDecks: vi.fn(),
  listDrafts: vi.fn(),
}));

function artifact(id: string, kind: Artifact['kind'], over: Partial<Artifact> = {}): Artifact {
  return { id, conversationId: 'c1', kind, title: `${kind} ${id}`, createdAt: '2026-11-01T10:00:00Z', ...over };
}
const deck = (id: string, over: Partial<DeckSummary> = {}): DeckSummary =>
  ({ id, title: `Deck ${id}`, themeName: 'Plain', slideCount: 5, stage: 'slides', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-11-03T10:00:00Z', ...over }) as DeckSummary;
const draft = (id: string, over: Partial<DraftSummary> = {}): DraftSummary =>
  ({ id, title: `Draft ${id}`, stage: 'draft', words: 300, updatedAt: '2026-11-02T10:00:00Z', ...over }) as DraftSummary;
const app = (id: string, over: Partial<AppSummary> = {}): AppSummary =>
  ({ id, name: `App ${id}`, category: 'tools', lastOpenedAt: '2026-11-04T10:00:00Z', createdAt: '2026-10-01T00:00:00Z', ...over }) as AppSummary;
const chat = (id: string, title: string): ConversationSummary =>
  ({ id, displayTitle: title, updatedAt: '2026-11-01T00:00:00Z', messageCount: 2 }) as ConversationSummary;

describe('artifact items', () => {
  const items = buildArtifactItems(
    [
      artifact('h', 'html', { updatedAt: '2026-11-05T10:00:00Z' }),
      artifact('s', 'spreadsheet'),
      artifact('i', 'image'),
      artifact('m', 'markdown'),
      artifact('j', 'json', { title: '  ' }),
    ],
    [deck('d')],
    [draft('w')],
    [app('a')],
    [chat('c1', 'Budget chat')],
  );

  it('sorts every kind into its tab; code and data only show under All', () => {
    expect(countByTab(items)).toEqual({ all: 8, pages: 2, decks: 1, documents: 2, sheets: 1, images: 1 });
    const json = items.find((i) => i.key === 'artifact:j')!;
    expect(json.tab).toBeNull();
    expect(json.title).toBeNull();
    expect(json.chatTitle).toBe('Budget chat');
  });

  it('decodes the HTML entities a page title carries', () => {
    const [item] = buildArtifactItems([artifact('e', 'html', { title: 'Maple &amp; Rye &#8212; Menu &bogus;' })], [], [], [], []);
    expect(item.title).toBe('Maple & Rye — Menu &bogus;');
  });

  it('filters by tab and search (title or chat), newest first or by name', () => {
    expect(filterArtifactItems(items, 'pages', '', 'recent', 'Untitled').map((i) => i.key)).toEqual(['artifact:h', 'app:a']);
    expect(filterArtifactItems(items, 'all', 'budget', 'recent', 'Untitled')).toHaveLength(5);
    expect(filterArtifactItems(items, 'documents', '', 'name', 'Untitled').map((i) => i.title)).toEqual(['Draft w', 'markdown m']);
  });
});

describe('ArtifactsPage', () => {
  beforeEach(() => {
    vi.mocked(listAllArtifacts).mockResolvedValue([artifact('h', 'html'), artifact('s', 'spreadsheet')]);
    vi.mocked(listDecks).mockResolvedValue([deck('d')]);
    vi.mocked(listDrafts).mockResolvedValue([]);
  });
  afterEach(() => vi.clearAllMocks());

  const renderPage = () => {
    const onOpen = vi.fn();
    const onMakeNew = vi.fn();
    render(<ArtifactsPage conversations={[chat('c1', 'Budget chat')]} savedApps={[app('a')]} onOpen={onOpen} onMakeNew={onMakeNew} />);
    return { onOpen, onMakeNew };
  };

  it('lists everything made, with a count on each tab', async () => {
    renderPage();
    expect(await screen.findByRole('button', { name: /html h/ })).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent);
    expect(tabs).toEqual(['All4', 'Pages & apps2', 'Decks1', 'Documents0', 'Spreadsheets1', 'Images0']);
    expect(screen.getByText(/Page · .* · from “Budget chat”/)).toBeInTheDocument();
  });

  it('switches tabs, searches, and opens an item where it lives', async () => {
    const { onOpen } = renderPage();
    await screen.findByRole('button', { name: /html h/ });
    fireEvent.click(screen.getByRole('tab', { name: /Decks/ }));
    const list = within(screen.getByRole('tabpanel'));
    expect(list.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(list.getByRole('button', { name: /Deck d/ }));
    expect(onOpen).toHaveBeenCalledWith({ type: 'deck', id: 'd' });
    fireEvent.click(screen.getByRole('tab', { name: /All/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search artifacts' }), { target: { value: 'nothing like it' } });
    expect(screen.getByText('Nothing matches “nothing like it”.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search artifacts' }), { target: { value: 'spreadsheet' } });
    fireEvent.click(screen.getByRole('button', { name: /spreadsheet s/ }));
    expect(onOpen).toHaveBeenCalledWith({ type: 'artifact', conversationId: 'c1', artifactId: 's' });
  });

  it('moves between tabs with the arrow keys', async () => {
    renderPage();
    await screen.findByRole('button', { name: /html h/ });
    const all = screen.getByRole('tab', { name: /All/ });
    fireEvent.keyDown(all, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /Pages & apps/ })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(all, { key: 'End' });
    expect(screen.getByRole('tab', { name: /Images/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('sends someone with nothing yet to Home to make something', async () => {
    vi.mocked(listAllArtifacts).mockResolvedValue([]);
    vi.mocked(listDecks).mockResolvedValue([]);
    const onMakeNew = vi.fn();
    render(<ArtifactsPage conversations={[]} savedApps={[]} onOpen={vi.fn()} onMakeNew={onMakeNew} />);
    await waitFor(() => expect(screen.getByText('Nothing made yet')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Make something new' }));
    expect(onMakeNew).toHaveBeenCalled();
  });
});
