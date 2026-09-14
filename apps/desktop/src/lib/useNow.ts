import { useEffect, useState } from 'react';

/**
 * The current time, refreshed every `intervalMs` while `active`.
 *
 * For UI that has to change when nothing else does — "still working" appears
 * precisely because no new event arrived to trigger a render.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [active, intervalMs]);
  return now;
}
