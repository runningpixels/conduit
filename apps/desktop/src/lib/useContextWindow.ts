/**
 * The active model's context window, preferring the backend's bundled
 * models.dev snapshot over the renderer's family table in `contextWindows.ts`.
 *
 * The family table guesses by id prefix (every `deepseek*` id is 128K there),
 * which goes stale as a family grows; the snapshot carries each model's real
 * window (DeepSeek V4 is 1M). The table still answers for models the snapshot
 * does not know, and while the lookup is in flight.
 */

import { useEffect, useState } from 'react';
import { resolveContextWindows } from '../ipc/client';
import { getContextWindow } from './contextWindows';

const keyOf = (providerId: string, modelId: string) => `${providerId}\u0000${modelId}`;

/** Snapshot answers, kept for the session: the snapshot is fixed at build time. */
const resolved = new Map<string, number | null>();

/** Context window (tokens) for a provider's model; null when unknown. */
export function useContextWindow(providerId: string, modelId: string): number | null {
  const key = keyOf(providerId, modelId);
  // Bumped when an answer lands, so the cached value below is re-read.
  const [, setRevision] = useState(0);

  useEffect(() => {
    if (!providerId || !modelId || resolved.has(key)) return;
    let cancelled = false;
    void (async () => {
      try {
        const [value] = await resolveContextWindows(providerId, [modelId]);
        resolved.set(key, typeof value === 'number' && value > 0 ? value : null);
        if (!cancelled) setRevision((n) => n + 1);
      } catch {
        // No backend answer: the family table decides. Not cached, so the
        // next mount asks again.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [key, providerId, modelId]);

  return resolved.get(key) ?? getContextWindow(modelId);
}
