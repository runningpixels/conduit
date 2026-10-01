import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DeckDetail, DeckSlide } from '../ipc/contracts';
import { DeckWorkspace, type DeckWorkspaceProps } from './DeckWorkspace';
import { STARTER_THEMES } from './themes';

const slide = (id: string, position: number): DeckSlide => ({
  id,
  position,
  layout: 'statement',
  html: `<h1 class="headline">${id}</h1>`,
  notes: '',
});

function makeDeck(over: Partial<DeckDetail> = {}): DeckDetail {
  return {
    id: 'd1',
    title: 'Launch',
    themeName: 'ink',
    themeCss: STARTER_THEMES[0].css,
    stage: 'slides',
    storyline: [],
    slides: [slide('a', 0), slide('b', 1)],
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-01T10:00:00Z',
    ...over,
  };
}

function props(over: Partial<DeckWorkspaceProps> = {}): DeckWorkspaceProps {
  return {
    deck: makeDeck(),
    loading: false,
    busyTool: null,
    colorScheme: 'dark',
    onRename: vi.fn(),
    onSetTheme: vi.fn(),
    onSetStoryline: vi.fn(),
    onBuild: vi.fn(),
    onListSnapshots: vi.fn().mockResolvedValue([]),
    onRestore: vi.fn().mockResolvedValue(undefined),
    historyRevision: 0,
    ...over,
  };
}

describe('DeckWorkspace', () => {
  it('keeps saved custom themes in the theme picker after switching away', () => {
    const p = props({
      savedThemes: [{ name: 'Ember', css: '.ember{}', updatedAt: '2026-10-01T10:00:00Z' }],
    });
    render(<DeckWorkspace {...p} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Ink', 'Paper', 'Ember']);
    fireEvent.change(select, { target: { value: 'Ember' } });
    expect(p.onSetTheme).toHaveBeenCalledWith('Ember', '.ember{}');
  });

  it('shows the storyline editor while the deck is an outline', () => {
    const p = props({
      deck: makeDeck({ stage: 'storyline', slides: [], storyline: [{ id: 'l1', text: 'Why now' }] }),
    });
    render(<DeckWorkspace {...p} />);
    expect(screen.getByDisplayValue('Why now')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Build slides' }));
    expect(p.onBuild).toHaveBeenCalled();
  });

  it('moves between slides with the arrow keys and jumps to a new slide', () => {
    const p = props();
    const { rerender } = render(<DeckWorkspace {...p} />);
    expect(screen.getAllByText('Slide 1 of 2').length).toBeGreaterThan(0);
    const stage = screen.getByRole('group', { name: 'Slide 1 of 2' });
    fireEvent.keyDown(stage, { key: 'ArrowRight' });
    expect(screen.getByText('Slide 2 of 2', { selector: '.deck-stage-count' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('group', { name: 'Slide 2 of 2' }), { key: 'ArrowRight' });
    expect(screen.getByText('Slide 2 of 2', { selector: '.deck-stage-count' })).toBeTruthy();
    rerender(<DeckWorkspace {...p} deck={makeDeck({ slides: [slide('a', 0), slide('b', 1), slide('c', 2)] })} />);
    expect(screen.getByText('Slide 3 of 3', { selector: '.deck-stage-count' })).toBeTruthy();
    rerender(<DeckWorkspace {...p} deck={makeDeck({ slides: [slide('a', 0)] })} />);
    expect(screen.getByText('Slide 1 of 1', { selector: '.deck-stage-count' })).toBeTruthy();
  });

  it('shows an updating label while a deck tool runs', () => {
    render(<DeckWorkspace {...props({ busyTool: 'add_slide' })} />);
    expect(screen.getByText('Updating…')).toBeTruthy();
  });

  it('switches theme and lists a custom theme name', () => {
    const p = props({ deck: makeDeck({ themeName: 'Custom' }) });
    render(<DeckWorkspace {...p} />);
    const select = screen.getByLabelText('Theme') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['ink', 'paper', 'Custom']);
    fireEvent.change(select, { target: { value: 'paper' } });
    expect(p.onSetTheme).toHaveBeenCalledWith('paper', STARTER_THEMES[1].css);
  });

  it('restores from history only after an inline confirm', async () => {
    const p = props({
      onListSnapshots: vi.fn().mockResolvedValue([
        { id: 's2', cause: 'ai-turn', label: 'Add a stats slide', slideCount: 3, createdAt: '2026-10-01T10:05:00Z' },
        { id: 's1', cause: 'created', label: 'Deck created', slideCount: 0, createdAt: '2026-10-01T10:00:00Z' },
      ]),
    });
    render(<DeckWorkspace {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(await screen.findByText('Add a stats slide')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(p.onRestore).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[0]);
    await waitFor(() => expect(p.onRestore).toHaveBeenCalledWith('s1'));
  });
});
