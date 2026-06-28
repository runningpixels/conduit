import { useRef, useCallback } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import { updateSettings } from '../../ipc/client';

/**
 * Auto-save hook: updates local state immediately (optimistic UI) and
 * persists async with a 250ms debounce. Returns a callback that callers
 * use instead of raw `onSettingsChange`.
 */
export function useAutoSave(
  onSettingsChange: (s: AppSettings) => void,
  onStatus: (message: string) => void,
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<AppSettings | null>(null);

  const flush = useCallback(async (settings: AppSettings) => {
    try {
      const persisted = await updateSettings(settings);
      // Use the Rust-normalized version (in case it adjusts anything)
      onSettingsChange(persisted);
    } catch (e) {
      const message = e instanceof Error ? e.message : typeof e === 'string' ? e : String(e);
      onStatus(`Settings save failed: ${message}`);
    }
  }, [onSettingsChange, onStatus]);

  const save = useCallback((next: AppSettings) => {
    // Optimistic: update local state immediately
    onSettingsChange(next);
    // Store the latest value for debounce
    pendingRef.current = next;
    // Clear any pending timer
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    // Debounce: persist 250ms after the last change
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (pendingRef.current) {
        void flush(pendingRef.current);
        pendingRef.current = null;
      }
    }, 250);
  }, [onSettingsChange, flush]);

  return save;
}
