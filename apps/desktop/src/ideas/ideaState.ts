/// What this device remembers about ideas. Never sent anywhere: it orders and
/// hides suggestions and nothing else, and "Reset" clears it.
///
/// localStorage, like the other presentation prefs (`shell/uiPrefs.ts`) — it
/// is not an app setting, and losing it only means seeing a tried idea again.

import { useSyncExternalStore } from 'react';
import { CAPABILITIES, type Capability } from './catalog';

const KEY = 'conduit:ideas-state';

export interface IdeaState {
  /// Ideas whose chat was sent.
  tried: string[];
  /// The idea whose prompt is in the composer, until the first message goes.
  pending: string | null;
  /// New chats started without the idea row, in a row. The row stops showing
  /// after `ROW_GIVE_UP` — the user knows what they want.
  startsWithoutIdea: number;
  /// The user turned the empty-chat row off.
  rowHidden: boolean;
  /// `IDEAS_REVISION` last shown on the Ideas page; null before the first run.
  seenRevision: number | null;
  /// Capabilities that were ready last time we looked; null before the first
  /// look, so a fresh install spotlights nothing.
  knownReady: Capability[] | null;
  /// Capabilities that became ready and have not been shown yet.
  spotlight: Capability[];
  /// Capability follow-up chips: times offered, and whether used.
  chipOffers: Record<string, number>;
  chipUsed: string[];
}

export const ROW_GIVE_UP = 5;
/// A capability chip offered this many times without use is not offered again.
export const CHIP_GIVE_UP = 3;

const EMPTY: IdeaState = {
  tried: [],
  pending: null,
  startsWithoutIdea: 0,
  rowHidden: false,
  seenRevision: null,
  knownReady: null,
  spotlight: [],
  chipOffers: {},
  chipUsed: [],
};

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function capabilities(v: unknown): Capability[] {
  return strings(v).filter((x): x is Capability => (CAPABILITIES as readonly string[]).includes(x));
}

function load(): IdeaState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const d = JSON.parse(raw) as Record<string, unknown>;
    const offers: Record<string, number> = {};
    if (d.chipOffers && typeof d.chipOffers === 'object') {
      for (const [k, v] of Object.entries(d.chipOffers as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) offers[k] = v;
      }
    }
    return {
      tried: strings(d.tried),
      pending: typeof d.pending === 'string' ? d.pending : null,
      startsWithoutIdea: typeof d.startsWithoutIdea === 'number' ? d.startsWithoutIdea : 0,
      rowHidden: d.rowHidden === true,
      seenRevision: typeof d.seenRevision === 'number' ? d.seenRevision : null,
      knownReady: Array.isArray(d.knownReady) ? capabilities(d.knownReady) : null,
      spotlight: capabilities(d.spotlight),
      chipOffers: offers,
      chipUsed: strings(d.chipUsed),
    };
  } catch {
    return EMPTY;
  }
}

let current: IdeaState | null = null;
const listeners = new Set<() => void>();

export function getIdeaState(): IdeaState {
  if (!current) current = load();
  return current;
}

export function updateIdeaState(change: (state: IdeaState) => IdeaState): void {
  const next = change(getIdeaState());
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private window or full storage: keep it for this session */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useIdeaState(): IdeaState {
  return useSyncExternalStore(subscribe, getIdeaState, getIdeaState);
}

// ── Events ───────────────────────────────────────────────────────────────────

/// An idea's prompt was put in the composer.
export function notePicked(ideaId: string): void {
  updateIdeaState((s) => ({ ...s, pending: ideaId }));
}

/// The first message of a new chat was sent.
export function noteFirstMessage(): void {
  updateIdeaState((s) =>
    s.pending
      ? {
          ...s,
          pending: null,
          startsWithoutIdea: 0,
          tried: s.tried.includes(s.pending) ? s.tried : [...s.tried, s.pending],
        }
      : { ...s, startsWithoutIdea: s.startsWithoutIdea + 1 },
  );
}

export function setRowHidden(hidden: boolean): void {
  updateIdeaState((s) => ({ ...s, rowHidden: hidden, startsWithoutIdea: hidden ? s.startsWithoutIdea : 0 }));
}

export function markRevisionSeen(revision: number): void {
  updateIdeaState((s) => (s.seenRevision === revision ? s : { ...s, seenRevision: revision }));
}

/// Record which capabilities are ready now; any that were not before join the
/// spotlight. The first call only records.
export function observeReady(ready: Capability[]): void {
  updateIdeaState((s) => {
    if (s.knownReady == null) return { ...s, knownReady: ready };
    const fresh = ready.filter((c) => !s.knownReady!.includes(c) && !s.spotlight.includes(c));
    const same = ready.length === s.knownReady.length && ready.every((c) => s.knownReady!.includes(c));
    if (same && fresh.length === 0) return s;
    return { ...s, knownReady: ready, spotlight: [...s.spotlight, ...fresh].filter((c) => ready.includes(c)) };
  });
}

export function clearSpotlight(): void {
  updateIdeaState((s) => (s.spotlight.length === 0 ? s : { ...s, spotlight: [] }));
}

export function noteChipOffered(chipId: string): void {
  updateIdeaState((s) => ({ ...s, chipOffers: { ...s.chipOffers, [chipId]: (s.chipOffers[chipId] ?? 0) + 1 } }));
}

export function noteChipUsed(chipId: string): void {
  updateIdeaState((s) => (s.chipUsed.includes(chipId) ? s : { ...s, chipUsed: [...s.chipUsed, chipId] }));
}

/// Forget everything above (Ideas page → Reset).
export function resetIdeaState(): void {
  updateIdeaState((s) => ({ ...EMPTY, seenRevision: s.seenRevision, knownReady: s.knownReady }));
}

/// Tests only.
export function __resetIdeaStateForTests(): void {
  current = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
