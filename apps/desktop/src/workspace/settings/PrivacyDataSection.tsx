import { useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import { resetLocalDatabase } from '../../ipc/client';
import { ConfirmDialog } from '@conduit/ui';
import type { ConnectionState } from '../../lib/connectionState';

interface PrivacyDataSectionProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
  onStatus: (message: string) => void;
  connectionState?: ConnectionState;
  boundaryOk?: boolean;
  hasCredential?: boolean;
}

const RESET_LOCAL_DATA_DESCRIPTION =
  'All conversations, messages, and indexed metadata will be removed. ' +
  'Attachment and artifact files on disk are left in place, but will no longer be indexed. ' +
  'A backup of the current database file will be saved before reset.\n\n' +
  'This cannot be undone from the app.';

const TRUST_COPY: Record<ConnectionState, { label: string; detail: string; health: 'live' | 'warn' | 'off' }> = {
  connected: {
    label: 'Trust boundary online',
    detail: 'Rust shell is reachable. Provider calls use your key; nothing else leaves this device unless you enable web search.',
    health: 'live',
  },
  'local-only': {
    label: 'Local-only mode',
    detail: 'Web search and other egress features stay off. BYOK provider calls still go straight to your provider with your key.',
    health: 'live',
  },
  'no-key': {
    label: 'No API key stored',
    detail: 'Add a provider credential under Provider & Model to start chatting. Keys stay in the OS keychain.',
    health: 'warn',
  },
  disconnected: {
    label: 'Trust boundary unreachable',
    detail: 'The desktop shell could not reach the local Rust backend. Restart Conduit if this persists.',
    health: 'off',
  },
};

/** Privacy & Data settings: trust health, local-only mode, diagnostics, reset. */
export function PrivacyDataSection({
  settings,
  onUpdate,
  onStatus,
  connectionState = 'connected',
  boundaryOk = true,
  hasCredential = true,
}: PrivacyDataSectionProps) {
  const [resetting, setResetting] = useState(false);
  const [lastBackupPath, setLastBackupPath] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);

  const trust = TRUST_COPY[connectionState];

  async function handleReset() {
    setConfirmReset(false);
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

      <div className="status-item trust-health" style={{ marginBottom: 16, display: 'grid', gap: 8, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--card)' }}>
        <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>
          Trust & connection
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className={`health ${trust.health}`} aria-hidden="true" />
          <strong style={{ fontSize: '13px' }}>{trust.label}</strong>
        </div>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--ink-2)', lineHeight: 1.5 }}>
          {trust.detail}
        </p>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: '12px', color: 'var(--ink-2)', lineHeight: 1.55 }}>
          <li>Boundary: {boundaryOk ? 'online' : 'unreachable'}</li>
          <li>API key: {hasCredential ? 'stored in OS keychain' : 'not stored'}</li>
          <li>Local-only mode: {settings.localOnly ? 'on' : 'off'}</li>
        </ul>
      </div>

      <div className="form-grid">
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
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--ink-2)', lineHeight: 1.5 }}>
          When diagnostics is enabled, you can export a support bundle from the Diagnostics tab.
          It contains only redacted paths and your active provider/model/toggles/theme — never secrets,
          base URLs, allowlists, or conversation content.
        </p>
      </div>

      <div className="status-item" style={{ marginTop: 16 }}>
        <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Local data</span>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--ink-2)', lineHeight: 1.5 }}>
          Reset the local SQLite store if migrations fail or you want a clean slate. Your previous
          database file is backed up first (same as automatic recovery at startup).
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn" type="button" disabled={resetting} onClick={() => setConfirmReset(true)}>
            {resetting ? 'Resetting…' : 'Reset local database'}
          </button>
        </div>
        {lastBackupPath && (
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ color: 'var(--ink-3)', fontSize: '12px' }}>Last backup</span>
            <code style={{ fontSize: '11px', wordBreak: 'break-all' }}>{lastBackupPath}</code>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmReset}
        title="Reset the local database?"
        description={RESET_LOCAL_DATA_DESCRIPTION}
        confirmLabel="Reset database"
        confirmPhrase="reset"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => void handleReset()}
      />
    </div>
  );
}
