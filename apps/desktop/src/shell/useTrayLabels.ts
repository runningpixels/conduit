/// Send the tray menu its labels in the user's language (the tray itself is
/// Rust's, which has no locale): on startup and whenever the language changes.

import { useEffect } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { appName } from '../brand';
import type { Translate } from '../i18n';
import { setTrayLabels } from '../ipc/client';

export function trayLabels(t: Translate): { open: string; quit: string; tooltip: string } {
  return { open: t('shell.tray.open'), quit: t('shell.tray.quit'), tooltip: appName() };
}

export function useTrayLabels(t: Translate) {
  useEffect(() => {
    if (!isTauri()) return;
    const { open, quit, tooltip } = trayLabels(t);
    void setTrayLabels(open, quit, tooltip).catch(() => {});
  }, [t]);
}
