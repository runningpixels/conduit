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

/** Settings for sandbox-scoped workspace file tools (no MCP). */
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
      onStatus(`Workspace folder set to ${path}`);
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
        Let the model read and edit files in one folder you choose — no MCP server
        required. Paths stay inside that folder; sensitive filenames are blocked.
        {appName()} does not expose a shell.
      </p>

      <div className="form-grid">
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button className="btn" type="button" disabled={picking} onClick={() => void chooseFolder()}>
            {root ? 'Change folder…' : 'Choose folder…'}
          </button>
          {root ? (
            <button className="btn ghost" type="button" onClick={clearFolder}>
              Clear
            </button>
          ) : null}
        </div>
        <p style={{ margin: 0, fontSize: '12px', color: 'var(--ink-3)', fontFamily: 'var(--font-mono)' }}>
          {root || 'No folder selected'}
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
          Enable workspace file tools
        </label>
        {!root && (
          <p style={{ margin: 0, fontSize: '11px', color: 'var(--ink-3)' }}>
            Choose a folder before enabling.
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
