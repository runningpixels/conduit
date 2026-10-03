/// A Research run as the chat card sees it: fetched once, then refetched
/// whenever Rust says it changed.
///
/// Rust emits the app-wide event `research-run-updated` (`{ runId, status }`,
/// at most four a second while a run progresses) rather than streaming over a
/// channel, so the card keeps updating after the user navigates away and back.
/// The payload is only a nudge: the state itself is always read with
/// `getResearchRun`, so a missed or reordered event can never leave the card
/// showing something older than what the next one reads.

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getResearchRun } from '../../ipc/client';
import type { ResearchRun, ResearchStatus } from '../../ipc/contracts';

export const RESEARCH_UPDATED_EVENT = 'research-run-updated';

export interface ResearchRunUpdated {
  runId: string;
  status: ResearchStatus;
}

export interface ResearchRunState {
  run: ResearchRun | null;
  /** Why the run could not be read; null once a read succeeds. */
  loadError: string | null;
  /** Replace the run with a newer copy a command just returned. */
  accept: (run: ResearchRun) => void;
  refresh: () => Promise<void>;
}

export function useResearchRun(runId: string): ResearchRunState {
  const [run, setRun] = useState<ResearchRun | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Only the newest read may land: an older response arriving late is dropped.
  const readSeq = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    const seq = ++readSeq.current;
    try {
      const next = await getResearchRun(runId);
      if (!alive.current || seq !== readSeq.current) return;
      setRun(next);
      setLoadError(null);
    } catch (error) {
      if (!alive.current || seq !== readSeq.current) return;
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [runId]);

  const accept = useCallback((next: ResearchRun) => {
    // A command's reply is newer than any read already in flight.
    readSeq.current += 1;
    setRun(next);
    setLoadError(null);
  }, []);

  useEffect(() => {
    setRun(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void listen<ResearchRunUpdated>(RESEARCH_UPDATED_EVENT, (event) => {
      if (event.payload?.runId === runId) void refresh();
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [runId, refresh]);

  return { run, loadError, accept, refresh };
}
