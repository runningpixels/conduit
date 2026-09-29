/// Send the tray its text in the user's language (the tray itself is Rust's,
/// which has no locale): on startup, when the language changes, and whenever
/// the number of running workflows changes, since the menu and the quit prompt
/// count them.

import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { appName } from '../brand';
import type { Translate } from '../i18n';
import { getRunningWorkflowCount, setTrayLabels, type TrayLabels } from '../ipc/client';

/// Emitted by Rust with the new count whenever a run starts or ends.
export const RUNS_CHANGED_EVENT = 'workflow-runs-changed';

export function trayLabels(t: Translate, count: number): TrayLabels {
  return {
    open: t('shell.tray.open'),
    quit: t('shell.tray.quit'),
    tooltip: appName(),
    count,
    running: count > 0 ? t('shell.tray.running', { count }) : '',
    stopAll: t('shell.tray.stopAll'),
    confirmTitle: t('shell.tray.confirmTitle'),
    confirmBody: count > 0 ? t('shell.tray.confirmBody', { count }) : '',
    confirmQuit: t('shell.tray.confirmQuit'),
    confirmCancel: t('shell.tray.confirmCancel'),
  };
}

export function useTrayLabels(t: Translate) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void listen<number>(RUNS_CHANGED_EVENT, (e) => setCount(e.payload)).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    void getRunningWorkflowCount().then(
      (n) => {
        if (!cancelled) setCount(n);
      },
      () => {},
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void setTrayLabels(trayLabels(t, count)).catch(() => {});
  }, [t, count]);
}
