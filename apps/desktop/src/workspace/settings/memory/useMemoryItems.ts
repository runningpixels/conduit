/// Memory items and the one `run` wrapper every action goes through (busy
/// flag, status message, reload, failure message). Shared by the Memory page
/// and the Settings sheet's `MemorySection`.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MemoryItem } from '../../../ipc/contracts';
import { listMemoryItems } from '../../../ipc/client';
import { useT } from '../../../i18n';

export function useMemoryItems(onStatus: (message: string) => void) {
  const t = useT();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  // Read through refs so a new callback or `t` doesn't start another load.
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const tRef = useRef(t);
  tRef.current = t;
  // Loads can overlap (the initial one, then a reload after a save). Only the
  // newest may land: an older answer arriving late would put back the list
  // from before the save.
  const latestLoad = useRef(0);

  const refresh = useCallback(async () => {
    const load = ++latestLoad.current;
    try {
      const next = await listMemoryItems();
      if (load === latestLoad.current) setItems(next);
    } catch (e) {
      if (load === latestLoad.current) {
        onStatusRef.current(tRef.current('settings.memory.status.loadFailed', { error: String(e) }));
      }
    } finally {
      if (load === latestLoad.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function run(label: string, action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    try {
      await action();
      onStatus(label);
      await refresh();
      return true;
    } catch (e) {
      onStatus(t('settings.memory.status.actionFailed', { label, error: String(e) }));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return {
    items,
    loaded,
    busy,
    run,
    pending: items.filter((i) => i.status === 'pending'),
    active: items.filter((i) => i.status === 'active'),
  };
}
