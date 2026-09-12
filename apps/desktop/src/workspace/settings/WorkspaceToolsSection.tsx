import { useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import { pickWorkspaceFolder } from '../../ipc/client';
import { WorkspaceToolsConsentDialog } from './WorkspaceToolsConsentDialog';
import { useRichT, useT } from '../../i18n';

interface WorkspaceToolsSectionProps {
  settings: AppSettings;
  onUpdate: (s: AppSettings) => void;
  onStatus: (message: string) => void;
}

/** Defaults for workspace file tools. Day-to-day binding is on the composer chip. */
export function WorkspaceToolsSection({ settings, onUpdate, onStatus }: WorkspaceToolsSectionProps) {
  const t = useT();
  const tr = useRichT();
  const [showConsent, setShowConsent] = useState(false);
  const [pendingConsentState, setPendingConsentState] = useState<AppSettings | null>(null);
  const [picking, setPicking] = useState(false);

  const root = settings.workspaceRoot?.trim() || '';
  const enabled = settings.workspaceToolsEnabled;

  async function chooseFolder() {
    setPicking(true);
    try {
      const path = await pickWorkspaceFolder();
      if (path == null) return;
      onUpdate({ ...settings, workspaceRoot: path });
      onStatus(t('settings.workspaceTools.status.folderSet', { path }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      onStatus(t('settings.workspaceTools.status.pickFailed', { error: message }));
    } finally {
      setPicking(false);
    }
  }

  function clearFolder() {
    onUpdate({
      ...settings,
      workspaceRoot: null,
      workspaceToolsEnabled: false,
    });
  }

  return (
    <div className="settings-section">
      <p style={{ marginBottom: 12, fontSize: '12px', color: 'var(--ink-2)' }}>
        {tr('settings.workspaceTools.intro')}
      </p>

      <div className="form-grid">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn" type="button" disabled={picking} onClick={() => void chooseFolder()}>
            {root ? t('settings.workspaceTools.actions.changeFolder') : t('settings.workspaceTools.actions.chooseFolder')}
          </button>
          {root ? (
            <button className="btn ghost" type="button" onClick={clearFolder}>
              {t('settings.workspaceTools.actions.clearDefault')}
            </button>
          ) : null}
        </div>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>
          {root || t('settings.workspaceTools.noDefaultFolder')}
        </p>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
          <input
            type="checkbox"
            checked={enabled}
            disabled={!root}
            onChange={(e) => {
              const nextVal = e.target.checked;
              if (nextVal && !settings.workspaceToolsConsentAcknowledged) {
                setPendingConsentState({ ...settings, workspaceToolsEnabled: true });
                setShowConsent(true);
              } else {
                onUpdate({ ...settings, workspaceToolsEnabled: nextVal });
              }
            }}
          />
          {t('settings.workspaceTools.applyToggle.label')}
        </label>
        {!root && (
          <p style={{ margin: 0, fontSize: '11px', color: 'var(--ink-3)' }}>
            {t('settings.workspaceTools.chooseBeforeEnabling')}
          </p>
        )}

        <WorkspaceToolsConsentDialog
          visible={showConsent}
          onAllow={() => {
            setShowConsent(false);
            if (pendingConsentState) {
              onUpdate({
                ...pendingConsentState,
                workspaceToolsConsentAcknowledged: true,
              });
              setPendingConsentState(null);
            }
          }}
          onDeny={() => {
            setShowConsent(false);
            setPendingConsentState(null);
          }}
        />
      </div>
    </div>
  );
}
