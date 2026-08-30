import { useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import { pickWorkspaceFolder } from '../../ipc/client';
import { WorkspaceToolsConsentDialog } from './WorkspaceToolsConsentDialog';
import { appName } from '../../brand';

interface WorkspaceToolsSectionProps {
  settings: AppSettings;
  onUpdate: (s: AppSettings) => void;
  onStatus: (message: string) => void;
}

/** Defaults for workspace file tools. Day-to-day binding is on the composer chip. */
export function WorkspaceToolsSection({ settings, onUpdate, onStatus }: WorkspaceToolsSectionProps) {
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
      onStatus(`Default workspace folder set to ${path}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      onStatus(`Could not pick folder: ${message}`);
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
    <div className="settings-section" style={{ marginTop: 24 }}>
      <div className="settings-section-header">
        <span>Workspace tools</span>
      </div>
      <p style={{ marginBottom: 12, fontSize: '12px', color: 'var(--ink-2)' }}>
        Bind a folder from the chat bar (“Work in a folder”) for a single conversation.
        Use this section for a <strong>default folder on new chats</strong>. Sensitive
        filenames stay blocked; {appName()} does not expose a shell.
      </p>

      <div className="form-grid">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn" type="button" disabled={picking} onClick={() => void chooseFolder()}>
            {root ? 'Change default folder…' : 'Choose default folder…'}
          </button>
          {root ? (
            <button className="btn ghost" type="button" onClick={clearFolder}>
              Clear default
            </button>
          ) : null}
        </div>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>
          {root || 'No default folder'}
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
          Apply default folder to new chats
        </label>
        {!root && (
          <p style={{ margin: 0, fontSize: '11px', color: 'var(--ink-3)' }}>
            Choose a default folder before enabling.
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
