import { useState } from 'react';
import type { AppSettings, RolloutChannel, UpdateInfo } from '../../ipc/contracts';
import { checkForUpdate, downloadAndInstallUpdate } from '../../ipc/client';

interface UpdatesSectionProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
  onStatus: (message: string) => void;
}

/** Updates section: update channel, check toggle, check now, download & install. */
export function UpdatesSection({ settings, onUpdate, onStatus }: UpdatesSectionProps) {
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleCheck() {
    setChecking(true);
    setError(null);
    try {
      const found = await checkForUpdate();
      setUpdate(found);
      onStatus(found ? `Update available: ${found.version}` : 'You are up to date');
    } catch (e) {
      setError(String(e));
      onStatus(`Update check failed: ${String(e)}`);
    } finally {
      setChecking(false);
    }
  }

  async function handleInstall() {
    setInstalling(true);
    setError(null);
    try {
      await downloadAndInstallUpdate();
      onStatus('Update installed — restarting…');
    } catch (e) {
      setError(String(e));
      onStatus(`Update install failed: ${String(e)}`);
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>Updates</span>
      </div>
      <div className="status-item" style={{ display: 'grid', gap: 8, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--card)' }}>
        <label className="field" style={{ display: 'grid', gap: 6 }}>
          <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Channel</span>
          <select
            value={settings.updateChannel}
            onChange={(e) => onUpdate({ ...settings, updateChannel: e.target.value as RolloutChannel })}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '10px 12px' }}
          >
            <option value="stable">Stable</option>
            <option value="beta">Beta</option>
          </select>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
          <input
            type="checkbox"
            checked={settings.updateCheckEnabled}
            onChange={(e) => onUpdate({ ...settings, updateCheckEnabled: e.target.checked })}
          />
          Allow update checks
        </label>
        <span style={{ fontSize: '12px', color: 'var(--ink-2)', lineHeight: 1.5 }}>
          Conduit checks for updates only when you choose — there is no background
          telemetry. Sent: your Conduit version, release notes, and the download
          URL. Updates are signature-verified and applied only after a migration
          dry-run confirms your local data is safe; installing asks you to confirm
          (passive install mode).
        </span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          <button
            className="btn"
            type="button"
            disabled={checking || !settings.updateCheckEnabled}
            onClick={() => void handleCheck()}
          >
            {checking ? 'Checking…' : 'Check now'}
          </button>
          {update && (
            <button
              className="btn primary"
              type="button"
              disabled={installing}
              onClick={() => void handleInstall()}
            >
              {installing ? 'Installing…' : `Download & install ${update.version}`}
            </button>
          )}
        </div>
        {update && (
          <div style={{ fontSize: '12px', color: 'var(--ink-2)', lineHeight: 1.5 }}>
            <b>Conduit {update.version}</b> is available.
            {update.notes && (
              <pre className="code-block" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--ink-2)', fontFamily: 'var(--font-mono)', fontSize: '11.5px' }}>
                {update.notes}
              </pre>
            )}
          </div>
        )}
        {!update && !checking && settings.updateCheckEnabled && (
          <span style={{ fontSize: '12px', color: 'var(--ink-3)' }}>No update checked yet — use "Check now".</span>
        )}
        {error && (
          <span style={{ fontSize: '12px', color: 'var(--ink-2)' }}>{error}</span>
        )}
      </div>
    </div>
  );
}
