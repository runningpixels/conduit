import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { DeckDetail } from '../ipc/contracts';
import { PRESENT_IDLE_MS, PresentationView } from './PresentationView';
import { PRESENT_CLOSED_EVENT, PRESENT_COMMAND_EVENT, PRESENT_HELLO_EVENT, PRESENT_STATE_EVENT } from './presentCore';

const bus = vi.hoisted(() => ({
  emitted: [] as Array<{ event: string; payload: any }>,
  handlers: new Map<string, (p: unknown) => void>(),
  openPresenter: vi.fn(),
  restore: vi.fn(),
}));

vi.mock('./presentBus', () => ({
  emitPresent: vi.fn(async (event: string, payload: unknown) => {
    bus.emitted.push({ event, payload });
  }),
  listenPresent: (event: string, handler: (p: unknown) => void) => {
    bus.handlers.set(event, handler);
    return () => bus.handlers.delete(event);
  },
  enterFullscreen: vi.fn(async () => bus.restore),
  hasSecondMonitor: vi.fn(async () => false),
  openPresenterWindow: bus.openPresenter,
}));

vi.mock('./DeckFrame', () => ({
  DeckFrame: (p: { index: number; present?: boolean }) => (
    <div data-testid="frame" data-index={p.index} data-present={String(p.present === true)} />
  ),
}));

function makeDeck(n = 3): DeckDetail {
  return {
    id: 'd1',
    title: 'Launch',
    themeName: 'ink',
    themeCss: '',
    stage: 'slides',
    storyline: [],
    slides: Array.from({ length: n }, (_, i) => ({
      id: `s${i}`,
      position: i,
      layout: 'statement',
      html: '',
      notes: '',
      slots: [],
    })),
    assumptions: '',
    createdAt: '',
    updatedAt: '',
  };
}

const index = () => screen.getByTestId('frame').getAttribute('data-index');
const key = (k: string) => fireEvent.keyDown(window, { key: k });

beforeEach(() => {
  bus.emitted.length = 0;
  bus.handlers.clear();
  bus.openPresenter.mockClear();
});
afterEach(() => vi.useRealTimers());

function setup(startIndex = 0, deck = makeDeck()) {
  const onExit = vi.fn();
  render(<PresentationView deck={deck} startIndex={startIndex} colorScheme="dark" onExit={onExit} />);
  return onExit;
}

describe('PresentationView', () => {
  it('renders one present-mode frame in a portal on the body', () => {
    setup();
    const root = document.querySelector('.present-root');
    expect(root?.parentElement).toBe(document.body);
    expect(screen.getAllByTestId('frame')).toHaveLength(1);
    expect(screen.getByTestId('frame').getAttribute('data-present')).toBe('true');
  });

  it('navigates with the keyboard', () => {
    setup();
    key('ArrowRight');
    expect(index()).toBe('1');
    key(' ');
    expect(index()).toBe('2');
    key('ArrowLeft');
    expect(index()).toBe('1');
    key('End');
    expect(index()).toBe('2');
    key('Home');
    expect(index()).toBe('0');
    key('3');
    key('Enter');
    expect(index()).toBe('2');
  });

  it('navigates with clicks: left next, right previous', () => {
    setup();
    const hit = screen.getByTestId('present-hit');
    fireEvent.click(hit);
    expect(index()).toBe('1');
    const prevented = fireEvent.contextMenu(hit);
    expect(prevented).toBe(false);
    expect(index()).toBe('0');
  });

  it('blacks the screen and un-blacks on any key', () => {
    setup();
    key('b');
    expect(document.querySelector('.present-black')).not.toBeNull();
    key('ArrowRight');
    expect(document.querySelector('.present-black')).toBeNull();
    expect(index()).toBe('0');
    key('.');
    key('x');
    expect(document.querySelector('.present-black')).toBeNull();
  });

  it('shows the end screen past the last slide, then exits', () => {
    const onExit = setup(2);
    key('ArrowRight');
    expect(screen.getByText(/End of slide show/)).toBeTruthy();
    expect(onExit).not.toHaveBeenCalled();
    key('ArrowRight');
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('exits on Esc, but un-blacks first', () => {
    const onExit = setup();
    key('b');
    key('Escape');
    expect(onExit).not.toHaveBeenCalled();
    key('Escape');
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('opens the presenter window on S and from the control bar', () => {
    setup();
    key('s');
    fireEvent.click(screen.getByRole('button', { name: 'Presenter view' }));
    expect(bus.openPresenter).toHaveBeenCalledTimes(2);
  });

  it('hides the cursor and control bar after two idle seconds', () => {
    vi.useFakeTimers();
    setup();
    const root = document.querySelector('.present-root') as HTMLElement;
    const bar = () => document.querySelector('.present-bar')?.getAttribute('data-visible');
    expect(root.getAttribute('data-idle')).toBe('true');
    fireEvent.mouseMove(root);
    expect(root.getAttribute('data-idle')).toBe('false');
    expect(bar()).toBe('true');
    expect(screen.getByText('1 / 3')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(PRESENT_IDLE_MS - 100);
    });
    expect(bar()).toBe('true');
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(root.getAttribute('data-idle')).toBe('true');
    expect(bar()).toBe('false');
  });

  it('control bar buttons navigate and exit', () => {
    const onExit = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    expect(index()).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: 'Previous slide' }));
    expect(index()).toBe('0');
    fireEvent.click(screen.getByRole('button', { name: 'Exit' }));
    expect(onExit).toHaveBeenCalled();
  });

  it('publishes its state, answers hello, and takes commands for its own deck only', () => {
    setup(1);
    const last = () => bus.emitted.filter((e) => e.event === PRESENT_STATE_EVENT).at(-1)?.payload;
    expect(last()).toMatchObject({ deckId: 'd1', index: 1, black: false, ended: false });
    const before = bus.emitted.length;
    bus.handlers.get(PRESENT_HELLO_EVENT)?.({ deckId: 'other' });
    expect(bus.emitted.length).toBe(before);
    bus.handlers.get(PRESENT_HELLO_EVENT)?.({ deckId: 'd1' });
    expect(bus.emitted.length).toBe(before + 1);

    act(() => bus.handlers.get(PRESENT_COMMAND_EVENT)?.({ deckId: 'other', action: 'next' }));
    expect(index()).toBe('1');
    act(() => bus.handlers.get(PRESENT_COMMAND_EVENT)?.({ deckId: 'd1', action: 'next' }));
    expect(index()).toBe('2');
    act(() => bus.handlers.get(PRESENT_COMMAND_EVENT)?.({ deckId: 'd1', action: 'goto', index: 0 }));
    expect(index()).toBe('0');
    expect(last()).toMatchObject({ index: 0 });
  });

  it('tells the presenter window when the show ends', async () => {
    vi.useFakeTimers();
    const { unmount } = render(
      <PresentationView deck={makeDeck()} startIndex={0} colorScheme="dark" onExit={() => {}} />,
    );
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(10);
    });
    expect(bus.emitted.some((e) => e.event === PRESENT_CLOSED_EVENT && e.payload.deckId === 'd1')).toBe(true);
  });
});
