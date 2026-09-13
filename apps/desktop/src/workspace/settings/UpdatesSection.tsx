import { useCallback, useEffect, useState } from 'react';
import type { AppSettings, RolloutChannel, UpdateInfo, UpdatePolicy, UpdateStatus } from '../../ipc/contracts';
import { checkForUpdate, downloadAndInstallUpdate, getUpdateStatus } from '../../ipc/client';
import { useT } from '../../i18n';

interface UpdatesSectionProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
  onStatus: (message: string) => void;
}

/** Updates section: update channel, check toggle, check now, download & install. */
export function UpdatesSection({ settings, onUpdate, onStatus }: UpdatesSectionProps) {
  const t = useT();
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remote, setRemote] = useState<UpdateStatus | null>(null);

  // Non-networked read: when this machine last checked, and whether the
  // background scheduler already staged something for quit. Refreshed after a
  // manual check so "last checked" does not go stale while the sheet is open.
  const refreshStatus = useCallback(() => {
    getUpdateStatus()
      .then(setRemote)
      // A status read is decoration; failing it must not blank the section.
      .catch(() => {});
  }, []);
  useEffect(refreshStatus, [refreshStatus]);

  async function handleCheck() {
    setChecking(true);
    setError(null);
    try {
      const found = await checkForUpdate();
      setUpdate(found);
      onStatus(
        found
          ? t('settings.updates.status.available', { version: found.version })
          : t('settings.updates.status.upToDate'),
      );
    } catch (e) {
      setError(String(e));
      onStatus(t('settings.updates.status.checkFailed', { error: String(e) }));
    } finally {
      setChecking(false);
      refreshStatus();
    }
  }

  async function handleInstall() {
    setInstalling(true);
    setError(null);
    try {
      await downloadAndInstallUpdate();
      onStatus(t('settings.updates.status.installed'));
    } catch (e) {
      setError(String(e));
      onStatus(t('settings.updates.status.installFailed', { error: String(e) }));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>{t('settings.updates.header.title')}</span>
      </div>
      <div className="status-item">
        <label className="field" style={{ display: 'grid', gap: 6 }}>
          <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>{t('settings.updates.channel.label')}</span>
          <select
            value={settings.updateChannel}
            onChange={(e) => onUpdate({ ...settings, updateChannel: e.target.value as RolloutChannel })}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '10px 12px' }}
          >
            <option value="stable">{t('settings.updates.channel.stable')}</option>
            <option value="beta">{t('settings.updates.channel.beta')}</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
          <input
            type="checkbox"
            checked={settings.updateCheckEnabled}
            onChange={(e) => onUpdate({ ...settings, updateCheckEnabled: e.target.checked })}
          />
          {t('settings.updates.checkbox.allow')}
        </label>
        {/* The policy only means anything if checks are allowed at all, so it
            follows the toggle and disables with it — the same relationship the
            channel select already has to that checkbox. */}
        <label className="field" style={{ display: 'grid', gap: 6 }}>
          <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>{t('settings.updates.policy.label')}</span>
          <select
            value={settings.updatePolicy}
            disabled={!settings.updateCheckEnabled}
            onChange={(e) => onUpdate({ ...settings, updatePolicy: e.target.value as UpdatePolicy })}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '10px 12px' }}
          >
            <option value="manual">{t('settings.updates.policy.manual')}</option>
            <option value="notify">{t('settings.updates.policy.notify')}</option>
            {/* Offered only where install-on-quit can be silent. A `.deb`
                install needs a pkexec prompt, so the option is withheld rather
                than shown and then refused — except when it is already the
                stored value, where hiding it would silently misreport the
                setting. */}
            {(remote?.automaticSupported ?? true) || settings.updatePolicy === 'automatic' ? (
              <option value="automatic">{t('settings.updates.policy.automatic')}</option>
            ) : null}
          </select>
        </label>
        <span style={{ fontSize: '12px', color: 'var(--ink-2)', lineHeight: 1.5 }}>
          {t('settings.updates.disclosure.body')}
        </span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          <button
            className="btn"
            type="button"
            disabled={checking || !settings.updateCheckEnabled}
            onClick={() => void handleCheck()}
          >
            {checking ? t('settings.updates.actions.checking') : t('settings.updates.actions.checkNow')}
          </button>
          {update && (
            <button
              className="btn primary"
              type="button"
              disabled={installing}
              onClick={() => void handleInstall()}
            >
              {installing
                ? t('settings.updates.actions.installing')
                : t('settings.updates.actions.downloadInstall', { version: update.version })}
            </button>
          )}
        </div>
        {update && (
          <div style={{ fontSize: '12px', color: 'var(--ink-2)', lineHeight: 1.5 }}>
            <b>{t('settings.updates.available.notice', { version: update.version })}</b>
            {update.notes && (
              <pre className="code-block" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)', fontSize: '11.5px' }}>
                {update.notes}
              </pre>
            )}
          </div>
        )}
        {remote?.staged && (
          <span style={{ fontSize: '12px', color: 'var(--ink-2)', lineHeight: 1.5 }}>
            {t('settings.updates.staged.notice', { version: remote.staged.version })}
          </span>
        )}
        {!update && !checking && settings.updateCheckEnabled && (
          <span style={{ fontSize: '12px', color: 'var(--ink-3)' }}>
            {remote && remote.lastChecked !== null
              ? t('settings.updates.lastChecked', {
                  when: new Date(remote.lastChecked * 1000).toLocaleString(),
                })
              : t('settings.updates.noCheckYet.hint', { action: t('settings.updates.actions.checkNow') })}
          </span>
        )}
        {error && (
          <span style={{ fontSize: '12px', color: 'var(--ink-2)' }}>{error}</span>
        )}
      </div>
    </div>
  );
}
