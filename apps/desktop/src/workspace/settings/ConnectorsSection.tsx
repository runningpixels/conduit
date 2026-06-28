import { useEffect, useState } from 'react';
import type {
  ConnectorCapability,
  ConnectorRuntimeSnapshot,
} from '../../ipc/contracts';
import {
  addLocalConnector,
  discoverConnector,
  getConnectorRuntimeStates,
  listConnectorCapabilities,
  listConnectorGrants,
  revokeConnectorGrant,
  startConnector,
  stopConnector,
} from '../../ipc/client';

/** Compact health/support → label mapping for the settings list. */
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
    try {
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
    <div className="settings-section">
      <div className="settings-section-header">
        <span>Connectors</span>
      </div>
      <div className="status-item" style={{ display: 'grid', gap: 8, padding: 12, borderRadius: 'var(--r-sm)', background: 'var(--surface-2)' }}>
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
    </div>
  );
}
