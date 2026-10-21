/// The user's agents (the agent library) for the workflow screens: read once when
/// a provider opens, so a helper that is one of them can show its name and the
/// helpers section can offer them. Reading fails quietly; the screens work
/// without the names (a helper then shows its id).

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { listLibraryAgents } from '../ipc/client';
import type { LibraryAgent } from '../ipc/contracts';

/// Names by library id.
export function libraryNames(agents: readonly LibraryAgent[]): Record<string, string> {
  return Object.fromEntries(agents.map((a) => [a.agent.id, a.agent.name || a.agent.id]));
}

export interface LibraryState {
  /// `null` until the first read answers (or when it failed).
  agents: LibraryAgent[] | null;
  names: Record<string, string>;
  /// Read the list again (after an agent was added).
  reload: () => void;
}

const NONE: LibraryState = { agents: null, names: {}, reload: () => {} };
const LibraryContext = createContext<LibraryState>(NONE);

export function LibraryAgentsProvider({ children }: { children: ReactNode }) {
  const [agents, setAgents] = useState<LibraryAgent[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => listLibraryAgents())
      .then((list) => {
        if (!cancelled) setAgents(Array.isArray(list) ? list : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const value = useMemo(() => ({ agents, names: agents ? libraryNames(agents) : {}, reload }), [agents, reload]);
  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

/// The library from the nearest provider (nothing loaded outside one).
export function useLibraryAgents(): LibraryState {
  return useContext(LibraryContext);
}
