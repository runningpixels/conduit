/// Events Rust emits about apps, and a hook to follow them.
///
/// `app-changed` fires after an app is edited, refreshed from its source,
/// deleted, installed or uninstalled; `open-app-in-main` asks the main window
/// to show an app (from an app's own window, "Open in Conduit").

import { useEffect, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const APP_CHANGED_EVENT = 'app-changed';
export const OPEN_APP_IN_MAIN_EVENT = 'open-app-in-main';

export interface AppChanged {
  id: string;
  /** `installed`: installed on or removed from this computer; the app itself is unchanged. */
  kind: 'updated' | 'installed' | 'deleted';
}

/** Call `onEvent` for every `name` event while mounted. A no-op outside Tauri. */
export function useTauriEvent<T>(name: string, onEvent: (payload: T) => void) {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void listen<T>(name, (e) => handler.current(e.payload)).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [name]);
}

export function useAppChanged(onChanged: (event: AppChanged) => void) {
  useTauriEvent<AppChanged>(APP_CHANGED_EVENT, onChanged);
}
