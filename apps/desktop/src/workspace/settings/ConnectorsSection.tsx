import { useEffect, useState } from 'react';
import type {
  ConnectorCapability,
  ConnectorRuntimeSnapshot,
} from '../../ipc/contracts';
import {
  addLocalConnector,
  addRemoteConnector,
  discoverConnector,
  getConnectorRuntimeStates,
  listConnectorCapabilities,
  listConnectorGrants,
  listToolApprovalMemory,
  revokeConnectorGrant,
  revokeToolApprovalMemory,
  searchMcpRegistry,
  signinRemoteConnector,
  startConnector,
  stopConnector,
  type ToolApprovalMemoryRow,
} from '../../ipc/client';
import type { RegistryServer } from '../../ipc/contracts';

/** Compact health/support → label mapping for the settings list. */
function connectorLabel(s: ConnectorRuntimeSnapshot): { tone: 'ok' | 'warn' | 'bad' | 'hold'; label: string } {
  if (s.grantStatus === 'revoked') return { tone: 'bad', label: 'revoked' };
  if (s.supportState === 'adminDisabled') return { tone: 'bad', label: 'disabled' };
  if (s.supportState === 'revoked') return { tone: 'bad', label: 'revoked' };
  if (s.health === 'authRequired') return { tone: 'warn', label: 'sign in' };
  if (s.supportState === 'authRequired') return { tone: 'warn', label: 'sign in' };
  if (s.supportState === 'unsupported') return { tone: 'bad', label: 'unsupported' };
  if (s.running && s.health === 'healthy') return { tone: 'ok', label: 'live' };
  if (s.health === 'down') return { tone: 'bad', label: 'down' };
  if (s.health === 'degraded') return { tone: 'warn', label: 'degraded' };
  return { tone: 'hold', label: 'stopped' };
}

/** Connectors section: list registered connectors with health + start/stop,
 *  revoke a grant, install from the official MCP registry, add a remote
 *  streamable-HTTP URL, or add a local stdio connector. Transport config is
 *  untrusted renderer input — add commands validate it server-side before
 *  persisting. Exported so the first-run `Onboarding` can reuse it. */
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
  const [approvals, setApprovals] = useState<ToolApprovalMemoryRow[]>([]);
  const [registryQuery, setRegistryQuery] = useState('');
  const [registryHits, setRegistryHits] = useState<RegistryServer[]>([]);
  const [registryBusy, setRegistryBusy] = useState(false);
  const [remoteName, setRemoteName] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');

  const refreshApprovals = () => {
    void listToolApprovalMemory()
      .then(setApprovals)
      .catch(() => setApprovals([]));
  };

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
    refreshApprovals();
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

  async function handleSignIn(s: ConnectorRuntimeSnapshot) {
    setBusy(s.connectorVersionId);
    try {
      await signinRemoteConnector(s.connectorVersionId);
      onStatus(`Signed in to ${s.connectorName}`);
      refresh();
    } catch (e) {
      onStatus(`Sign-in failed: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function handleRegistrySearch() {
    setRegistryBusy(true);
    try {
      const hits = await searchMcpRegistry(registryQuery.trim());
      setRegistryHits(hits);
      onStatus(hits.length === 0 ? 'No remote servers matched that search' : `Found ${hits.length} remote servers`);
    } catch (e) {
      onStatus(`Registry search failed: ${String(e)}`);
    } finally {
      setRegistryBusy(false);
    }
  }

  async function handleInstallRegistry(hit: RegistryServer) {
    if (!hit.installable || !hit.remoteUrl) {
      onStatus(hit.reason ?? 'This server needs streamable HTTP');
      return;
    }
    setRegistryBusy(true);
    try {
      const result = await addRemoteConnector({
        name: hit.title || hit.name,
        description: hit.description,
        url: hit.remoteUrl,
        version: hit.version,
      });
      onStatus(`Added ${result.connectorId}. Start it, or sign in if it requires OAuth.`);
      refresh();
    } catch (e) {
      onStatus(`Install failed: ${String(e)}`);
    } finally {
      setRegistryBusy(false);
    }
  }

  async function handleAddRemote() {
    if (!remoteName.trim() || !remoteUrl.trim()) {
      onStatus('Remote connector name and URL are required');
      return;
    }
    try {
      const result = await addRemoteConnector({
        name: remoteName.trim(),
        url: remoteUrl.trim(),
      });
      onStatus(`Added remote connector ${result.connectorId}`);
      setRemoteName('');
      setRemoteUrl('');
      refresh();
    } catch (e) {
      onStatus(`Add remote failed: ${String(e)}`);
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <span>Connectors</span>
      </div>
      <div className="status-item">
        {rows.length === 0 ? (
          <span style={{ fontSize: '13px' }}>No connectors registered yet. Install from the official registry or add a local stdio connector below.</span>
        ) : (
          rows.map((s) => {
            const st = connectorLabel(s);
            const needsSignIn = st.label === 'sign in';
            const canToggle = s.grantStatus === 'active' && s.supportState !== 'adminDisabled' && s.supportState !== 'revoked' && !needsSignIn;
            const toolCaps = (capabilities[s.connectorVersionId] ?? []).filter((cap) => cap.kind === 'tool');
            return (
              <div key={s.connectorVersionId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
                <span style={{ flex: 1 }}>
                  <b>{s.connectorName}</b> <small style={{ color: 'var(--ink-3)' }}>v{s.version} · {s.transport}</small>
                  <small style={{ display: 'block', color: 'var(--ink-3)' }}>
                    Tools: {toolCaps.length > 0 ? toolCaps.map((cap) => cap.name).join(', ') : 'none discovered'}
                  </small>
                  {s.lastError && (st.tone === 'bad' || st.tone === 'warn') && (
                    <small style={{ display: 'block', color: 'var(--ink-3)' }}>{s.lastError}</small>
                  )}
                </span>
                <span className={`status-pill ${st.tone}`} style={{ fontSize: '11px' }}>{st.label}</span>
                {needsSignIn && (
                  <button
                    className="btn ghost"
                    type="button"
                    style={{ padding: '4px 10px' }}
                    disabled={busy === s.connectorVersionId}
                    onClick={() => void handleSignIn(s)}
                  >
                    Sign in
                  </button>
                )}
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
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
          />
          <input
            placeholder="Command (absolute path, no shell)"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
          />
          <input
            placeholder="Arguments (space-separated)"
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
          />
          <textarea
            placeholder="Env (one KEY=VALUE per line)"
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            rows={2}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: '12px' }}
          />
          <input
            placeholder="Consent copy shown to users (optional)"
            value={consentCopy}
            onChange={(e) => setConsentCopy(e.target.value)}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
          />
          <button className="btn primary" type="button" onClick={() => void handleAdd()}>Add local connector</button>
        </div>
        <div style={{ display: 'grid', gap: 6, marginTop: 16 }}>
          <div className="section-label">Official MCP registry</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              placeholder="Search remote servers"
              value={registryQuery}
              onChange={(e) => setRegistryQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleRegistrySearch();
              }}
              style={{ flex: 1, borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
            />
            <button className="btn ghost" type="button" disabled={registryBusy} onClick={() => void handleRegistrySearch()}>
              Search
            </button>
          </div>
          {registryHits.map((hit) => (
            <div key={`${hit.name}:${hit.version}`} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <b>{hit.title || hit.name}</b>
                <small style={{ display: 'block', color: 'var(--ink-3)' }}>
                  {hit.description}
                  {hit.reason ? ` — ${hit.reason}` : ''}
                </small>
              </span>
              <button
                className="btn ghost"
                type="button"
                style={{ padding: '4px 10px' }}
                disabled={registryBusy || !hit.installable}
                onClick={() => void handleInstallRegistry(hit)}
              >
                {hit.installable ? 'Install' : 'Unavailable'}
              </button>
            </div>
          ))}
          <input
            placeholder="Remote connector name"
            value={remoteName}
            onChange={(e) => setRemoteName(e.target.value)}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
          />
          <input
            placeholder="Streamable HTTP URL (https://…/mcp)"
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
          />
          <button className="btn ghost" type="button" onClick={() => void handleAddRemote()}>Add remote connector</button>
        </div>
        <div style={{ marginTop: 16 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>Remembered tool approvals</div>
          {approvals.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-3)' }}>
              No always-allow or per-chat approvals yet.
            </p>
          ) : (
            approvals.map((row) => {
              const tool = row.toolKey.includes('::')
                ? row.toolKey.slice(row.toolKey.indexOf('::') + 2)
                : row.toolKey;
              return (
                <div
                  key={row.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    marginBottom: 6,
                    fontSize: 12.5,
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <b>{tool}</b>
                    {' · '}
                    {row.scope === 'always' ? 'always' : 'this chat'}
                  </span>
                  <button
                    className="btn ghost"
                    type="button"
                    style={{ padding: '4px 10px' }}
                    onClick={() => {
                      void (async () => {
                        await revokeToolApprovalMemory(row.id);
                        refreshApprovals();
                        onStatus(`Forgot approval for ${tool}`);
                      })();
                    }}
                  >
                    Forget
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
