/// Settings → Chat: the quick-ask shortcut. A small recorder — focus it, press
/// a combination, and it is saved (Rust registers it before saving, so a key
/// another app holds is refused with a reason). Clear turns it off. Hidden,
/// with a note, where global shortcuts can't work (a Wayland session).
///
/// The recorder hears key presses inside the app's own window only, which is
/// all it needs: the user is in Settings when they pick the keys.

import { useEffect, useState, type KeyboardEvent } from 'react';
import type { AppSettings } from '../ipc/contracts';
import { updateSettings } from '../ipc/client';
import { translateError } from '../ipc/errors';
import { useT } from '../i18n';
import { getQuickAskStatus, type QuickAskStatus } from './quickAskIpc';
import { shortcutFromPress } from './shortcut';

export function QuickAskSetting({
  settings,
  onSettingsChange,
  onStatus,
}: {
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  onStatus: (message: string) => void;
}) {
  const t = useT();
  const current = settings.quickAskShortcut ?? null;
  const [status, setStatus] = useState<QuickAskStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getQuickAskStatus().then((s) => {
      if (cancelled) return;
      setStatus(s);
      if (s.error && current) setError(t('shell.settingsSheet.chat.quickAsk.failed', { shortcut: current }));
    });
    return () => {
      cancelled = true;
    };
    // Read once, when the row appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (next: string | null) => {
    setSaving(true);
    setHint(null);
    try {
      // Same keys as a shortcut that failed at startup: clear first, so the
      // save is a change and Rust tries to register it again.
      if (next !== null && next === current && error) await updateSettings({ quickAskShortcut: null });
      const persisted = await updateSettings({ quickAskShortcut: next });
      onSettingsChange(persisted);
      setError(null);
      onStatus(
        next
          ? t('shell.settingsSheet.chat.quickAsk.saved', { shortcut: next })
          : t('shell.settingsSheet.chat.quickAsk.cleared'),
      );
    } catch (e) {
      if (next) {
        setError(t('shell.settingsSheet.chat.quickAsk.failed', { shortcut: next }));
        console.warn('quick ask shortcut not set', e);
      } else {
        onStatus(t('settings.autoSave.failed', { error: translateError(e, t) }));
      }
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const plain = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
    // Tab still moves focus; Esc on its own stops recording.
    if (plain && event.key === 'Tab') return;
    event.preventDefault();
    event.stopPropagation();
    if (plain && event.key === 'Escape') {
      event.currentTarget.blur();
      return;
    }
    const press = shortcutFromPress(event.nativeEvent);
    if (press.kind === 'partial') {
      setHeld(press.display);
      setHint(null);
      return;
    }
    setHeld('');
    if (press.kind === 'invalid') {
      setHint(t('shell.settingsSheet.chat.quickAsk.needsModifier'));
      return;
    }
    event.currentTarget.blur();
    void save(press.shortcut);
  };

  const label = t('shell.settingsSheet.chat.quickAsk.label');
  if (status && !status.supported) {
    return (
      <div className="srow">
        <span className="srow-text">
          <b>{label}</b>
          <small>{t('shell.settingsSheet.chat.quickAsk.unsupported')}</small>
        </span>
      </div>
    );
  }

  const shown = recording
    ? held || t('shell.settingsSheet.chat.quickAsk.recording')
    : current ?? t('shell.settingsSheet.chat.quickAsk.off');

  return (
    <div className="srow quick-ask-row">
      <span className="srow-text">
        <b>{label}</b>
        <small>{t('shell.settingsSheet.chat.quickAsk.help')}</small>
        {hint ? <small className="quick-ask-hint">{hint}</small> : null}
        {error ? (
          <small className="quick-ask-error" role="alert">
            {error}
          </small>
        ) : null}
      </span>
      <span className="quick-ask-controls">
        <input
          type="text"
          readOnly
          className="quick-ask-recorder"
          data-recording={recording ? 'true' : undefined}
          aria-label={t('shell.settingsSheet.chat.quickAsk.recorderAriaLabel')}
          value={shown}
          disabled={saving}
          onFocus={() => {
            setRecording(true);
            setHint(null);
          }}
          onBlur={() => {
            setRecording(false);
            setHeld('');
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(event) => {
            if (!recording) return;
            const press = shortcutFromPress(event.nativeEvent);
            if (press.kind === 'partial') setHeld(press.display);
          }}
        />
        <button
          type="button"
          className="btn"
          disabled={saving || (current === null && !error)}
          onClick={() => void save(null)}
        >
          {t('shell.settingsSheet.chat.quickAsk.clear')}
        </button>
      </span>
    </div>
  );
}
