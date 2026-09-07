import { useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import { resetLocalDatabase } from '../../ipc/client';
import { ConfirmDialog } from '@conduit/ui';
import type { ConnectionState } from '../../lib/connectionState';
import { useRichT, useT } from '../../i18n';

interface PrivacyDataSectionProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
  onStatus: (message: string) => void;
  connectionState?: ConnectionState;
  boundaryOk?: boolean;
  hasCredential?: boolean;
}

function trustCopy(): Record<
  ConnectionState,
  { labelId: string; detailId: string; health: 'live' | 'warn' | 'off' }
> {
  return {
    connected: {
      labelId: 'settings.privacy.trust.connected.label',
      detailId: 'settings.privacy.trust.connected.detail',
      health: 'live',
    },
    'local-only': {
      labelId: 'settings.privacy.trust.localOnly.label',
      detailId: 'settings.privacy.trust.localOnly.detail',
      health: 'live',
    },
    'no-key': {
      labelId: 'settings.privacy.trust.noKey.label',
      detailId: 'settings.privacy.trust.noKey.detail',
      health: 'warn',
    },
    disconnected: {
      labelId: 'settings.privacy.trust.disconnected.label',
      detailId: 'settings.privacy.trust.disconnected.detail',
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
  const t = useT();
  const tr = useRichT();
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
      onStatus(t('settings.privacy.status.resetComplete', { backupPath: result.backupPath }));
    } catch (e) {
      onStatus(t('settings.privacy.status.resetFailed', { error: String(e) }));
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>{t('settings.privacy.header')}</span>
      </div>

      <div className="status-item trust-health" style={{ marginBottom: 16, display: 'grid', gap: 8, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--card)' }}>
        <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>
          {t('settings.privacy.trustConnection.heading')}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className={`health ${trust.health}`} aria-hidden="true" />
          <strong style={{ fontSize: '13px' }}>{t(trust.labelId)}</strong>
        </div>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--ink-2)', lineHeight: 1.5 }}>
          {t(trust.detailId)}
        </p>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: '12px', color: 'var(--ink-2)', lineHeight: 1.55 }}>
          <li>{t('settings.privacy.trust.boundaryLine', { status: boundaryOk ? 'online' : 'unreachable' })}</li>
          <li>{t('settings.privacy.trust.apiKeyLine', { status: hasCredential ? 'stored' : 'notStored' })}</li>
          <li>{t('settings.privacy.trust.localOnlyLine', { status: settings.localOnly ? 'on' : 'off' })}</li>
        </ul>
      </div>

      <div className="form-grid">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
          <input
            type="checkbox"
            checked={settings.localOnly}
            onChange={(e) => onUpdate({ ...settings, localOnly: e.target.checked })}
          />
          {t('settings.privacy.localOnlyToggle.label')}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
          <input
            type="checkbox"
            checked={settings.diagnosticsEnabled}
            onChange={(e) => onUpdate({ ...settings, diagnosticsEnabled: e.target.checked })}
          />
          {t('settings.privacy.diagnosticsToggle.label')}
        </label>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--ink-2)', lineHeight: 1.5 }}>
          {t('settings.privacy.diagnosticsHint')}
        </p>
      </div>

      {/* V9 §2.6. The copy states the trade rather than presenting two equal
          options: the file store is for machines with no usable keychain, and
          it is weaker. Switching does not move secrets that already exist —
          re-encrypting a secret into a different store is a decision about
          where it lives, and a settings dropdown is not consent for it. */}
      <div className="status-item" style={{ marginTop: 16 }}>
        <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>
          {t('settings.privacy.keychainMode.heading')}
        </span>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
          <select
            className="sel"
            value={settings.keychainMode}
            onChange={(e) =>
              onUpdate({ ...settings, keychainMode: e.target.value as AppSettings['keychainMode'] })
            }
          >
            <option value="os">{t('settings.privacy.keychainMode.optionOs')}</option>
            <option value="file">{t('settings.privacy.keychainMode.optionFile')}</option>
          </select>
          {t('settings.privacy.keychainMode.label')}
        </label>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--ink-2)', lineHeight: 1.5 }}>
          {settings.keychainMode === 'file' ? (
            <>
              {t('settings.privacy.keychainMode.fileBody.before')}
              { // i18n-exempt: environment variable name, not user prose (D7)
              }<code>CONDUIT_CREDENTIAL_KEY</code>
              {t('settings.privacy.keychainMode.fileBody.after')}
            </>
          ) : (
            <>{t('settings.privacy.keychainMode.osBody')}</>
          )}
        </p>
      </div>

      <div className="status-item" style={{ marginTop: 16 }}>
        <span style={{ color: 'var(--ink-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>{t('settings.privacy.localData.heading')}</span>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--ink-2)', lineHeight: 1.5 }}>
          {t('settings.privacy.localData.hint')}
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn" type="button" disabled={resetting} onClick={() => setConfirmReset(true)}>
            {resetting ? t('settings.privacy.localData.resetting') : t('settings.privacy.localData.resetButton')}
          </button>
        </div>
        {lastBackupPath && (
          <div style={{ display: 'grid', gap: 4 }}>
            <span style={{ color: 'var(--ink-3)', fontSize: '12px' }}>{t('settings.privacy.localData.lastBackupLabel')}</span>
            <code style={{ fontSize: '11px', wordBreak: 'break-all' }}>{lastBackupPath}</code>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmReset}
        title={t('settings.privacy.resetDialog.title')}
        description={t('settings.privacy.resetDialog.description')}
        confirmLabel={t('settings.privacy.resetDialog.confirmLabel')}
        cancelLabel={t('common.actions.cancel')}
        confirmPhrase={t('settings.privacy.resetDialog.confirmPhrase')}
        confirmPhraseHint={tr('common.confirm.typePhrase', {
          phrase: t('settings.privacy.resetDialog.confirmPhrase'),
        })}
        confirmPhraseInputLabel={t('common.confirm.typePhraseLabel', {
          phrase: t('settings.privacy.resetDialog.confirmPhrase'),
        })}
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => void handleReset()}
      />
    </div>
  );
}
