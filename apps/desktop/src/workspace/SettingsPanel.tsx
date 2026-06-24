import { useEffect, useState } from 'react';
import type {
  AppPaths,
  AppSettings,
  ConnectorCapability,
  ConnectorRuntimeSnapshot,
  DiagnosticsExport,
  RolloutChannel,
  UpdateInfo,
} from '../ipc/contracts';
import {
  addLocalConnector,
  acknowledgeDiagnosticsDisclosure,
  checkForUpdate,
  discoverConnector,
  downloadAndInstallUpdate,
  exportDiagnostics,
  getConnectorRuntimeStates,
  getDiagnosticsDisclosureAcknowledged,
  listConnectorCapabilities,
  revealPath,
  revokeConnectorGrant,
  startConnector,
  stopConnector,
  updateSettings,
} from '../ipc/client';
import { ProviderPicker } from './settings/ProviderPicker';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  paths: AppPaths | null;
  onStatus: (message: string) => void;
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/// Compact health/support → label mapping for the settings list (mirrors the
/// connectors rail). Kept inline so the settings dialog shows the same
/// failure-state wording without importing the rail component.
function connectorLabel(s: ConnectorRuntimeSnapshot): { tone: 'ok' | 'warn' | 'bad' | 'hold'; label: string } {
  if (s.grantStatus === 'revoked') return { tone: 'bad', label: 'revoked' };
  if (s.supportState === 'adminDisabled') return { tone: 'bad', label: 'disabled' };
  if (s.supportState === 'revoked') return { tone: 'bad', label: 'revoked' };
  if (s.supportState === 'authRequired') return { tone: 'warn', label: 'sign in' };
  if (s.supportState === 'unsupported') return { tone: 'bad', label: 'unsupported' };
  if (s.running && s.health === 'healthy') return { tone: 'ok', label: 'live' };
  if (s.health === 'down') return { tone: 'bad', label: 'down' };
  if (s.health === 'degraded') return { tone: 'warn', label: 'degraded' };
  return { tone: 'hold', label: 'stopped' };
}

/** Updates section (Phase 6): update channel, the "check for updates" toggle,
 *  the trust-promise disclosure, an explicit "Check now" button, and — when an
 *  update is available — "Download & install" (which runs the Rust-side
 *  migration precheck before applying, then restarts). Updates are never
 *  automatic: checking is opt-in via the toggle and the install is passive
 *  (user confirms before applying). */
function UpdatesSection({
  settings,
  onSettingsChange,
  onStatus,
}: {
  settings: AppSettings;
  onSettingsChange: (s: AppSettings) => void;
  onStatus: (message: string) => void;
}) {
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
      // Refuses (rejects) if the migration precheck on a copy of the local DB
      // fails — your data is never touched by the precheck. On success, the
      // app restarts into the new version (this promise may never resolve).
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
    <div className="status-item" style={{ marginTop: 16, display: 'grid', gap: 8, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
      <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Updates</span>
      <label className="field" style={{ display: 'grid', gap: 6 }}>
        <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Channel</span>
        <select
          value={settings.updateChannel}
          onChange={(e) => onSettingsChange({ ...settings, updateChannel: e.target.value as RolloutChannel })}
          style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '10px 12px' }}
        >
          <option value="stable">Stable</option>
          <option value="beta">Beta</option>
        </select>
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
        <input
          type="checkbox"
          checked={settings.updateCheckEnabled}
          onChange={(e) => onSettingsChange({ ...settings, updateCheckEnabled: e.target.checked })}
        />
        Allow update checks
      </label>
      <span style={{ fontSize: '12px', color: 'var(--text-2)', lineHeight: 1.5 }}>
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
        <div style={{ fontSize: '12px', color: 'var(--text-2)', lineHeight: 1.5 }}>
          <b>Conduit {update.version}</b> is available.
          {update.notes && (
            <pre className="code-block" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-2)', fontFamily: 'var(--font-mono)', fontSize: '11.5px' }}>
              {update.notes}
            </pre>
          )}
        </div>
      )}
      {!update && !checking && settings.updateCheckEnabled && (
        <span style={{ fontSize: '12px', color: 'var(--text-3)' }}>No update checked yet — use “Check now”.</span>
      )}
      {error && (
        <span style={{ fontSize: '12px', color: 'var(--text-2)' }}>{error}</span>
      )}
      <span style={{ fontSize: '11px', color: 'var(--text-3)' }}>Use “Persist settings” to save your channel + toggle choice.</span>
    </div>
  );
}

/** Connectors section: list registered connectors with health + start/stop,
 *  revoke a grant, and add a local stdio connector. Transport config is
 *  untrusted renderer input — `add_local_connector` validates it server-side
 *  via `StdioConfig` before persisting. Exported so the first-run `Onboarding`
 *  can reuse it for the optional connector step (no duplication). */
export function ConnectorsSection({ onStatus }: { onStatus: (message: string) => void }) {
  const [rows, setRows] = useState<ConnectorRuntimeSnapshot[]>([]);
  const [capabilities, setCapabilities] = useState<Record<string, ConnectorCapability[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshingDiscovery, setRefreshingDiscovery] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [consentCopy, setConsentCopy] = useState('');

  const refresh = () => {
    void (async () => {
      try {
        const nextRows = await getConnectorRuntimeStates();
        setRows(nextRows);
        const capabilityEntries = await Promise.all(
          nextRows.map(async (row) => {
            try {
              return [row.connectorVersionId, await listConnectorCapabilities(row.connectorVersionId)] as const;
            } catch {
              return [row.connectorVersionId, []] as const;
            }
          }),
        );
        setCapabilities(Object.fromEntries(capabilityEntries));
      } catch {
        setRows([]);
        setCapabilities({});
      }
    })();
  };

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 5000);
    return () => window.clearInterval(id);
  }, []);

  async function toggle(s: ConnectorRuntimeSnapshot) {
    setBusy(s.connectorVersionId);
    try {
      if (s.running) {
        await stopConnector(s.connectorVersionId);
        onStatus(`Stopped ${s.connectorName}`);
      } else {
        await startConnector(s.connectorVersionId);
        onStatus(`Started ${s.connectorName}`);
      }
      refresh();
    } catch (e) {
      onStatus(`Connector error: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleRevoke(s: ConnectorRuntimeSnapshot) {
    if (!confirm(`Revoke the grant for ${s.connectorName}? The connector will be stopped.`)) return;
    // Find the grant id: we don't have it on the snapshot, so revoke by
    // stopping + a follow-up would need listConnectorGrants. For MVP, stop +
    // mark via the runtime; full revoke uses listConnectorGrants to resolve id.
    try {
      const { listConnectorGrants } = await import('../ipc/client');
      const grants = await listConnectorGrants();
      const g = grants.find((x) => x.connectorVersionId === s.connectorVersionId);
      if (!g) {
        onStatus('No grant found for that connector');
        return;
      }
      await revokeConnectorGrant(g.id, s.connectorVersionId);
      onStatus(`Revoked ${s.connectorName}`);
      refresh();
    } catch (e) {
      onStatus(`Revoke failed: ${String(e)}`);
    }
  }

  async function handleAdd() {
    if (!name.trim() || !command.trim()) {
      onStatus('Connector name and command are required');
      return;
    }
    const argList = args.split(/\s+/).filter(Boolean);
    const envMap: Record<string, string> = {};
    for (const pair of env.split('\n')) {
      const i = pair.indexOf('=');
      if (i > 0) envMap[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    try {
      const result = await addLocalConnector({
        name: name.trim(),
        command: command.trim(),
        args: argList,
        env: envMap,
        consentCopy: consentCopy.trim() || undefined,
      });
      onStatus(`Added connector ${result.connectorId}`);
      setName('');
      setCommand('');
      setArgs('');
      setEnv('');
      setConsentCopy('');
      refresh();
    } catch (e) {
      onStatus(`Add failed: ${String(e)}`);
    }
  }

  async function handleRefreshDiscovery(s: ConnectorRuntimeSnapshot) {
    setRefreshingDiscovery(s.connectorVersionId);
    try {
      const next = await discoverConnector(s.connectorVersionId);
      setCapabilities((current) => ({ ...current, [s.connectorVersionId]: next }));
      onStatus(`Refreshed tools for ${s.connectorName}`);
      refresh();
    } catch (e) {
      onStatus(`Discovery failed: ${String(e)}`);
    } finally {
      setRefreshingDiscovery(null);
    }
  }

  return (
    <div className="status-item" style={{ marginTop: 16, display: 'grid', gap: 8, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
      <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Connectors</span>
      {rows.length === 0 ? (
        <span style={{ fontSize: '13px' }}>No connectors registered yet. Add a local stdio connector below.</span>
      ) : (
        rows.map((s) => {
          const st = connectorLabel(s);
          const canToggle = s.grantStatus === 'active' && s.supportState !== 'adminDisabled' && s.supportState !== 'revoked' && s.supportState !== 'authRequired';
          const toolCaps = (capabilities[s.connectorVersionId] ?? []).filter((cap) => cap.kind === 'tool');
          return (
            <div key={s.connectorVersionId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
              <span style={{ flex: 1 }}>
                <b>{s.connectorName}</b> <small style={{ color: 'var(--text-3)' }}>v{s.version} · {s.transport}</small>
                <small style={{ display: 'block', color: 'var(--text-3)' }}>
                  Tools: {toolCaps.length > 0 ? toolCaps.map((cap) => cap.name).join(', ') : 'none discovered'}
                </small>
                {s.lastError && (st.tone === 'bad' || st.tone === 'warn') && (
                  <small style={{ display: 'block', color: 'var(--text-3)' }}>{s.lastError}</small>
                )}
              </span>
              <span className={`status-pill ${st.tone}`} style={{ fontSize: '11px' }}>{st.label}</span>
              {canToggle && (
                <button
                  className="btn ghost"
                  type="button"
                  style={{ padding: '4px 10px' }}
                  disabled={busy === s.connectorVersionId}
                  onClick={() => void toggle(s)}
                >
                  {s.running ? 'Stop' : 'Start'}
                </button>
              )}
              <button
                className="btn ghost"
                type="button"
                style={{ padding: '4px 10px' }}
                disabled={refreshingDiscovery === s.connectorVersionId || !s.running}
                onClick={() => void handleRefreshDiscovery(s)}
              >
                Refresh tools
              </button>
              <button
                className="btn ghost"
                type="button"
                style={{ padding: '4px 10px' }}
                onClick={() => void handleRevoke(s)}
              >
                Revoke
              </button>
            </div>
          );
        })
      )}
      <div style={{ display: 'grid', gap: 6, marginTop: 8 }}>
        <input
          placeholder="Connector name (e.g. Echo)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '8px 10px' }}
        />
        <input
          placeholder="Command (absolute path, no shell)"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '8px 10px' }}
        />
        <input
          placeholder="Arguments (space-separated)"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
          style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '8px 10px' }}
        />
        <textarea
          placeholder="Env (one KEY=VALUE per line)"
          value={env}
          onChange={(e) => setEnv(e.target.value)}
          rows={2}
          style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: '12px' }}
        />
        <input
          placeholder="Consent copy shown to users (optional)"
          value={consentCopy}
          onChange={(e) => setConsentCopy(e.target.value)}
          style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '8px 10px' }}
        />
        <button className="btn primary" type="button" onClick={() => void handleAdd()}>Add local connector</button>
      </div>
    </div>
  );
}

/** Phase 6 M6.5: the one-time diagnostics-export disclosure copy. Shown via a
 *  native `confirm()` before the first export, then persisted (once-ever) in raw
 *  settings JSON. States exactly what is and is NOT included so the user gives
 *  informed consent — no secrets, no base URLs, no allowlists, no conversation
 *  content ever leave the device in a diagnostics bundle. */
const DIAGNOSTICS_DISCLOSURE_TEXT =
  'Conduit diagnostics export includes:\n' +
  '  • active provider + model\n' +
  '  • local-only flag, diagnostics-enabled flag, theme\n' +
  '  • redacted app paths (your home folder prefix is stripped)\n\n' +
  'It NEVER includes:\n' +
  '  • secrets or API keys\n' +
  '  • provider base URLs\n' +
  '  • artifact remote allowlists\n' +
  '  • conversation or message content\n\n' +
  'The bundle is written to your local exports folder. Export?';

/** Settings overlay: provider selection, BYOK entry (keychain), theme,
 *  local-only/diagnostics toggles, model listing, and diagnostics export.
 *  The trust boundary is preserved — secrets go through Rust to the keychain. */
export function SettingsPanel({ open, onClose, settings, onSettingsChange, paths, onStatus }: SettingsPanelProps) {
  const [diagnostics, setDiagnostics] = useState<DiagnosticsExport | null>(null);
  const [allowlistInput, setAllowlistInput] = useState('');
  // Phase 6 M6.5: once-ever diagnostics-export disclosure. Loaded from raw
  // settings JSON on open; the first export prompts a native confirm() with the
  // what's-in / what's-out summary, then persists the acknowledgement.
  const [disclosureAcknowledged, setDisclosureAcknowledged] = useState(true);

  useEffect(() => {
    if (!open) return;
    void getDiagnosticsDisclosureAcknowledged().then(setDisclosureAcknowledged);
  }, [open]);

  if (!open) return null;

  async function handlePersistSettings() {
    const next = await updateSettings(settings);
    onSettingsChange(next);
    onStatus('Settings persisted');
  }

  async function handleExportDiagnostics() {
    // Defensive gate (the button is disabled when off, but the Rust side also
    // refuses — surface a clear message either way).
    if (!settings.diagnosticsEnabled) {
      onStatus('Diagnostics export is disabled. Enable it above to export a support bundle.');
      return;
    }
    if (!disclosureAcknowledged) {
      const ok = window.confirm(DIAGNOSTICS_DISCLOSURE_TEXT);
      if (!ok) {
        onStatus('Diagnostics export cancelled');
        return;
      }
      await acknowledgeDiagnosticsDisclosure();
      setDisclosureAcknowledged(true);
    }
    try {
      const result = await exportDiagnostics();
      setDiagnostics(result);
      onStatus(`Diagnostics exported to ${result.exportedTo}`);
    } catch (err) {
      onStatus(`Diagnostics export failed: ${String(err)}`);
    }
  }

  async function handleRevealExports() {
    if (!diagnostics) return;
    // The Rust command opens `AppPaths::exports` server-side — the renderer
    // passes no path, so it cannot direct the shell at an arbitrary location.
    try {
      await revealPath();
    } catch (err) {
      onStatus(`Could not reveal folder: ${String(err)}`);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(0,0,0,.55)',
      }}
      onClick={onClose}
    >
      <div
        className="info-card"
        style={{ maxWidth: 640, width: '90vw', maxHeight: '86vh', overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          Settings
          <button className="btn ghost" style={{ marginLeft: 'auto', padding: '4px 10px' }} type="button" onClick={onClose}>
            Close
          </button>
        </h3>
        <p style={{ marginBottom: 12 }}>Provider selection and BYOK entry stay inside Rust and the OS keychain.</p>
        {/* Phase 6 M6.4: provider + BYOK surface is shared with the first-run
            Onboarding via `ProviderPicker` (no duplication of the flow). */}
        <ProviderPicker settings={settings} onSettingsChange={onSettingsChange} onStatus={onStatus} />
        <div className="form-grid" style={{ display: 'grid', gap: 12, marginTop: 12 }}>
          <label className="field" style={{ display: 'grid', gap: 6 }}>
            <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Theme</span>
            <select
              value={settings.theme}
              onChange={(e) => onSettingsChange({ ...settings, theme: e.target.value as AppSettings['theme'] })}
              style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '10px 12px' }}
            >
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
            <input
              type="checkbox"
              checked={settings.localOnly}
              onChange={(e) => onSettingsChange({ ...settings, localOnly: e.target.checked })}
            />
            Local-only mode
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
            <input
              type="checkbox"
              checked={settings.diagnosticsEnabled}
              onChange={(e) => onSettingsChange({ ...settings, diagnosticsEnabled: e.target.checked })}
            />
            Diagnostics export enabled
          </label>
        </div>

        {/* Phase 5: artifact remote allowlist. Origins a rendered HTML/JS artifact
            may load passive resources (images/fonts/styles) from. Scripts and
            network API calls are blocked regardless. Empty = fully offline. */}
        <div className="status-item" style={{ marginTop: 16, display: 'grid', gap: 6, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
          <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>
            Artifact remote allowlist
          </span>
          <span style={{ fontSize: '12px', color: 'var(--text-2)', lineHeight: 1.5 }}>
            Trusted origins rendered HTML artifacts may load images, fonts, and styles from. Scripts and network API calls (fetch/XHR) are blocked regardless. Empty = artifacts are fully offline.
          </span>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <input
              value={allowlistInput}
              onChange={(e) => setAllowlistInput(e.target.value)}
              placeholder="https://fonts.example.com"
              style={{ flex: 1, borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: '12px' }}
            />
            <button
              className="btn"
              type="button"
              onClick={() => {
                const v = allowlistInput.trim();
                if (!v) return;
                if (settings.artifactRemoteAllowlist.includes(v)) {
                  setAllowlistInput('');
                  return;
                }
                onSettingsChange({ ...settings, artifactRemoteAllowlist: [...settings.artifactRemoteAllowlist, v] });
                setAllowlistInput('');
              }}
            >
              Add
            </button>
          </div>
          {settings.artifactRemoteAllowlist.length === 0 ? (
            <span style={{ fontSize: '12px', color: 'var(--text-3)' }}>No origins allowlisted — artifacts are offline.</span>
          ) : (
            <ul style={{ listStyle: 'none', margin: '4px 0 0', padding: 0, display: 'grid', gap: 4 }}>
              {settings.artifactRemoteAllowlist.map((origin) => (
                <li key={origin} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
                  <span style={{ flex: 1, wordBreak: 'break-all' }}>{origin}</span>
                  <button
                    className="btn ghost"
                    type="button"
                    style={{ padding: '2px 8px' }}
                    onClick={() =>
                      onSettingsChange({
                        ...settings,
                        artifactRemoteAllowlist: settings.artifactRemoteAllowlist.filter((o) => o !== origin),
                      })
                    }
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          <span style={{ fontSize: '11px', color: 'var(--text-3)' }}>Use “Persist settings” to save. Invalid origins are rejected by Rust on save.</span>
        </div>
        <div className="actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
          <button className="btn" type="button" onClick={() => void handlePersistSettings()}>Persist settings</button>
        </div>
        {paths && (
          <div className="status-item" style={{ marginTop: 12, display: 'grid', gap: 4, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
            <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>App root</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', wordBreak: 'break-all' }}>{paths.root}</span>
          </div>
        )}
        <div className="status-item" style={{ marginTop: 12, display: 'grid', gap: 4, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
          <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Diagnostics</span>
          <p style={{ margin: '6px 0 0', fontSize: '12px', color: 'var(--text-2)' }}>
            A diagnostics bundle contains your active provider/model, flags, theme, and redacted app paths. It never contains secrets, base URLs, allowlists, or conversation content.
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <button
              className="btn primary"
              type="button"
              onClick={() => void handleExportDiagnostics()}
              disabled={!settings.diagnosticsEnabled}
              title={settings.diagnosticsEnabled ? undefined : 'Enable diagnostics above to export a support bundle'}
            >
              Export diagnostics
            </button>
            {!settings.diagnosticsEnabled && (
              <span style={{ fontSize: '12px', color: 'var(--text-3)' }}>Enable diagnostics above to export a support bundle.</span>
            )}
            {diagnostics && (
              <button className="btn" type="button" onClick={() => void handleRevealExports()}>Reveal in folder</button>
            )}
          </div>
          {diagnostics && (
            <div style={{ marginTop: 6, display: 'grid', gap: 4 }}>
              <span style={{ color: 'var(--text-3)', fontSize: '12px' }}>Exported to</span>
              <code style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', wordBreak: 'break-all' }}>{diagnostics.exportedTo}</code>
              <pre className="code-block" style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-2)', fontFamily: 'var(--font-mono)', fontSize: '11.5px' }}>
                {prettyJson(diagnostics)}
              </pre>
            </div>
          )}
        </div>
        <UpdatesSection settings={settings} onSettingsChange={onSettingsChange} onStatus={onStatus} />
        <ConnectorsSection onStatus={onStatus} />
      </div>
    </div>
  );
}