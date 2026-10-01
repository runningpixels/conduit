import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DeckSummary } from '../ipc/contracts';
import { SlidesPage } from './SlidesPage';
import { STARTER_THEMES } from '../slides/themes';

const ipc = vi.hoisted(() => ({
  listDecks: vi.fn(),
  createDeck: vi.fn(),
  renameDeck: vi.fn(),
  deleteDeck: vi.fn(),
  listSlideThemes: vi.fn(),
}));

vi.mock('../ipc/client', () => ipc);

const deck: DeckSummary = {
  id: 'd1',
  title: 'Q3 review',
  themeName: 'ink',
  slideCount: 4,
  stage: 'slides',
  conversationId: 'c1',
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T11:00:00Z',
};

beforeEach(() => {
  Object.values(ipc).forEach((fn) => fn.mockReset());
  ipc.listDecks.mockResolvedValue([deck]);
  ipc.listSlideThemes.mockResolvedValue([]);
});

describe('SlidesPage', () => {
  it('lists decks and opens one', async () => {
    const onOpenDeck = vi.fn();
    render(<SlidesPage onOpenDeck={onOpenDeck} />);
    expect(await screen.findByText('Q3 review')).toBeTruthy();
    expect(screen.getByText(/4 slides/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Q3 review' }));
    expect(onOpenDeck).toHaveBeenCalledWith(deck);
  });

  it('shows the empty state', async () => {
    ipc.listDecks.mockResolvedValue([]);
    render(<SlidesPage onOpenDeck={() => {}} />);
    expect(await screen.findByText('No decks yet')).toBeTruthy();
  });

  it('creates a deck with the chosen theme and opens it', async () => {
    const detail = { ...deck, id: 'd2', themeCss: '', storyline: [], slides: [] };
    ipc.createDeck.mockResolvedValue(detail);
    const onOpenDeck = vi.fn();
    render(<SlidesPage onOpenDeck={onOpenDeck} />);
    await screen.findByText('Q3 review');
    fireEvent.click(screen.getByRole('button', { name: 'New deck' }));
    fireEvent.change(screen.getByLabelText('Deck title'), { target: { value: 'Launch plan' } });
    fireEvent.click(screen.getByRole('radio', { name: /Paper/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create deck' }));
    const paper = STARTER_THEMES.find((t) => t.name === 'paper')!;
    await waitFor(() => expect(ipc.createDeck).toHaveBeenCalledWith('Launch plan', 'paper', paper.css));
    await waitFor(() => expect(onOpenDeck).toHaveBeenCalledWith(detail));
  });

  it('renames inline', async () => {
    ipc.renameDeck.mockResolvedValue(undefined);
    render(<SlidesPage onOpenDeck={() => {}} />);
    await screen.findByText('Q3 review');
    fireEvent.click(screen.getByRole('button', { name: 'Rename Q3 review' }));
    const input = screen.getByRole('textbox', { name: 'Rename Q3 review' });
    fireEvent.change(input, { target: { value: 'Q4 review' } });
    fireEvent.blur(input);
    await waitFor(() => expect(ipc.renameDeck).toHaveBeenCalledWith('d1', 'Q4 review'));
  });

  it('confirms before deleting', async () => {
    ipc.deleteDeck.mockResolvedValue(undefined);
    const onStatus = vi.fn();
    render(<SlidesPage onOpenDeck={() => {}} onStatus={onStatus} />);
    await screen.findByText('Q3 review');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Q3 review' }));
    expect(ipc.deleteDeck).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete deck' }));
    await waitFor(() => expect(ipc.deleteDeck).toHaveBeenCalledWith('d1'));
  });
});
