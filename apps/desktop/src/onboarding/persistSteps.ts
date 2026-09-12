import { useCallback } from 'react';
import type { AppSettings } from '../ipc/contracts';
import { updateSettings } from '../ipc/client';
import { translateError } from '../ipc/errors';
import { useT } from '../i18n';

/**
 * Persistence for the onboarding steps that edit `AppSettings` directly
 * (appearance, privacy) rather than through a shared Settings section.
 *
 * Two writers, because one of these settings destroys the component that sets
 * it and the rest do not.
 *
 * **`apply` — optimistic, then write.** The ordinary path. The user sees the
 * change land on the screen they are standing on (theme repaints immediately
 * through App's effect), and the IPC write follows. Not debounced, unlike
 * `useAutoSave`: every control on these steps is a `select` or a checkbox, so
 * there is no keystroke stream to coalesce, and an un-debounced write cannot
 * lose a race against the language switch below.
 *
 * **`writeThenApply` — write, then apply. For language only.**
 * `I18nProvider` carries `key={locale}`, so announcing a new language
 * re-mounts the whole of `<App>`: `settings` resets to the placeholder,
 * `settingsLoaded` goes false, and the boot IPC re-runs. `App`'s reconcile
 * effect then calls `setPreference` with whatever Rust *just* returned. If the
 * language change were only optimistic local state, Rust would still hold the
 * old value, the reconcile would announce it, the locale would flip back — and
 * because that flip changes the key again, the remount can repeat. (The same
 * hazard is documented at length on App's language effect, and
 * `App.smoke.test.tsx` counts boots to guard it.) Landing the write before the
 * announcement means the re-mounted App reads back the language the user
 * actually chose, and the sequence settles after exactly one remount.
 *
 * Both writers send the whole settings object, not a narrow patch. The user
 * may already have chosen a provider and a model on a later step that are
 * still only in App's state; a narrow patch would return a normalized
 * `AppSettings` without them, and the re-mount would drop them on the floor.
 */
export function usePersistSteps(
  settings: AppSettings,
  onSettingsChange: (next: AppSettings) => void,
  onStatus: (message: string) => void,
) {
  const t = useT();

  const apply = useCallback(
    (next: AppSettings) => {
      onSettingsChange(next);
      void updateSettings(next).catch((e) => {
        onStatus(t('onboarding.settings.saveFailed', { error: translateError(e, t) }));
      });
    },
    [onSettingsChange, onStatus, t],
  );

  const writeThenApply = useCallback(
    async (next: AppSettings) => {
      try {
        await updateSettings(next);
      } catch (e) {
        onStatus(t('onboarding.settings.saveFailed', { error: translateError(e, t) }));
        return;
      }
      onSettingsChange(next);
    },
    [onSettingsChange, onStatus, t],
  );

  /** Narrow helper so a step can write one field without restating the spread. */
  const set = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
      apply({ ...settings, [key]: value });
    },
    [apply, settings],
  );

  return { apply, writeThenApply, set };
}
