/// Pure pieces of Present: the state machine, the key map, the event payloads
/// that keep the presenter window in step, and the `?presenter=` route.

export const PRESENT_STATE_EVENT = 'slides://present-state';
export const PRESENT_HELLO_EVENT = 'slides://present-hello';
export const PRESENT_COMMAND_EVENT = 'slides://present-command';
export const PRESENT_CLOSED_EVENT = 'slides://present-closed';
export const PRESENTER_LABEL = 'presenter';

export interface PresentState {
  index: number;
  black: boolean;
  /** Past the last slide: the "End of slide show" screen. */
  ended: boolean;
}

export type PresentAction =
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'goto'; index: number }
  | { type: 'first' }
  | { type: 'last' }
  | { type: 'black' }
  /** Esc: un-black first, then leave. */
  | { type: 'escape' }
  /** Leave now (the presenter's End show). */
  | { type: 'exit' };

export interface PresentStep {
  state: PresentState;
  exit: boolean;
}

export function initialPresentState(index: number, count: number): PresentState {
  return { index: clampIndex(index, count), black: false, ended: false };
}

export function clampIndex(index: number, count: number): number {
  return Math.max(0, Math.min(Math.max(0, count - 1), Math.floor(Number.isFinite(index) ? index : 0)));
}

/** Any move while the screen is black only un-blacks it. */
export function reducePresent(state: PresentState, action: PresentAction, count: number): PresentStep {
  const stay = (s: PresentState): PresentStep => ({ state: s, exit: false });
  if (action.type === 'exit') return { state, exit: true };
  if (action.type === 'black') return stay({ ...state, black: !state.black });
  if (state.black) return stay({ ...state, black: false });
  switch (action.type) {
    case 'escape':
      return { state, exit: true };
    case 'next':
      if (state.ended) return { state, exit: true };
      if (state.index >= count - 1) return stay({ ...state, ended: true });
      return stay({ ...state, index: state.index + 1 });
    case 'prev':
      if (state.ended) return stay({ ...state, ended: false });
      return stay({ ...state, index: Math.max(0, state.index - 1) });
    case 'goto':
      return stay({ ...state, index: clampIndex(action.index, count), ended: false });
    case 'first':
      return stay({ ...state, index: 0, ended: false });
    case 'last':
      return stay({ ...state, index: clampIndex(count - 1, count), ended: false });
  }
}

export type PresentKeyResult = { action: PresentAction | 'presenter' | null; buffer: string };

/** Key map shared by the presenting view and the presenter window. `buffer` is the
 *  digits typed so far for "number, then Enter". */
export function presentKey(key: string, buffer: string): PresentKeyResult {
  if (/^[0-9]$/.test(key)) return { action: null, buffer: (buffer + key).slice(0, 4) };
  if (key === 'Enter' && buffer !== '') {
    const n = Number.parseInt(buffer, 10);
    return { action: { type: 'goto', index: n - 1 }, buffer: '' };
  }
  const lower = key.length === 1 ? key.toLowerCase() : key;
  let action: PresentKeyResult['action'] = null;
  switch (lower) {
    case 'ArrowRight':
    case 'ArrowDown':
    case ' ':
    case 'PageDown':
    case 'Enter':
    case 'n':
      action = { type: 'next' };
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
    case 'Backspace':
    case 'PageUp':
    case 'p':
      action = { type: 'prev' };
      break;
    case 'Home':
      action = { type: 'first' };
      break;
    case 'End':
      action = { type: 'last' };
      break;
    case 'b':
    case '.':
      action = { type: 'black' };
      break;
    case 'Escape':
      action = { type: 'escape' };
      break;
    case 's':
      action = 'presenter';
      break;
  }
  return { action, buffer: '' };
}

// ── Event payloads ────────────────────────────────────────────────────────

export interface PresentStatePayload extends PresentState {
  deckId: string;
  startedAt: number;
}
export interface PresentHelloPayload {
  deckId: string;
}
export type PresentCommandAction = 'next' | 'prev' | 'goto' | 'black' | 'exit';
export interface PresentCommandPayload {
  deckId: string;
  action: PresentCommandAction;
  index?: number;
}
export interface PresentClosedPayload {
  deckId: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => v != null && typeof v === 'object';

/** Payloads are untrusted (any window can emit): each parser returns null unless
 *  the shape is exact and the deck is the one we are showing. */
export function parseStatePayload(v: unknown, deckId: string): PresentStatePayload | null {
  if (!isObj(v) || v.deckId !== deckId) return null;
  if (typeof v.index !== 'number' || !Number.isFinite(v.index)) return null;
  if (typeof v.black !== 'boolean' || typeof v.ended !== 'boolean') return null;
  if (typeof v.startedAt !== 'number' || !Number.isFinite(v.startedAt)) return null;
  return { deckId, index: Math.max(0, Math.floor(v.index)), black: v.black, ended: v.ended, startedAt: v.startedAt };
}

export function parseHelloPayload(v: unknown, deckId: string): PresentHelloPayload | null {
  return isObj(v) && v.deckId === deckId ? { deckId } : null;
}

export function parseClosedPayload(v: unknown, deckId: string): PresentClosedPayload | null {
  return isObj(v) && v.deckId === deckId ? { deckId } : null;
}

export function parseCommandPayload(v: unknown, deckId: string): PresentCommandPayload | null {
  if (!isObj(v) || v.deckId !== deckId) return null;
  const a = v.action;
  if (a !== 'next' && a !== 'prev' && a !== 'goto' && a !== 'black' && a !== 'exit') return null;
  if (a === 'goto') {
    if (typeof v.index !== 'number' || !Number.isFinite(v.index)) return null;
    return { deckId, action: a, index: Math.floor(v.index) };
  }
  return { deckId, action: a };
}

export function commandToAction(c: PresentCommandPayload): PresentAction {
  if (c.action === 'goto') return { type: 'goto', index: c.index ?? 0 };
  return { type: c.action };
}

// ── Route ────────────────────────────────────────────────────────────────

/** The deck id from `?presenter=<id>`, or null when this is the main window. */
export function parsePresenterRoute(search: string): string | null {
  const id = new URLSearchParams(search).get('presenter');
  return id != null && id.trim() !== '' ? id : null;
}

// ── Placement ─────────────────────────────────────────────────────────────

export interface MonitorLike {
  name: string | null;
  position: { x: number; y: number };
  size: { width: number; height: number };
  scaleFactor: number;
}

/** A monitor that is not the main window's, or null with only one. */
export function otherMonitor<M extends MonitorLike>(all: readonly M[], current: MonitorLike | null): M | null {
  if (all.length < 2) return null;
  const same = (m: MonitorLike) =>
    current != null &&
    m.position.x === current.position.x &&
    m.position.y === current.position.y &&
    m.size.width === current.size.width &&
    m.size.height === current.size.height;
  return all.find((m) => !same(m)) ?? null;
}

/** Logical top-left that centres a w x h window on the monitor. */
export function centerOnMonitor(m: MonitorLike, w: number, h: number): { x: number; y: number } {
  const s = m.scaleFactor || 1;
  const x = m.position.x / s + Math.max(0, (m.size.width / s - w) / 2);
  const y = m.position.y / s + Math.max(0, (m.size.height / s - h) / 2);
  return { x: Math.round(x), y: Math.round(y) };
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
