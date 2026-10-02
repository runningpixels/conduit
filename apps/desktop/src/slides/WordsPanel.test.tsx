import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DeckDetail, DeckReplaceResult, DeckSlide } from '../ipc/contracts';
import { WordsPanel, humanizeSlotName, type WordsPanelProps } from './WordsPanel';

const slide = (id: string, position: number, over: Partial<DeckSlide> = {}): DeckSlide => ({
  id,
  position,
  layout: 'stat-row',
  html: '',
  notes: '',
  slots: [],
  ...over,
});

function makeDeck(): DeckDetail {
  return {
    id: 'd1',
    title: 'Launch',
    themeName: 'ink',
    themeCss: '',
    stage: 'slides',
    storyline: [],
    slides: [
      slide('a', 0, {
        notes: 'Say hello',
        slots: [
          { index: 0, name: 'headline', html: 'Hello <b>world</b>', text: 'Hello world', pinned: false },
          { index: 1, name: 'stat-2', html: '42%', text: '42%', pinned: true },
        ],
      }),
      slide('b', 1, { layout: 'statement', slots: [] }),
    ],
    createdAt: '2026-10-01T10:00:00Z',
    updatedAt: '2026-10-01T10:00:00Z',
  } as DeckDetail;
}

const result = (total: number): DeckReplaceResult => ({
  total,
  applied: false,
  slides: [{ slideId: 'a', position: 0, count: total, notesCount: 0 }],
});

function props(over: Partial<WordsPanelProps> = {}): WordsPanelProps {
  return {
    deck: makeDeck(),
    overflow: {},
    onEditWords: vi.fn().mockResolvedValue(undefined),
    onSetPinned: vi.fn().mockResolvedValue(undefined),
    onReplace: vi.fn().mockResolvedValue(result(0)),
    onAskToFix: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}

afterEach(() => vi.useRealTimers());

describe('humanizeSlotName', () => {
  it('turns slot names into labels', () => {
    expect(humanizeSlotName('stat-2')).toBe('Stat 2');
    expect(humanizeSlotName('headline')).toBe('Headline');
  });
});

describe('WordsPanel', () => {
  it('renders a field per slot, grouped by slide, with notes', () => {
    render(<WordsPanel {...props()} />);
    expect(screen.getByRole('textbox', { name: 'Headline, slide 1' }).innerHTML).toBe('Hello <b>world</b>');
    expect(screen.getByRole('textbox', { name: 'Stat 2, slide 1' }).innerHTML).toBe('42%');
    expect(screen.getByText('Slide 2')).toBeTruthy();
    expect(screen.getByText('This slide has no editable text.')).toBeTruthy();
    expect((screen.getAllByLabelText('Speaker notes')[0] as HTMLTextAreaElement).value).toBe('Say hello');
  });

  it('commits cleaned HTML on blur', () => {
    const p = props();
    render(<WordsPanel {...p} />);
    const field = screen.getByRole('textbox', { name: 'Headline, slide 1' });
    field.innerHTML = 'Hi<div>there</div><span style="color:red">!</span>';
    fireEvent.input(field);
    fireEvent.blur(field);
    expect(p.onEditWords).toHaveBeenCalledWith('a', [{ index: 0, name: 'headline', html: 'Hi<br>there<span>!</span>' }]);
  });

  it('commits after the idle delay and not before', () => {
    vi.useFakeTimers();
    const p = props();
    render(<WordsPanel {...p} />);
    const field = screen.getByRole('textbox', { name: 'Headline, slide 1' });
    field.innerHTML = 'Changed';
    fireEvent.input(field);
    act(() => void vi.advanceTimersByTime(700));
    expect(p.onEditWords).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(150));
    expect(p.onEditWords).toHaveBeenCalledWith('a', [{ index: 0, name: 'headline', html: 'Changed' }]);
  });

  it('does not commit when nothing changed', () => {
    const p = props();
    render(<WordsPanel {...p} />);
    const field = screen.getByRole('textbox', { name: 'Headline, slide 1' });
    fireEvent.input(field);
    fireEvent.blur(field);
    expect(p.onEditWords).not.toHaveBeenCalled();
  });

  it('keeps what the user is typing when the deck refreshes', () => {
    const p = props();
    const { rerender } = render(<WordsPanel {...p} />);
    const field = screen.getByRole('textbox', { name: 'Headline, slide 1' });
    field.focus();
    field.innerHTML = 'Typing…';
    fireEvent.input(field);
    const refreshed = makeDeck();
    refreshed.slides[0].slots[0].html = 'From the server';
    rerender(<WordsPanel {...p} deck={refreshed} />);
    expect(field.innerHTML).toBe('Typing…');
  });

  it('shows a Yours chip on pinned slots and unpins with Let AI edit', () => {
    const p = props();
    render(<WordsPanel {...p} />);
    expect(screen.getAllByText('Yours')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Let AI edit' }));
    expect(p.onSetPinned).toHaveBeenCalledWith('a', 1, 'stat-2', false);
  });

  it('saves speaker notes on blur', () => {
    const p = props();
    render(<WordsPanel {...p} />);
    const notes = screen.getAllByLabelText('Speaker notes')[0];
    fireEvent.change(notes, { target: { value: 'New notes' } });
    fireEvent.blur(notes);
    expect(p.onEditWords).toHaveBeenCalledWith('a', [], 'New notes');
  });

  it('dry-runs a replace after a pause, then applies it', async () => {
    const onReplace = vi
      .fn()
      .mockResolvedValueOnce(result(12))
      .mockResolvedValueOnce({ ...result(12), applied: true, slides: [{ slideId: 'a', position: 0, count: 12, notesCount: 0 }] });
    render(<WordsPanel {...props({ onReplace })} />);
    fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'users' } });
    fireEvent.change(screen.getByLabelText('Replace with'), { target: { value: 'customers' } });
    expect(await screen.findByText('12 matches on 1 slide')).toBeTruthy();
    expect(onReplace).toHaveBeenCalledWith('users', 'customers', false, false, false);
    fireEvent.click(screen.getByRole('button', { name: 'Replace all' }));
    await waitFor(() => expect(onReplace).toHaveBeenLastCalledWith('users', 'customers', false, false, true));
    expect(await screen.findByText('Replaced 12 matches on 1 slide.')).toBeTruthy();
  });

  it('passes the match options through', async () => {
    const onReplace = vi.fn().mockResolvedValue(result(0));
    render(<WordsPanel {...props({ onReplace })} />);
    fireEvent.click(screen.getByLabelText('Match case'));
    fireEvent.click(screen.getByLabelText('Whole word'));
    fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'Q3' } });
    await waitFor(() => expect(onReplace).toHaveBeenCalledWith('Q3', '', true, true, false));
    expect(await screen.findByText('No matches')).toBeTruthy();
  });

  it('shows an overflow row and asks to fix it', () => {
    const p = props({ overflow: { a: 140 } });
    render(<WordsPanel {...p} />);
    expect(screen.getByText('Text runs off this slide by 140px.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask to fix' }));
    expect(p.onAskToFix).toHaveBeenCalledWith(
      'Slide 1 has text running off the bottom by 140px. Shorten or split it so everything fits, without changing its meaning.',
    );
  });

  it('focuses the field for a slot selected on the stage', () => {
    const { rerender } = render(<WordsPanel {...props()} />);
    rerender(<WordsPanel {...props()} focusRequest={{ slideId: 'a', index: 1, nonce: 1 }} />);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Stat 2, slide 1' }));
  });
});
