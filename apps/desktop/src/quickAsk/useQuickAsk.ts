/// The main page's half of quick ask: when the ask box sends a question, ask
/// it the way Home's ask box does. Rust keeps the question in a pending slot
/// and only signals; the page takes it on that signal and once when it becomes
/// ready (the box may have sent it while the page was still starting), so it
/// is asked exactly once. Until `ready` (boot, onboarding), it stays waiting.

import { useEffect, useRef } from 'react';
import { listenQuickAsk, takePendingQuickAsk } from './quickAskIpc';

export function useQuickAsk(ready: boolean, onAsk: (text: string) => void) {
  const handler = useRef(onAsk);
  handler.current = onAsk;

  useEffect(() => {
    if (!ready) return;
    // A taken question is always asked, even if this effect was torn down
    // while the take was in flight (StrictMode remounts): it is gone from the
    // slot, so dropping it here would lose it.
    const takeAndAsk = () => {
      void takePendingQuickAsk().then((text) => {
        if (text) handler.current(text);
      });
    };
    const stop = listenQuickAsk(takeAndAsk);
    takeAndAsk();
    return stop;
  }, [ready]);
}
