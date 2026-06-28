import { useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import { resetLocalDatabase } from '../../ipc/client';

interface PrivacyDataSectionProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
  onStatus: (message: string) => void;
}

const RESET_LOCAL_DATA_CONFIRM =
  'Reset the local database?\n\n' +
  'All conversations, messages, and indexed metadata will be removed. ' +
  'Attachment and artifact files on disk are left in place, but will no longer be indexed. ' +
  'A backup of the current database file will be saved before reset.\n\n' +
  'This cannot be undone from the app.';

/** Privacy & Data settings: local-only mode, diagnostics toggle, and local data reset. */
export function PrivacyDataSection({ settings, onUpdate, onStatus }: PrivacyDataSectionProps) {
  const [resetting, setResetting] = useState(false);
  const [lastBackupPath, setLastBackupPath] = useState<string | null>(null);

  async function handleReset() {
    if (!window.confirm(RESET_LOCAL_DATA_CONFIRM)) return;
    setResetting(true);
    try {
      const result = await resetLocalDatabase();
      setLastBackupPath(result.backupPath);
      onStatus(`Local database reset. Backup saved to ${result.backupPath}`);
    } catch (e) {
      onStatus(`Database reset failed: ${String(e)}`);
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>Privacy & Data</span>
      </div>
      <div className="form-grid" style={{ display: 'grid', gap: 12 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
          <input
            type="checkbox"
            checked={settings.localOnly}
            onChange={(e) => onUpdate({ ...settings, localOnly: e.target.checked })}
          />
          Local-only mode
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
          <input
            type="checkbox"
            checked={settings.diagnosticsEnabled}
            onChange={(e) => onUpdate({ ...settings, diagnosticsEnabled: e.target.checked })}
          />
          Diagnostics export enabled
        </label>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-2)', lineHeight: 1.5 }}>
          When diagnostics is enabled, you can export a support bundle from the Diagnostics tab.
          It contains only redacted paths and your active provider/model/toggles/theme — never secrets,
          base URLs, allowlists, or conversation content.
        </p>
      </div>

      {/* Local data reset */}
      <div className="status-item" style={{ marginTop: 16, display: 'grid', gap: 8, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
        <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Local data</span>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-2)', lineHeight: 1.5 }}>
          Reset the local SQLite store if migrations fail or you want a clean slate. Your previous
          database file is backed up first (same as automatic recovery at startup).
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn" type="button" disabled={resetting} onClick={() => void handleReset()}>
            {resetting ? 'Resetting…' : 'Reset local database'}
          </button>
        </div>
        {lastBackupPath && (
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ color: 'var(--text-3)', fontSize: '12px' }}>Last backup</span>
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', wordBreak: 'break-all' }}>{lastBackupPath}</code>
            <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-2)', lineHeight: 1.5 }}>
              A fresh database will be created on next launch. Please restart Conduit now.
              Attachments and artifact files on disk are left in place but are no longer indexed.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
