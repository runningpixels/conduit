import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { DeckDetail } from '../ipc/contracts';
import { StudioHeader, type StudioHeaderProps } from './StudioHeader';
import { buildThemeChoices } from './themeChoices';
import { STARTER_THEMES } from './themes';

function makeDeck(over: Partial<DeckDetail> = {}): DeckDetail {
  return {
    id: 'd1',
    title: 'Launch',
    themeName: 'ink',
    themeCss: STARTER_THEMES[0].css,
    stage: 'slides',
    storyline: [],
    slides: [{ id: 'a', position: 0, layout: 'statement', html: '', notes: '', slots: [] }],
    assumptions: '',
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-01T10:00:00Z',
    ...over,
  };
}

function props(over: Partial<StudioHeaderProps> = {}): StudioHeaderProps {
  const deck = over.deck ?? makeDeck();
  return {
    deck,
    busyTool: null,
    themes: buildThemeChoices(deck, []),
    onBack: vi.fn(),
    onRename: vi.fn(),
    onSetTheme: vi.fn(),
    madeFromChat: false,
    onUndoStart: vi.fn(),
    ...over,
  };
}

const current = () => document.querySelector('.studio-step[data-current="true"]')?.textContent;

describe('StudioHeader', () => {
  it('marks Story while the deck is a storyline', () => {
    render(<StudioHeader {...props({ deck: makeDeck({ stage: 'storyline', slides: [] }) })} />);
    expect(current()).toBe('Story');
  });

  it('marks Slides while a deck tool runs, and Polish otherwise', () => {
    const { rerender } = render(<StudioHeader {...props({ busyTool: 'add_slide' })} />);
    expect(current()).toBe('Slides');
    rerender(<StudioHeader {...props()} />);
    expect(current()).toBe('Polish');
  });

  it('shows Present disabled with a Coming next hint', () => {
    render(<StudioHeader {...props()} />);
    const present = screen.getByText('Present');
    expect(present.getAttribute('data-disabled')).toBe('true');
    expect(present.getAttribute('title')).toBe('Coming next');
  });

  it('shows the Undo chip only for a deck made from chat that has no slides', () => {
    const empty = makeDeck({ slides: [], stage: 'storyline' });
    const onUndoStart = vi.fn();
    const { rerender } = render(<StudioHeader {...props({ deck: empty, madeFromChat: true, onUndoStart })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(onUndoStart).toHaveBeenCalled();
    rerender(<StudioHeader {...props({ deck: empty, madeFromChat: false })} />);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
    rerender(<StudioHeader {...props({ deck: makeDeck(), madeFromChat: true })} />);
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });

  it('goes back, renames and switches theme', () => {
    const p = props();
    render(<StudioHeader {...p} />);
    fireEvent.click(screen.getByRole('button', { name: /All decks/ }));
    expect(p.onBack).toHaveBeenCalled();
    const title = screen.getByRole('textbox', { name: 'Deck title' });
    fireEvent.change(title, { target: { value: 'Launch plan' } });
    fireEvent.blur(title);
    expect(p.onRename).toHaveBeenCalledWith('Launch plan');
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'paper' } });
    expect(p.onSetTheme).toHaveBeenCalledWith('paper', STARTER_THEMES[1].css);
  });
});
