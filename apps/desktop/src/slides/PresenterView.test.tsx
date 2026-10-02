import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DeckDetail } from '../ipc/contracts';
import { PresenterApp } from './PresenterApp';
import { NOTES_SIZE_KEY, PresenterView } from './PresenterView';
import { PRESENT_CLOSED_EVENT, PRESENT_COMMAND_EVENT, PRESENT_HELLO_EVENT, PRESENT_STATE_EVENT } from './presentCore';

const bus = vi.hoisted(() => ({
  emitted: [] as Array<{ event: string; payload: any }>,
  handlers: new Map<string, (p: unknown) => void>(),
  close: vi.fn(),
  getDeck: vi.fn(),
}));

vi.mock('./presentBus', () => ({
  emitPresent: vi.fn(async (event: string, payload: unknown) => {
    bus.emitted.push({ event, payload });
  }),
  listenPresentReady: async (event: string, handler: (p: unknown) => void) => {
    bus.handlers.set(event, handler);
    return () => bus.handlers.delete(event);
  },
  closeThisWindow: bus.close,
}));
vi.mock('../ipc/client', () => ({ getDeck: bus.getDeck }));
vi.mock('./DeckFrame', () => ({
  DeckFrame: (p: { index: number }) => <div data-testid="frame" data-index={p.index} />,
}));

function makeDeck(): DeckDetail {
  return {
    id: 'd1',
    title: 'Launch',
    themeName: 'ink',
    themeCss: '',
    stage: 'slides',
    storyline: [],
    slides: [0, 1, 2].map((i) => ({
      id: `s${i}`,
      position: i,
      layout: 'statement',
      html: '',
      notes: `Notes for ${i + 1}`,
      slots: [],
    })),
    assumptions: '',
    createdAt: '',
    updatedAt: '',
  };
}

const state = (over: Record<string, unknown> = {}) => ({
  deckId: 'd1',
  index: 0,
  black: false,
  ended: false,
  startedAt: Date.now() - 65_000,
  ...over,
});

beforeEach(() => {
  bus.emitted.length = 0;
  bus.handlers.clear();
  bus.close.mockClear();
  bus.getDeck.mockReset().mockResolvedValue(makeDeck());
  window.localStorage.clear();
});

describe('PresenterView', () => {
  it('shows current and next slide, notes, position and the timer', () => {
    render(<PresenterView deck={makeDeck()} state={state({ index: 1 }) as any} onCommand={vi.fn()} />);
    const frames = screen.getAllByTestId('frame').map((f) => f.getAttribute('data-index'));
    expect(frames).toEqual(['1', '2']);
    expect(screen.getByTestId('presenter-notes').textContent).toBe('Notes for 2');
    expect(screen.getByTestId('presenter-count').textContent).toBe('Slide 2 of 3');
    expect(screen.getByTestId('presenter-timer').textContent).toBe('01:05');
  });

  it('shows the end of the show instead of a next slide on the last slide', () => {
    render(<PresenterView deck={makeDeck()} state={state({ index: 2 }) as any} onCommand={vi.fn()} />);
    expect(screen.getAllByTestId('frame')).toHaveLength(1);
    expect(screen.getByText('End of slide show')).toBeTruthy();
  });

  it('sends commands from buttons and keys', () => {
    const onCommand = vi.fn();
    render(<PresenterView deck={makeDeck()} state={state() as any} onCommand={onCommand} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous slide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Black screen' }));
    fireEvent.click(screen.getByRole('button', { name: 'End show' }));
    expect(onCommand.mock.calls.map((c) => c[0].action)).toEqual(['next', 'prev', 'black', 'exit']);
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    fireEvent.keyDown(window, { key: 'End' });
    expect(onCommand).toHaveBeenCalledWith({ action: 'next' });
    expect(onCommand).toHaveBeenLastCalledWith({ action: 'goto', index: 2 });
  });

  it('changes and remembers the notes size', () => {
    render(<PresenterView deck={makeDeck()} state={state() as any} onCommand={vi.fn()} />);
    const notes = screen.getByTestId('presenter-notes');
    expect(notes.style.fontSize).toBe('28px');
    fireEvent.click(screen.getByRole('button', { name: 'Larger notes text' }));
    expect(notes.style.fontSize).toBe('32px');
    expect(window.localStorage.getItem(NOTES_SIZE_KEY)).toBe('32');
  });

  it('pauses and resets the timer', () => {
    vi.useFakeTimers();
    render(<PresenterView deck={makeDeck()} state={state() as any} onCommand={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId('presenter-timer').textContent).toBe('01:05');
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByTestId('presenter-timer').textContent).toBe('00:00');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId('presenter-timer').textContent).toBe('00:03');
    vi.useRealTimers();
  });
});

describe('PresenterApp', () => {
  it('loads the deck, says hello, follows state for its deck, and closes with the show', async () => {
    render(<PresenterApp deckId="d1" />);
    await waitFor(() => expect(screen.getAllByTestId('frame').length).toBeGreaterThan(0));
    await waitFor(() =>
      expect(bus.emitted.some((e) => e.event === PRESENT_HELLO_EVENT && e.payload.deckId === 'd1')).toBe(true),
    );
    act(() => bus.handlers.get(PRESENT_STATE_EVENT)?.(state({ index: 2 })));
    expect(screen.getByTestId('presenter-count').textContent).toBe('Slide 3 of 3');
    act(() => bus.handlers.get(PRESENT_STATE_EVENT)?.(state({ deckId: 'other', index: 0 })));
    expect(screen.getByTestId('presenter-count').textContent).toBe('Slide 3 of 3');

    fireEvent.click(screen.getByRole('button', { name: 'Previous slide' }));
    expect(bus.emitted.find((e) => e.event === PRESENT_COMMAND_EVENT)?.payload).toEqual({
      deckId: 'd1',
      action: 'prev',
    });

    act(() => bus.handlers.get(PRESENT_CLOSED_EVENT)?.({ deckId: 'other' }));
    expect(bus.close).not.toHaveBeenCalled();
    act(() => bus.handlers.get(PRESENT_CLOSED_EVENT)?.({ deckId: 'd1' }));
    expect(bus.close).toHaveBeenCalled();
  });
});
