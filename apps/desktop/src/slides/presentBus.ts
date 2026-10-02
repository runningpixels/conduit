/// Tauri side of Present: the event bus between the presenting window and the
/// presenter window, the presenter window itself, and full screen. Every call
/// is guarded so tests and the plain browser do nothing instead of throwing.

import { isTauri } from '@tauri-apps/api/core';
import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { invokeCommand } from '../ipc/errors';
import { centerOnMonitor, otherMonitor, type MonitorLike } from './presentCore';

const WIDTH = 1100;
const HEIGHT = 700;

export async function emitPresent(event: string, payload: unknown): Promise<void> {
  if (!isTauri()) return;
  try {
    await emit(event, payload);
  } catch {
    /* the other window may already be gone */
  }
}

/** Subscribes; the returned function unsubscribes even if `listen` has not resolved yet. */
export function listenPresent(event: string, handler: (payload: unknown) => void): () => void {
  if (!isTauri()) return () => {};
  let off: UnlistenFn | null = null;
  let stopped = false;
  void listen<unknown>(event, (e) => handler(e.payload)).then(
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

/** Like `listenPresent`, but resolves once the subscription is live. */
export async function listenPresentReady(event: string, handler: (payload: unknown) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  try {
    return await listen<unknown>(event, (e) => handler(e.payload));
  } catch {
    return () => {};
  }
}

/** Opens the presenter window, or focuses it when it is already open. */
export async function openPresenterWindow(deckId: string, title: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { availableMonitors, currentMonitor } = await import('@tauri-apps/api/window');
    let spot: { x: number; y: number } | null = null;
    try {
      const [all, current] = await Promise.all([availableMonitors(), currentMonitor()]);
      const other = otherMonitor(all as MonitorLike[], current as MonitorLike | null);
      if (other) spot = centerOnMonitor(other, WIDTH, HEIGHT);
    } catch {
      /* fall back to centred */
    }
    // Rust builds the window (or focuses an open one): only it can give the
    // new webview the main webview's browser arguments, which WebView2
    // requires of every webview in the app.
    await invokeCommand('open_presenter_window', {
      deckId,
      title,
      x: spot?.x ?? null,
      y: spot?.y ?? null,
    });
  } catch (error) {
    // A window is optional; the show goes on without it.
    console.warn('presenter view did not open', error);
  }
}

export async function hasSecondMonitor(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { availableMonitors, currentMonitor } = await import('@tauri-apps/api/window');
    const [all, current] = await Promise.all([availableMonitors(), currentMonitor()]);
    return otherMonitor(all as MonitorLike[], current as MonitorLike | null) != null;
  } catch {
    return false;
  }
}

/** Goes full screen; resolves a function that restores the previous state. */
export async function enterFullscreen(): Promise<() => void> {
  if (!isTauri()) return () => {};
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const was = await win.isFullscreen();
    await win.setFullscreen(true);
    return () => {
      void win.setFullscreen(was).catch(() => {});
    };
  } catch {
    return () => {};
  }
}

export async function closeThisWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  } catch {
    /* nothing to close */
  }
}
