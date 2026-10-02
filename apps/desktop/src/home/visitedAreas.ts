/// Which areas of the app this device has opened, and how Home shows them.
///
/// Home adapts to how much of the app someone has used: job cards while they
/// are new, compact tiles once they know their way around. The only thing it
/// needs is "has this area ever been opened here", so that is all this keeps.
/// Never sent anywhere; losing it only means seeing the guide again.
///
/// localStorage, like the other presentation prefs (`ideas/ideaState.ts`).

import { useSyncExternalStore } from 'react';

/// The eight areas Home counts and explains, in the order Home lists them.
export const AREAS = ['chats', 'slides', 'apps', 'documents', 'workflows', 'library', 'connectors', 'memory'] as const;
export type Area = (typeof AREAS)[number];

export function isArea(value: string): value is Area {
  return (AREAS as readonly string[]).includes(value);
}

/// Opened this many areas (or more) and Home shows the compact tiles by default.
export const EXPERIENCED_AT = 5;

export type HomeView = 'guide' | 'compact';

const VISITED_KEY = 'conduit:home-visited-v1';
const VIEW_KEY = 'conduit:home-view-v1';

interface State {
  visited: readonly Area[];
  /// The reader's own choice, if they made one; null means "decide by use".
  view: HomeView | null;
}

function load(): State {
  let visited: Area[] = [];
  let view: HomeView | null = null;
  try {
    const raw = localStorage.getItem(VISITED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      visited = AREAS.filter((a) => parsed.includes(a));
    }
  } catch {
    /* unreadable or blocked: start fresh */
  }
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (raw === 'guide' || raw === 'compact') view = raw;
  } catch {
    /* blocked: decide by use */
  }
  return { visited, view };
}

let current: State | null = null;
const listeners = new Set<() => void>();

function state(): State {
  if (!current) current = load();
  return current;
}

function commit(next: State, key: string, value: string): void {
  current = next;
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window or full storage: keep it for this session */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/// Record the first time an area is opened. Anything that is not one of the
/// eight areas (Home itself, Settings, Ideas) is ignored.
export function markVisited(area: string): void {
  if (!isArea(area)) return;
  const s = state();
  if (s.visited.includes(area)) return;
  const visited = AREAS.filter((a) => a === area || s.visited.includes(a));
  commit({ ...s, visited }, VISITED_KEY, JSON.stringify(visited));
}

/// Pick the guide or the compact tiles, and remember it.
export function setHomeView(view: HomeView): void {
  const s = state();
  if (s.view === view) return;
  commit({ ...s, view }, VIEW_KEY, view);
}

export function getVisitedAreas(): readonly Area[] {
  return state().visited;
}

export function useVisitedAreas(): readonly Area[] {
  return useSyncExternalStore(
    subscribe,
    () => state().visited,
    () => state().visited,
  );
}

/// The view Home shows: the reader's choice, else compact once they have
/// opened `EXPERIENCED_AT` areas, else the guide.
export function resolveHomeView(visitedCount: number, choice: HomeView | null): HomeView {
  return choice ?? (visitedCount >= EXPERIENCED_AT ? 'compact' : 'guide');
}

export function useHomeView(): { view: HomeView; setView: (view: HomeView) => void } {
  const visited = useVisitedAreas();
  const choice = useSyncExternalStore(
    subscribe,
    () => state().view,
    () => state().view,
  );
  return { view: resolveHomeView(visited.length, choice), setView: setHomeView };
}

/// Tests only.
export function __resetVisitedAreasForTests(): void {
  current = null;
  try {
    localStorage.removeItem(VISITED_KEY);
    localStorage.removeItem(VIEW_KEY);
  } catch {
    /* ignore */
  }
  for (const listener of listeners) listener();
}
