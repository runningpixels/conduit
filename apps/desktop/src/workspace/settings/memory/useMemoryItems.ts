/// Memory items and the one `run` wrapper every action goes through (busy
/// flag, status message, reload, failure message). Shared by the Memory page
/// and the Settings sheet's `MemorySection`.
import { useCallback, useEffect, useState } from 'react';
import type { MemoryItem } from '../../../ipc/contracts';
import { listMemoryItems } from '../../../ipc/client';
import { useT } from '../../../i18n';

export function useMemoryItems(onStatus: (message: string) => void) {
  const t = useT();
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setItems(await listMemoryItems());
    } catch (e) {
      onStatus(t('settings.memory.status.loadFailed', { error: String(e) }));
    } finally {
      setLoaded(true);
    }
  }, [onStatus, t]);

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
