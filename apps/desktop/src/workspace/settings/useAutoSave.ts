import { useCallback, useEffect, useRef } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import { updateSettings } from '../../ipc/client';
import { translateError } from '../../ipc/errors';
import { useT } from '../../i18n';

/**
 * Auto-save hook: updates local state immediately (optimistic UI) and
 * persists async with a 250ms debounce. Returns a callback that callers
 * use instead of raw `onSettingsChange`.
 */
export function useAutoSave(
  onSettingsChange: (s: AppSettings) => void,
  onStatus: (message: string) => void,
) {
  const t = useT();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<AppSettings | null>(null);

  const flush = useCallback(async (settings: AppSettings) => {
    try {
      const persisted = await updateSettings(settings);
      // Use the Rust-normalized version (in case it adjusts anything)
      onSettingsChange(persisted);
    } catch (e) {
      onStatus(t('settings.autoSave.failed', { error: translateError(e, t) }));
    }
  }, [onSettingsChange, onStatus, t]);

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

  /* Settle the debounce when the caller goes away, instead of leaving a timer
   * running against a component that no longer exists.
   *
   * Both halves matter. Dropping the pending value would lose an edit made in
   * the last 250ms before the Settings sheet closed — the debounce exists to
   * batch keystrokes, not to discard the final one. And leaving the timer to
   * fire on its own schedule means a write can land at an arbitrary later
   * moment, after something newer has already been written: onboarding's
   * language switch re-mounts the whole app, so a stale flush arriving
   * afterwards would overwrite the freshly-persisted language with the value
   * that was current before the switch. Flushing here pins the write to
   * unmount, which is ordered.
   *
   * `flush` is deliberately not a dependency. It is rebuilt whenever
   * `onSettingsChange` or `t` changes identity, and depending on it would tear
   * down and re-run this cleanup on those renders — flushing mid-edit, which is
   * the opposite of debouncing. The ref always holds the latest pending value,
   * so the closure captured on mount is reading current data either way. */
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (pendingRef.current) {
        void flushRef.current(pendingRef.current);
        pendingRef.current = null;
      }
    },
    [],
  );

  return save;
}
