import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DeckSummary } from '../ipc/contracts';
import { SlidesPage } from './SlidesPage';
import { STARTER_THEMES } from '../slides/themes';

const ipc = vi.hoisted(() => ({
  listDecks: vi.fn(),
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

const STORY = "What's the story?";

describe('SlidesPage', () => {
  it('lists decks and opens one', async () => {
    const onOpenDeck = vi.fn();
    render(<SlidesPage onOpenDeck={onOpenDeck} onStartDeck={vi.fn()} />);
    expect(await screen.findByText('Q3 review')).toBeTruthy();
    expect(screen.getByText(/4 slides/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Q3 review' }));
    expect(onOpenDeck).toHaveBeenCalledWith(deck);
  });

  it('shows the empty state', async () => {
    ipc.listDecks.mockResolvedValue([]);
    render(<SlidesPage onOpenDeck={() => {}} onStartDeck={vi.fn()} />);
    expect(await screen.findByText('No decks yet')).toBeTruthy();
  });

  it('shows the start box even when decks exist, in place of the old New deck form', async () => {
    render(<SlidesPage onOpenDeck={() => {}} onStartDeck={vi.fn()} />);
    await screen.findByText('Q3 review');
    expect(screen.getByLabelText(STORY)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New deck' })).toBeNull();
    expect((screen.getByRole('button', { name: 'Start deck' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('inserts a scaffold when a starter chip is clicked', async () => {
    render(<SlidesPage onOpenDeck={() => {}} onStartDeck={vi.fn()} />);
    await screen.findByText('Q3 review');
    const box = screen.getByLabelText(STORY) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole('button', { name: 'Quarterly update' }));
    expect(box.value).toContain('A quarterly update for [audience].');
    expect(box.value).toContain('\n');
    fireEvent.click(screen.getByRole('button', { name: 'Project kickoff' }));
    expect(box.value).toContain('A quarterly update');
    expect(box.value).toContain('A kickoff for [project]');
  });

  it('starts a deck with the trimmed prompt and the chosen theme', async () => {
    const onStartDeck = vi.fn().mockResolvedValue(undefined);
    render(<SlidesPage onOpenDeck={() => {}} onStartDeck={onStartDeck} />);
    await screen.findByText('Q3 review');
    fireEvent.change(screen.getByLabelText(STORY), { target: { value: '  Launch plan for the board \n' } });
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'paper' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start deck' }));
    const paper = STARTER_THEMES.find((t) => t.name === 'paper')!;
    await waitFor(() => expect(onStartDeck).toHaveBeenCalledWith('Launch plan for the board', 'paper', paper.css));
    await waitFor(() => expect((screen.getByLabelText(STORY) as HTMLTextAreaElement).value).toBe(''));
  });

  it('fills the story box from a deck idea, again for each new one', async () => {
    const { rerender } = render(
      <SlidesPage onOpenDeck={() => {}} onStartDeck={vi.fn()} prefill={{ text: 'A pitch deck for Habitly', seq: 1 }} />,
    );
    const box = screen.getByLabelText(STORY) as HTMLTextAreaElement;
    expect(box.value).toBe('A pitch deck for Habitly');
    expect(box).toHaveFocus();
    fireEvent.change(box, { target: { value: 'edited' } });
    rerender(<SlidesPage onOpenDeck={() => {}} onStartDeck={vi.fn()} prefill={{ text: 'A pitch deck for Habitly', seq: 2 }} />);
    expect(box.value).toBe('A pitch deck for Habitly');
    await screen.findByText('Q3 review');
  });

  it('reports a failed start and keeps the prompt', async () => {
    const onStatus = vi.fn();
    render(
      <SlidesPage
        onOpenDeck={() => {}}
        onStartDeck={vi.fn().mockRejectedValue(new Error('nope'))}
        onStatus={onStatus}
      />,
    );
    await screen.findByText('Q3 review');
    fireEvent.change(screen.getByLabelText(STORY), { target: { value: 'A deck' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start deck' }));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('nope'));
    expect((screen.getByLabelText(STORY) as HTMLTextAreaElement).value).toBe('A deck');
  });

  it('renames inline', async () => {
    ipc.renameDeck.mockResolvedValue(undefined);
    render(<SlidesPage onOpenDeck={() => {}} onStartDeck={vi.fn()} />);
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
    render(<SlidesPage onOpenDeck={() => {}} onStartDeck={vi.fn()} onStatus={onStatus} />);
    await screen.findByText('Q3 review');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Q3 review' }));
    expect(ipc.deleteDeck).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete deck' }));
    await waitFor(() => expect(ipc.deleteDeck).toHaveBeenCalledWith('d1'));
  });
});
