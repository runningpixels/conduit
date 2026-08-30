import { useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import { resetLocalDatabase } from '../../ipc/client';
import { ConfirmDialog } from '@conduit/ui';
import type { ConnectionState } from '../../lib/connectionState';
import { appName } from '../../brand';

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

function trustCopy(): Record<ConnectionState, { label: string; detail: string; health: 'live' | 'warn' | 'off' }> {
  return {
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
      detail: `The desktop shell could not reach the local Rust backend. Restart ${appName()} if this persists.`,
      health: 'off',
    },
  };
}

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

  const trust = trustCopy()[connectionState];

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

      {/* V9 §2.6. The copy states the trade rather than presenting two equal
          options: the file store is for machines with no usable keychain, and
          it is weaker. Switching does not move secrets that already exist —
          re-encrypting a secret into a different store is a decision about
          where it lives, and a settings dropdown is not consent for it. */}
      <div className="status-item" style={{ marginTop: 16 }}>
        <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>
          Where keys are stored
        </span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
          <select
            className="sel"
            value={settings.keychainMode}
            onChange={(e) =>
              onUpdate({ ...settings, keychainMode: e.target.value as AppSettings['keychainMode'] })
            }
          >
            <option value="os">OS keychain (recommended)</option>
            <option value="file">File (encrypted)</option>
          </select>
          Keychain mode
        </label>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--ink-2)', lineHeight: 1.5 }}>
          {settings.keychainMode === 'file' ? (
            <>
              Keys are stored in an encrypted file under your data folder. The encryption key comes
              from the <code>CONDUIT_CREDENTIAL_KEY</code> environment variable — a base64-encoded
              32-byte value — and is never written to disk beside the file it protects. Without that
              variable set, {appName()} cannot read or save keys in this mode and will say so rather
              than falling back to the keychain. This is weaker than the OS keychain and is intended
              for machines that have none, such as headless CI.
            </>
          ) : (
            <>
              Keys live in the operating system&rsquo;s keychain, guarded by your login session.
              Switch to the file store only on a machine without one — it is a weaker posture, and
              switching does not move keys you have already saved.
            </>
          )}
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
