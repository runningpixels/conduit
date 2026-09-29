/// Keep running in the background, so schedules run with the window closed.
///
/// Both switches are opt-in and live next to the schedule, where they matter:
/// "Keep running in the tray" (closing the window hides it; quit from the tray
/// icon) and "Start when I sign in", which only makes sense into the tray. The
/// first time a schedule is switched on, the tray is offered once.

import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { getSettings, getStartAtLogin, setStartAtLogin, updateSettings } from '../ipc/client';

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

export function BackgroundSection({
  scheduleEnabled,
  onStatus,
}: {
  /// Whether this workflow runs on a schedule.
  scheduleEnabled: boolean;
  onStatus: (message: string) => void;
}) {
  const t = useT();
  const [closeToTray, setCloseToTray] = useState<boolean | null>(null);
  const [offered, setOffered] = useState(false);
  /// `null` while unknown or unavailable (the switch is then left out).
  const [startAtLogin, setStartAtLoginState] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  /// Switched here: stays visible, so turning the tray off can be undone.
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getSettings().then(
      (s) => {
        if (cancelled) return;
        setCloseToTray(s.closeToTray);
        setOffered(s.closeToTrayOffered);
      },
      () => {},
    );
    void getStartAtLogin().then(
      (on) => {
        if (!cancelled) setStartAtLoginState(on);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const saveTray = async (enabled: boolean) => {
    setSaving(true);
    setTouched(true);
    try {
      const s = await updateSettings({ closeToTray: enabled, closeToTrayOffered: true });
      setCloseToTray(s.closeToTray);
      setOffered(true);
      // Turning the tray off also turns off starting at sign-in (Rust side).
      if (!enabled && startAtLogin) setStartAtLoginState(false);
    } catch (e) {
      onStatus(t('workspace.workflows.background.saveFailed', { error: errorText(e) }));
    } finally {
      setSaving(false);
    }
  };

  const declineOffer = async () => {
    setSaving(true);
    try {
      const s = await updateSettings({ closeToTrayOffered: true });
      setOffered(s.closeToTrayOffered);
    } catch (e) {
      onStatus(t('workspace.workflows.background.saveFailed', { error: errorText(e) }));
    } finally {
      setSaving(false);
    }
  };

  const saveStartAtLogin = async (enabled: boolean) => {
    setSaving(true);
    try {
      setStartAtLoginState(await setStartAtLogin(enabled));
    } catch (e) {
      onStatus(t('workspace.workflows.background.saveFailed', { error: errorText(e) }));
    } finally {
      setSaving(false);
    }
  };

  if (closeToTray === null) {
    return <p className="wf-muted">{t('workspace.workflows.schedule.hint')}</p>;
  }
  // Nothing scheduled and nothing switched on: the section has nothing to say.
  if (!scheduleEnabled && !closeToTray && !touched) {
    return <p className="wf-muted">{t('workspace.workflows.schedule.hint')}</p>;
  }

  if (!closeToTray && !offered) {
    return (
      <div className="wf-offer" role="group" aria-label={t('workspace.workflows.background.offerTitle')}>
        <b>{t('workspace.workflows.background.offerTitle')}</b>
        <p className="wf-muted">{t('workspace.workflows.background.offerBody')}</p>
        <div className="wf-offer-actions">
          <button type="button" className="btn primary" disabled={saving} onClick={() => void saveTray(true)}>
            {t('workspace.workflows.background.offerAccept')}
          </button>
          <button type="button" className="btn" disabled={saving} onClick={() => void declineOffer()}>
            {t('workspace.workflows.background.offerDecline')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="wf-background">
      <label className="wf-check">
        <input
          type="checkbox"
          checked={closeToTray}
          disabled={saving}
          onChange={(e) => void saveTray(e.target.checked)}
        />
        {t('workspace.workflows.background.tray')}
      </label>
      {startAtLogin !== null ? (
        <label className="wf-check">
          <input
            type="checkbox"
            checked={closeToTray && startAtLogin}
            disabled={saving || !closeToTray}
            onChange={(e) => void saveStartAtLogin(e.target.checked)}
          />
          {t('workspace.workflows.background.startAtLogin')}
        </label>
      ) : null}
      <p className="wf-muted">
        {closeToTray ? t('workspace.workflows.background.trayHint') : t('workspace.workflows.schedule.hint')}
      </p>
    </div>
  );
}
