import { useEffect, useState } from 'react';
import type {
  AppPaths,
  AppSettings,
  ConnectorCapability,
  ConnectorRuntimeSnapshot,
  CredentialSummary,
  DiagnosticsExport,
  ModelInfo,
} from '../ipc/contracts';
import {
  addLocalConnector,
  discoverConnector,
  exportDiagnostics,
  getConnectorRuntimeStates,
  listConnectorCapabilities,
  listProviderModels,
  loadProviderCredentialReference,
  revokeConnectorGrant,
  saveProviderCredential,
  startConnector,
  stopConnector,
  updateSettings,
  validateProviderCredentials,
} from '../ipc/client';

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

function providerNeedsBaseUrl(providerId: string): boolean {
  return providerId === 'openai_compat' || providerId === 'ollama';
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

/** Connectors section: list registered connectors with health + start/stop,
 *  revoke a grant, and add a local stdio connector. Transport config is
 *  untrusted renderer input — `add_local_connector` validates it server-side
 *  via `StdioConfig` before persisting. */
function ConnectorsSection({ onStatus }: { onStatus: (message: string) => void }) {
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

/** Settings overlay: provider selection, BYOK entry (keychain), theme,
 *  local-only/diagnostics toggles, model listing, and diagnostics export.
 *  The trust boundary is preserved — secrets go through Rust to the keychain. */
export function SettingsPanel({ open, onClose, settings, onSettingsChange, paths, onStatus }: SettingsPanelProps) {
  const [providerSecret, setProviderSecret] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsExport | null>(null);
  const [credentialSummary, setCredentialSummary] = useState<CredentialSummary | null>(null);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const listed = await listProviderModels(settings.activeProvider);
        setModels(listed);
      } catch {
        setModels([]);
      }
      try {
        setCredentialSummary(await loadProviderCredentialReference(settings.activeProvider));
      } catch {
        setCredentialSummary(null);
      }
    })();
  }, [open, settings.activeProvider]);

  if (!open) return null;

  const providerBaseUrl = settings.providerEndpoints?.[settings.activeProvider]?.baseUrl ?? '';

  async function handleSaveCredential() {
    const summary = await saveProviderCredential({
      providerId: settings.activeProvider,
      secret: providerSecret,
    });
    setCredentialSummary(summary);
    setProviderSecret('');
    onStatus('Provider credential stored in keychain');
  }

  async function handlePersistSettings() {
    const next = await updateSettings(settings);
    onSettingsChange(next);
    onStatus('Settings persisted');
  }

  async function handleLoadModels() {
    const listed = await listProviderModels(settings.activeProvider);
    setModels(listed);
    onStatus(`Loaded ${listed.length} models`);
  }

  async function handleValidateProvider() {
    await validateProviderCredentials(settings.activeProvider);
    onStatus('Provider credentials validated');
  }

  async function handleExportDiagnostics() {
    const result = await exportDiagnostics();
    setDiagnostics(result);
  }

  function updateProviderBaseUrl(baseUrl: string) {
    onSettingsChange({
      ...settings,
      providerEndpoints: {
        ...settings.providerEndpoints,
        [settings.activeProvider]: {
          ...settings.providerEndpoints?.[settings.activeProvider],
          baseUrl,
        },
      },
    });
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
        <div className="form-grid" style={{ display: 'grid', gap: 12 }}>
          <label className="field" style={{ display: 'grid', gap: 6 }}>
            <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Provider</span>
            <select
              value={settings.activeProvider}
              onChange={(e) => onSettingsChange({ ...settings, activeProvider: e.target.value })}
              style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '10px 12px' }}
            >
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="openai_compat">OpenAI Compatible</option>
              <option value="ollama">Ollama</option>
            </select>
          </label>
          <label className="field" style={{ display: 'grid', gap: 6 }}>
            <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Model</span>
            {models.length > 0 ? (
              <select
                value={settings.activeModel}
                onChange={(e) => onSettingsChange({ ...settings, activeModel: e.target.value })}
                style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '10px 12px' }}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName ?? m.id}</option>
                ))}
              </select>
            ) : (
              <input
                value={settings.activeModel}
                onChange={(e) => onSettingsChange({ ...settings, activeModel: e.target.value })}
                style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '10px 12px' }}
              />
            )}
          </label>
          {providerNeedsBaseUrl(settings.activeProvider) && (
            <label className="field" style={{ display: 'grid', gap: 6 }}>
              <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Base URL</span>
              <input
                value={providerBaseUrl}
                onChange={(e) => updateProviderBaseUrl(e.target.value)}
                placeholder={settings.activeProvider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://your-endpoint.example/v1'}
                style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '10px 12px' }}
              />
            </label>
          )}
          {settings.activeProvider !== 'ollama' && (
            <label className="field" style={{ display: 'grid', gap: 6 }}>
              <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Provider secret</span>
              <input
                type="password"
                value={providerSecret}
                onChange={(e) => setProviderSecret(e.target.value)}
                placeholder="Stored only through Rust"
                style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', padding: '10px 12px' }}
              />
            </label>
          )}
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
        <div className="actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
          <button className="btn primary" type="button" onClick={() => void handleSaveCredential()}>Save provider key</button>
          <button className="btn" type="button" onClick={() => void handlePersistSettings()}>Persist settings</button>
          <button className="btn" type="button" onClick={() => void handleLoadModels()}>Load models</button>
          <button className="btn" type="button" onClick={() => void handleValidateProvider()}>Test connection</button>
        </div>
        <div className="status-item" style={{ marginTop: 16, display: 'grid', gap: 4, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
          <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Credential reference</span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
            {credentialSummary?.storedInKeychain
              ? `${credentialSummary.credentialRef} (active provider)`
              : 'No key stored yet'}
          </span>
        </div>
        {paths && (
          <div className="status-item" style={{ marginTop: 12, display: 'grid', gap: 4, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
            <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>App root</span>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', wordBreak: 'break-all' }}>{paths.root}</span>
          </div>
        )}
        <div className="status-item" style={{ marginTop: 12, display: 'grid', gap: 4, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
          <span style={{ color: 'var(--text-3)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.08em' }}>Diagnostics</span>
          <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
            <button className="btn primary" type="button" onClick={() => void handleExportDiagnostics()}>Export diagnostics</button>
          </div>
          {diagnostics && (
            <pre className="code-block" style={{ margin: '8px 0 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-2)', fontFamily: 'var(--font-mono)', fontSize: '11.5px' }}>
              {prettyJson(diagnostics)}
            </pre>
          )}
        </div>
        <ConnectorsSection onStatus={onStatus} />
      </div>
    </div>
  );
}