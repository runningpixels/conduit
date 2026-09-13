/**
 * The window's title follows the open chat.
 *
 * It was never set, so the taskbar, Alt-Tab and every window switcher showed
 * the product name for every window, whatever it was showing — no way to pick
 * the right one out of two. Now it reads "<chat> — <app>", or just the app name
 * before a chat has a name.
 *
 * Set on both `document.title` (dev:web, and what a webview reports) and the
 * native window through Tauri, which needs `core:window:allow-set-title` in
 * `capabilities/default.json` — a core window permission, inside the `core:*`
 * surface ADR-008 keeps.
 */

import { useEffect } from 'react';
import { appName } from '../brand';
import { useT } from '../i18n';

function hasTauriBridge(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function useWindowTitle(chatTitle: string | undefined): void {
  const t = useT();
  const app = appName();
  const full = chatTitle ? t('app.windowTitle', { title: chatTitle, appName: app }) : app;

  useEffect(() => {
    document.title = full;
    if (!hasTauriBridge()) return;
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(full))
      .catch(() => {
        /* A title is cosmetic; never surface a failure to set one. */
      });
  }, [full]);
}
