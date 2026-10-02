import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DeckDetail, DeckReplaceResult, DeckSlide, SlideSlot } from '../ipc/contracts';
import { ScriptPanel, humanizeSlotName, type ScriptPanelProps } from './ScriptPanel';

const slot = (index: number, name: string, tag: string, classes: string[], html: string, pinned = false): SlideSlot => ({
  index,
  name,
  html,
  text: html.replace(/<[^>]+>/g, ''),
  pinned,
  tag,
  classes,
});

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
    assumptions: '',
    stage: 'slides',
    storyline: [],
    slides: [
      slide('a', 0, {
        notes: 'Say hello',
        slots: [
          slot(0, 'kicker', 'p', ['kicker'], 'Q3 review'),
          slot(1, 'headline', 'h1', ['headline'], 'Hello <b>world</b>'),
          slot(2, 'bullet-1', 'li', [], 'First point'),
          slot(3, 'bullet-2', 'li', [], 'Second point', true),
          slot(4, 'stat-1', 'b', [], '42%'),
          slot(5, 'stat-1-label', 'span', ['label'], 'faster'),
          slot(6, 'quote', 'blockquote', [], 'It works.'),
          slot(7, 'cite', 'p', ['cite'], 'Ada'),
          slot(8, 'footnote', 'p', ['footnote'], 'Source: us'),
          slot(9, 'body', 'p', [], 'Plain words'),
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

function props(over: Partial<ScriptPanelProps> = {}): ScriptPanelProps {
  return {
    deck: makeDeck(),
    overflow: {},
    onEditWords: vi.fn().mockResolvedValue(undefined),
    onSetPinned: vi.fn().mockResolvedValue(undefined),
    onReplace: vi.fn().mockResolvedValue(result(0)),
    onInsertBullet: vi.fn().mockResolvedValue('bullet-3'),
    onRemoveBullet: vi.fn().mockResolvedValue(undefined),
    onAskToFix: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
}

const field = (name: string, n = 1) => screen.getByRole('textbox', { name: `${name}, slide ${n}` });

function caretAtEnd(el: HTMLElement) {
  el.focus();
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('humanizeSlotName', () => {
  it('turns slot names into accessible names', () => {
    expect(humanizeSlotName('stat-2')).toBe('Stat 2');
  });
});

describe('ScriptPanel as a document', () => {
  it('styles each block by what the slot is', () => {
    render(<ScriptPanel {...props()} />);
    const kind = (name: string) => field(name).closest('.deck-script-block')?.getAttribute('data-kind');
    expect(kind('Kicker')).toBe('kicker');
    expect(kind('Headline')).toBe('heading');
    expect(kind('Bullet 1')).toBe('bullet');
    expect(kind('Bullet 2')).toBe('bullet');
    expect(kind('Stat 1')).toBe('figure');
    expect(kind('Stat 1 label')).toBe('caption');
    expect(kind('Quote')).toBe('quote');
    expect(kind('Cite')).toBe('cite');
    expect(kind('Footnote')).toBe('footnote');
    expect(kind('Body')).toBe('paragraph');
    // Consecutive bullets share one list; a figure and its caption share one row.
    expect(field('Bullet 1').closest('ul')).toBe(field('Bullet 2').closest('ul'));
    expect(field('Stat 1').closest('.deck-script-figure')).toBe(field('Stat 1 label').closest('.deck-script-figure'));
  });

  it('shows no visible field labels, only the slot name as a tooltip', () => {
    const { container } = render(<ScriptPanel {...props()} />);
    for (const label of ['Kicker', 'Headline', 'Bullet 1', 'Stat 1', 'Body', 'bullet-1']) {
      expect(screen.queryByText(label)).toBeNull();
    }
    expect(field('Bullet 1').getAttribute('title')).toBe('bullet-1');
    expect(container.querySelector('label')).toBeNull();
    expect(field('Headline').innerHTML).toBe('Hello <b>world</b>');
    expect(screen.getByText('Slide 2')).toBeTruthy();
    expect(screen.getByText('This slide has no editable text.')).toBeTruthy();
  });

  it('commits cleaned HTML on blur', () => {
    const p = props();
    render(<ScriptPanel {...p} />);
    const el = field('Headline');
    el.innerHTML = 'Hi<div>there</div><span style="color:red">!</span>';
    fireEvent.input(el);
    fireEvent.blur(el);
    expect(p.onEditWords).toHaveBeenCalledWith('a', [{ index: 1, name: 'headline', html: 'Hi<br>there<span>!</span>' }]);
  });

  it('commits after the idle delay and not before', () => {
    vi.useFakeTimers();
    const p = props();
    render(<ScriptPanel {...p} />);
    const el = field('Headline');
    el.innerHTML = 'Changed';
    fireEvent.input(el);
    act(() => void vi.advanceTimersByTime(700));
    expect(p.onEditWords).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(150));
    expect(p.onEditWords).toHaveBeenCalledWith('a', [{ index: 1, name: 'headline', html: 'Changed' }]);
  });

  it('does not commit when nothing changed', () => {
    const p = props();
    render(<ScriptPanel {...p} />);
    fireEvent.input(field('Headline'));
    fireEvent.blur(field('Headline'));
    expect(p.onEditWords).not.toHaveBeenCalled();
  });

  it('keeps what the user is typing when the deck refreshes', () => {
    const p = props();
    const { rerender } = render(<ScriptPanel {...p} />);
    const el = field('Headline');
    el.focus();
    el.innerHTML = 'Typing…';
    fireEvent.input(el);
    const refreshed = makeDeck();
    refreshed.slides[0].slots[1].html = 'From the server';
    rerender(<ScriptPanel {...p} deck={refreshed} />);
    expect(el.innerHTML).toBe('Typing…');
  });

  it('marks pinned blocks with a gutter bar and lets the AI edit again', () => {
    const p = props();
    render(<ScriptPanel {...p} />);
    expect(field('Bullet 2').closest('.deck-script-block')?.getAttribute('data-pinned')).toBe('true');
    expect(field('Bullet 1').closest('.deck-script-block')?.getAttribute('data-pinned')).toBeNull();
    expect(screen.getAllByText('You wrote this. The AI keeps it.')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Let AI edit' }));
    expect(p.onSetPinned).toHaveBeenCalledWith('a', 3, 'bullet-2', false);
  });

  it('keeps notes collapsed, then saves them on blur', () => {
    const p = props();
    render(<ScriptPanel {...p} />);
    expect(screen.queryByLabelText('Speaker notes')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /^Notes/ })[0]);
    const notes = screen.getByLabelText('Speaker notes') as HTMLTextAreaElement;
    expect(notes.value).toBe('Say hello');
    fireEvent.change(notes, { target: { value: 'New notes' } });
    fireEvent.blur(notes);
    expect(p.onEditWords).toHaveBeenCalledWith('a', [], 'New notes');
  });

  it('shows an overflow row in the slide header and asks to fix it', () => {
    const p = props({ overflow: { a: 140 } });
    render(<ScriptPanel {...p} />);
    expect(screen.getByText('Text runs off this slide by 140px.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ask to fix' }));
    expect(p.onAskToFix).toHaveBeenCalledWith(
      'Slide 1 has text running off the bottom by 140px. Shorten or split it so everything fits, without changing its meaning.',
    );
  });

  it('focuses the block for a slot selected on the stage', () => {
    const { rerender } = render(<ScriptPanel {...props()} />);
    rerender(<ScriptPanel {...props()} focusRequest={{ slideId: 'a', index: 3, nonce: 1 }} />);
    expect(document.activeElement).toBe(field('Bullet 2'));
  });
});

describe('ScriptPanel keyboard', () => {
  it('Enter at the end of a bullet adds a bullet and focuses it once the deck shows it', async () => {
    const p = props();
    const { rerender } = render(<ScriptPanel {...p} />);
    const el = field('Bullet 1');
    caretAtEnd(el);
    fireEvent.keyDown(el, { key: 'Enter' });
    await waitFor(() => expect(p.onInsertBullet).toHaveBeenCalledWith('a', 2, 'bullet-1'));
    const grown = makeDeck();
    grown.slides[0].slots.splice(3, 0, slot(3, 'bullet-3', 'li', [], ''));
    grown.slides[0].slots.forEach((s, i) => (s.index = i));
    rerender(<ScriptPanel {...p} deck={grown} />);
    await waitFor(() => expect(document.activeElement).toBe(field('Bullet 3')));
  });

  it('Enter in a non-bullet does not add a bullet', () => {
    const p = props();
    document.execCommand = vi.fn();
    render(<ScriptPanel {...p} />);
    const el = field('Body');
    caretAtEnd(el);
    fireEvent.keyDown(el, { key: 'Enter' });
    expect(p.onInsertBullet).not.toHaveBeenCalled();
    expect(document.execCommand).toHaveBeenCalledWith('insertLineBreak');
  });

  it('Backspace in an empty bullet removes it and focuses the previous block', async () => {
    const p = props();
    const deck = makeDeck();
    deck.slides[0].slots[2].html = '';
    deck.slides[0].slots[2].text = '';
    render(<ScriptPanel {...p} deck={deck} />);
    const el = field('Bullet 1');
    el.focus();
    fireEvent.keyDown(el, { key: 'Backspace' });
    await waitFor(() => expect(p.onRemoveBullet).toHaveBeenCalledWith('a', 2, 'bullet-1'));
    await waitFor(() => expect(document.activeElement).toBe(field('Headline')));
  });

  it('Backspace in a bullet with text leaves it alone', () => {
    const p = props();
    render(<ScriptPanel {...p} />);
    fireEvent.keyDown(field('Bullet 1'), { key: 'Backspace' });
    expect(p.onRemoveBullet).not.toHaveBeenCalled();
  });

  it('arrow keys move between blocks at the first and last line', () => {
    render(<ScriptPanel {...props()} />);
    const bullet = field('Bullet 1');
    caretAtEnd(bullet);
    fireEvent.keyDown(bullet, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(field('Bullet 2'));
    fireEvent.keyDown(field('Bullet 2'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(bullet);
  });

  it('does not leave a multi-line block while the caret is inside its lines', () => {
    const p = props();
    const deck = makeDeck();
    deck.slides[0].slots[9].html = 'one<br>two';
    render(<ScriptPanel {...p} deck={deck} />);
    const el = field('Body');
    el.focus();
    const range = document.createRange();
    range.setStart(el.firstChild!, 1);
    range.collapse(true);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    fireEvent.keyDown(el, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(el);
  });
});

describe('ScriptPanel find and replace', () => {
  it('hides the find bar until opened, with the search button or Ctrl+H', () => {
    const { rerender } = render(<ScriptPanel {...props()} />);
    expect(screen.queryByLabelText('Find')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Find and replace' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Find'));
    fireEvent.click(screen.getByRole('button', { name: 'Find and replace' }));
    expect(screen.queryByLabelText('Find')).toBeNull();
    rerender(<ScriptPanel {...props()} findFocusToken={1} />);
    expect(document.activeElement).toBe(screen.getByLabelText('Find'));
  });

  it('dry-runs a replace after a pause, then applies it', async () => {
    const onReplace = vi
      .fn()
      .mockResolvedValueOnce(result(12))
      .mockResolvedValueOnce({ ...result(12), applied: true });
    render(<ScriptPanel {...props({ onReplace, findFocusToken: 1 })} />);
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
    render(<ScriptPanel {...props({ onReplace, findFocusToken: 1 })} />);
    fireEvent.click(screen.getByLabelText('Match case'));
    fireEvent.click(screen.getByLabelText('Whole word'));
    fireEvent.change(screen.getByLabelText('Find'), { target: { value: 'Q3' } });
    await waitFor(() => expect(onReplace).toHaveBeenCalledWith('Q3', '', true, true, false));
    expect(await screen.findByText('No matches')).toBeTruthy();
  });
});

describe('ScriptPanel Copy as Markdown', () => {
  it('writes the deck as Markdown to the clipboard and flashes Copied', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ScriptPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('## Slide 1\n\n*Q3 review*\n\n# Hello **world**');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('shows a readable error when the clipboard refuses', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ScriptPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not copy: Permission denied');
  });
});
