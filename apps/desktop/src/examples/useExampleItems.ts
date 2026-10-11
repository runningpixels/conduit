import { useCallback, useEffect, useState } from 'react';
import { listExampleItems } from '../ipc/client';
import type { ExampleItem } from '../ipc/contracts';

/** Fired after examples are added or removed, so lists can refresh. */
export const EXAMPLES_CHANGED_EVENT = 'conduit:examples-changed';

export function notifyExamplesChanged(): void {
  window.dispatchEvent(new Event(EXAMPLES_CHANGED_EVENT));
}

/**
 * The items Conduit added on first run. Loads once and again whenever
 * `conduit:examples-changed` fires; a failed lookup means no chips.
 */
export function useExampleItems(): {
  items: ExampleItem[];
  isExample: (kind: ExampleItem['kind'], id: string) => boolean;
} {
  const [items, setItems] = useState<ExampleItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void Promise.resolve()
        .then(() => listExampleItems())
        .then((list) => {
          if (!cancelled) setItems(Array.isArray(list) ? list : []);
        })
        .catch(() => {});
    };
    load();
    window.addEventListener(EXAMPLES_CHANGED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(EXAMPLES_CHANGED_EVENT, load);
    };
  }, []);
  const isExample = useCallback(
    (kind: ExampleItem['kind'], id: string) => items.some((i) => i.kind === kind && i.itemId === id),
    [items],
  );
  return { items, isExample };
}
