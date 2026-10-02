import { describe, expect, it } from 'vitest';
import {
  centerOnMonitor,
  commandToAction,
  formatElapsed,
  initialPresentState,
  otherMonitor,
  parseCommandPayload,
  parsePresenterRoute,
  parseStatePayload,
  presentKey,
  reducePresent,
  type PresentAction,
  type PresentState,
} from './presentCore';

const run = (s: PresentState, a: PresentAction, n = 3) => reducePresent(s, a, n);

describe('reducePresent', () => {
  it('moves, clamps, and ends past the last slide', () => {
    let s = initialPresentState(0, 3);
    s = run(s, { type: 'prev' }).state;
    expect(s.index).toBe(0);
    s = run(s, { type: 'next' }).state;
    s = run(s, { type: 'next' }).state;
    expect(s).toEqual({ index: 2, black: false, ended: false });
    s = run(s, { type: 'next' }).state;
    expect(s.ended).toBe(true);
    expect(run(s, { type: 'next' }).exit).toBe(true);
    expect(run(s, { type: 'prev' }).state).toEqual({ index: 2, black: false, ended: false });
  });

  it('goes to a slide, first and last', () => {
    const s = initialPresentState(1, 5);
    expect(run(s, { type: 'goto', index: 3 }, 5).state.index).toBe(3);
    expect(run(s, { type: 'goto', index: 99 }, 5).state.index).toBe(4);
    expect(run(s, { type: 'first' }, 5).state.index).toBe(0);
    expect(run(s, { type: 'last' }, 5).state.index).toBe(4);
  });

  it('only un-blacks on any move while black, and Esc un-blacks before exiting', () => {
    const black = run(initialPresentState(1, 3), { type: 'black' }).state;
    expect(black.black).toBe(true);
    expect(run(black, { type: 'next' }).state).toEqual({ index: 1, black: false, ended: false });
    const esc = run(black, { type: 'escape' });
    expect(esc.exit).toBe(false);
    expect(esc.state.black).toBe(false);
    expect(run(esc.state, { type: 'escape' }).exit).toBe(true);
    expect(run(black, { type: 'black' }).state.black).toBe(false);
    expect(run(black, { type: 'exit' }).exit).toBe(true);
  });
});

describe('presentKey', () => {
  const act = (key: string, buf = '') => presentKey(key, buf).action;
  it('maps next, previous, home/end, black, escape and presenter', () => {
    for (const k of ['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter', 'n', 'N']) expect(act(k)).toEqual({ type: 'next' });
    for (const k of ['ArrowLeft', 'ArrowUp', 'Backspace', 'PageUp', 'p', 'P']) expect(act(k)).toEqual({ type: 'prev' });
    expect(act('Home')).toEqual({ type: 'first' });
    expect(act('End')).toEqual({ type: 'last' });
    expect(act('b')).toEqual({ type: 'black' });
    expect(act('.')).toEqual({ type: 'black' });
    expect(act('Escape')).toEqual({ type: 'escape' });
    expect(act('S')).toBe('presenter');
    expect(act('x')).toBeNull();
  });
  it('collects digits and goes on Enter', () => {
    const a = presentKey('1', '');
    const b = presentKey('2', a.buffer);
    expect(b).toEqual({ action: null, buffer: '12' });
    expect(presentKey('Enter', b.buffer)).toEqual({ action: { type: 'goto', index: 11 }, buffer: '' });
    expect(presentKey('x', '12').buffer).toBe('');
  });
});

describe('payload parsing', () => {
  const good = { deckId: 'd1', index: 2, black: false, ended: false, startedAt: 5 };
  it('accepts exact payloads for this deck only', () => {
    expect(parseStatePayload(good, 'd1')).toEqual(good);
    expect(parseStatePayload(good, 'd2')).toBeNull();
    expect(parseStatePayload({ ...good, black: 'no' }, 'd1')).toBeNull();
    expect(parseStatePayload(null, 'd1')).toBeNull();
    expect(parseCommandPayload({ deckId: 'd1', action: 'goto', index: 3 }, 'd1')).toEqual({
      deckId: 'd1',
      action: 'goto',
      index: 3,
    });
    expect(parseCommandPayload({ deckId: 'd1', action: 'goto' }, 'd1')).toBeNull();
    expect(parseCommandPayload({ deckId: 'other', action: 'next' }, 'd1')).toBeNull();
    expect(parseCommandPayload({ deckId: 'd1', action: 'explode' }, 'd1')).toBeNull();
  });
  it('turns a command into an action', () => {
    expect(commandToAction({ deckId: 'd', action: 'goto', index: 4 })).toEqual({ type: 'goto', index: 4 });
    expect(commandToAction({ deckId: 'd', action: 'exit' })).toEqual({ type: 'exit' });
  });
});

describe('route and placement', () => {
  it('reads ?presenter=<id>', () => {
    expect(parsePresenterRoute('?presenter=abc')).toBe('abc');
    expect(parsePresenterRoute('?presenter=')).toBeNull();
    expect(parsePresenterRoute('')).toBeNull();
    expect(parsePresenterRoute('?x=1')).toBeNull();
  });
  const m = (x: number, w = 1920) => ({ name: null, position: { x, y: 0 }, size: { width: w, height: 1080 }, scaleFactor: 1 });
  it('picks a monitor other than the current one', () => {
    expect(otherMonitor([m(0)], m(0))).toBeNull();
    expect(otherMonitor([m(0), m(1920)], m(0))).toEqual(m(1920));
    expect(otherMonitor([m(0), m(1920)], m(1920))).toEqual(m(0));
  });
  it('centres the window on it, in logical pixels', () => {
    expect(centerOnMonitor(m(1920), 1100, 700)).toEqual({ x: 1920 + 410, y: 190 });
    expect(centerOnMonitor({ ...m(2000, 4000), scaleFactor: 2 }, 1100, 700)).toEqual({ x: 1450, y: 0 });
  });
  it('formats elapsed time', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(65_000)).toBe('01:05');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
  });
});
