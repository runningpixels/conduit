/// Tauri side of quick ask: the ask box sends or hides itself, the main page
/// hears that a question is waiting and takes it, and Settings reads whether
/// the shortcut works. Every call is guarded so tests and the plain browser do
/// nothing instead of throwing. The shortcut itself is a setting
/// (`updateSettings({ quickAskShortcut })`).

import { isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invokeCommand } from '../ipc/errors';

/// Emitted by Rust to the main window when the ask box sent a question. It
/// carries nothing: the page takes the text with `takePendingQuickAsk`, so a
/// question sent before the page listened is still asked, and only once.
export const QUICK_ASK_EVENT = 'quick-ask';

export interface QuickAskStatus {
  /** False in a Wayland session, where global shortcuts don't work. */
  supported: boolean;
  /** Why the saved shortcut isn't registered (set at startup), if it isn't. */
  error: string | null;
}

/** Send the ask box's text; Rust hides the box and brings the main window up. */
export async function submitQuickAsk(text: string): Promise<boolean> {
  if (!isTauri()) return false;
  return invokeCommand<boolean>('submit_quick_ask', { text });
}

/** Hide the ask box. */
export async function hideQuickAsk(): Promise<void> {
  if (!isTauri()) return;
  await invokeCommand<void>('hide_quick_ask');
}

/** The question waiting for the main page, taken once; `null` when none. */
export async function takePendingQuickAsk(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    return (await invokeCommand<string | null>('take_pending_quick_ask')) ?? null;
  } catch {
    return null;
  }
}

export async function getQuickAskStatus(): Promise<QuickAskStatus> {
  if (!isTauri()) return { supported: true, error: null };
  try {
    return await invokeCommand<QuickAskStatus>('get_quick_ask_status');
  } catch {
    return { supported: true, error: null };
  }
}

/** Calls `onWaiting` whenever a question is sent; returns the unsubscribe. */
export function listenQuickAsk(onWaiting: () => void): () => void {
  if (!isTauri()) return () => {};
  let off: UnlistenFn | null = null;
  let stopped = false;
  void listen(QUICK_ASK_EVENT, () => onWaiting()).then(
    (fn) => {
      if (stopped) fn();
      else off = fn;
    },
    () => {},
  );
  return () => {
    stopped = true;
    off?.();
    off = null;
  };
}
