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
import { useT } from '../../i18n';

/** Compact health/support → label mapping for the settings list. */
function connectorLabel(s: ConnectorRuntimeSnapshot): { tone: 'ok' | 'warn' | 'bad' | 'hold'; labelId: string } {
  if (s.grantStatus === 'revoked') return { tone: 'bad', labelId: 'settings.connectors.status.revoked' };
  if (s.supportState === 'adminDisabled') return { tone: 'bad', labelId: 'settings.connectors.status.disabled' };
  if (s.supportState === 'revoked') return { tone: 'bad', labelId: 'settings.connectors.status.revoked' };
  if (s.health === 'authRequired') return { tone: 'warn', labelId: 'settings.connectors.status.signIn' };
  if (s.supportState === 'authRequired') return { tone: 'warn', labelId: 'settings.connectors.status.signIn' };
  if (s.supportState === 'unsupported') return { tone: 'bad', labelId: 'settings.connectors.status.unsupported' };
  if (s.running && s.health === 'healthy') return { tone: 'ok', labelId: 'settings.connectors.status.live' };
  if (s.health === 'down') return { tone: 'bad', labelId: 'settings.connectors.status.down' };
  if (s.health === 'degraded') return { tone: 'warn', labelId: 'settings.connectors.status.degraded' };
  return { tone: 'hold', labelId: 'settings.connectors.status.stopped' };
}

/** Connectors section: list registered connectors with health + start/stop,
 *  revoke a grant, install from the official MCP registry, add a remote
 *  streamable-HTTP URL, or add a local stdio connector. Transport config is
 *  untrusted renderer input — add commands validate it server-side before
 *  persisting. Exported so the first-run `Onboarding` can reuse it. */
/** `showHeader` exists for Onboarding, which renders this section on its own
 *  full-screen route where the inner "Connectors" header is the only title.
 *  Inside SettingsSheet the pane heading already says it, so the sheet passes
 *  false rather than printing the word twice. */
export function ConnectorsSection({
  onStatus,
  showHeader = true,
}: {
  onStatus: (message: string) => void;
  showHeader?: boolean;
}) {
  const t = useT();
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
        onStatus(t('settings.connectors.toggle.stopped', { name: s.connectorName }));
      } else {
        await startConnector(s.connectorVersionId);
        onStatus(t('settings.connectors.toggle.started', { name: s.connectorName }));
      }
      refresh();
    } catch (e) {
      onStatus(t('settings.connectors.toggle.error', { error: String(e) }));
    } finally {
      setBusy(null);
    }
  }

  async function handleRevoke(s: ConnectorRuntimeSnapshot) {
    if (!confirm(t('settings.connectors.revokeConfirm', { name: s.connectorName }))) return;
    try {
      const grants = await listConnectorGrants();
      const g = grants.find((x) => x.connectorVersionId === s.connectorVersionId);
      if (!g) {
        onStatus(t('settings.connectors.noGrantFound'));
        return;
      }
      await revokeConnectorGrant(g.id, s.connectorVersionId);
      onStatus(t('settings.connectors.revokeSucceeded', { name: s.connectorName }));
      refresh();
    } catch (e) {
      onStatus(t('settings.connectors.revokeFailed', { error: String(e) }));
    }
  }

  async function handleAdd() {
    if (!name.trim() || !command.trim()) {
      onStatus(t('settings.connectors.addValidation'));
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
      onStatus(t('settings.connectors.added', { id: result.connectorId }));
      setName('');
      setCommand('');
      setArgs('');
      setEnv('');
      setConsentCopy('');
      refresh();
    } catch (e) {
      onStatus(t('settings.connectors.addFailed', { error: String(e) }));
    }
  }

  async function handleRefreshDiscovery(s: ConnectorRuntimeSnapshot) {
    setRefreshingDiscovery(s.connectorVersionId);
    try {
      const next = await discoverConnector(s.connectorVersionId);
      setCapabilities((current) => ({ ...current, [s.connectorVersionId]: next }));
      onStatus(t('settings.connectors.refreshedTools', { name: s.connectorName }));
      refresh();
    } catch (e) {
      onStatus(t('settings.connectors.discoveryFailed', { error: String(e) }));
    } finally {
      setRefreshingDiscovery(null);
    }
  }

  async function handleSignIn(s: ConnectorRuntimeSnapshot) {
    setBusy(s.connectorVersionId);
    try {
      await signinRemoteConnector(
        s.connectorVersionId,
        t('settings.connectors.oauth.signedIn'),
        // `{detail}` is passed through untouched: only Rust, at callback time,
        // knows what the authorization server said.
        t('settings.connectors.oauth.signInFailed', { detail: '{detail}' }),
      );
      onStatus(t('settings.connectors.signedIn', { name: s.connectorName }));
      refresh();
    } catch (e) {
      onStatus(t('settings.connectors.signInFailed', { error: String(e) }));
    } finally {
      setBusy(null);
    }
  }

  async function handleRegistrySearch() {
    setRegistryBusy(true);
    try {
      const hits = await searchMcpRegistry(registryQuery.trim());
      setRegistryHits(hits);
      onStatus(t('settings.connectors.registrySearch.results', { count: hits.length }));
    } catch (e) {
      onStatus(t('settings.connectors.registrySearchFailed', { error: String(e) }));
    } finally {
      setRegistryBusy(false);
    }
  }

  async function handleInstallRegistry(hit: RegistryServer) {
    if (!hit.installable || !hit.remoteUrl) {
      onStatus(hit.reason ?? t('settings.connectors.needsStreamableHttp'));
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
      onStatus(t('settings.connectors.installedRegistry', { id: result.connectorId }));
      refresh();
    } catch (e) {
      onStatus(t('settings.connectors.installFailed', { error: String(e) }));
    } finally {
      setRegistryBusy(false);
    }
  }

  async function handleAddRemote() {
    if (!remoteName.trim() || !remoteUrl.trim()) {
      onStatus(t('settings.connectors.addRemoteValidation'));
      return;
    }
    try {
      const result = await addRemoteConnector({
        name: remoteName.trim(),
        url: remoteUrl.trim(),
      });
      onStatus(t('settings.connectors.addedRemote', { id: result.connectorId }));
      setRemoteName('');
      setRemoteUrl('');
      refresh();
    } catch (e) {
      onStatus(t('settings.connectors.addRemoteFailed', { error: String(e) }));
    }
  }

  return (
    <div className="settings-section">
      {showHeader && (
        <div className="settings-section-header">
          <span>{t('settings.connectors.header')}</span>
        </div>
      )}
      <div className="status-item">
        {rows.length === 0 ? (
          <span style={{ fontSize: '13px' }}>{t('settings.connectors.emptyState')}</span>
        ) : (
          rows.map((s) => {
            const st = connectorLabel(s);
            const needsSignIn = st.labelId === 'settings.connectors.status.signIn';
            const canToggle = s.grantStatus === 'active' && s.supportState !== 'adminDisabled' && s.supportState !== 'revoked' && !needsSignIn;
            const toolCaps = (capabilities[s.connectorVersionId] ?? []).filter((cap) => cap.kind === 'tool');
            const toolsText =
              toolCaps.length > 0
                ? toolCaps.map((cap) => cap.name).join(', ')
                : t('settings.connectors.noToolsDiscovered');
            return (
              <div key={s.connectorVersionId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '13px' }}>
                <span style={{ flex: 1 }}>
                  <b>{s.connectorName}</b> <small style={{ color: 'var(--ink-3)' }}>v{s.version} · {s.transport}</small>
                  <small style={{ display: 'block', color: 'var(--ink-3)' }}>
                    {t('settings.connectors.toolsList', { list: toolsText })}
                  </small>
                  {s.lastError && (st.tone === 'bad' || st.tone === 'warn') && (
                    <small style={{ display: 'block', color: 'var(--ink-3)' }}>{s.lastError}</small>
                  )}
                </span>
                <span className={`status-pill ${st.tone}`} style={{ fontSize: '11px' }}>{t(st.labelId)}</span>
                {needsSignIn && (
                  <button
                    className="btn ghost"
                    type="button"
                    style={{ padding: '4px 10px' }}
                    disabled={busy === s.connectorVersionId}
                    onClick={() => void handleSignIn(s)}
                  >
                    {t('settings.connectors.signInButton')}
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
                    {s.running ? t('settings.connectors.stopButton') : t('settings.connectors.startButton')}
                  </button>
                )}
                <button
                  className="btn ghost"
                  type="button"
                  style={{ padding: '4px 10px' }}
                  disabled={refreshingDiscovery === s.connectorVersionId || !s.running}
                  onClick={() => void handleRefreshDiscovery(s)}
                >
                  {t('settings.connectors.refreshToolsButton')}
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  style={{ padding: '4px 10px' }}
                  onClick={() => void handleRevoke(s)}
                >
                  {t('settings.connectors.revokeButton')}
                </button>
              </div>
            );
          })
        )}
        {/* Capped rather than two-up: these fields carry their label in the
            placeholder, so halving their width truncates the label. At the
            960px sheet an uncapped input would stretch to ~690px, which reads
            worse than the narrow one it replaced. */}
        <div style={{ display: 'grid', gap: 6, marginTop: 8, maxWidth: '34rem' }}>
          <input
            placeholder={t('settings.connectors.form.namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
          />
          <input
            placeholder={t('settings.connectors.form.commandPlaceholder')}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
          />
          <input
            placeholder={t('settings.connectors.form.argsPlaceholder')}
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
          />
          <textarea
            placeholder={t('settings.connectors.form.envPlaceholder')}
            value={env}
            onChange={(e) => setEnv(e.target.value)}
            rows={2}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px', fontFamily: 'var(--font-mono)', fontSize: '12px' }}
          />
          <input
            placeholder={t('settings.connectors.form.consentPlaceholder')}
            value={consentCopy}
            onChange={(e) => setConsentCopy(e.target.value)}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
          />
          <button className="btn primary" type="button" onClick={() => void handleAdd()}>{t('settings.connectors.form.addButton')}</button>
        </div>
        <div style={{ display: 'grid', gap: 6, marginTop: 16, maxWidth: '34rem' }}>
          <div className="section-label">{t('settings.connectors.registry.heading')}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              placeholder={t('settings.connectors.registry.searchPlaceholder')}
              value={registryQuery}
              onChange={(e) => setRegistryQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleRegistrySearch();
              }}
              style={{ flex: 1, borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
            />
            <button className="btn ghost" type="button" disabled={registryBusy} onClick={() => void handleRegistrySearch()}>
              {t('common.actions.search')}
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
                {hit.installable ? t('settings.connectors.installButton') : t('settings.connectors.unavailableButton')}
              </button>
            </div>
          ))}
          <input
            placeholder={t('settings.connectors.registry.remoteNamePlaceholder')}
            value={remoteName}
            onChange={(e) => setRemoteName(e.target.value)}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
          />
          <input
            placeholder={t('settings.connectors.registry.remoteUrlPlaceholder')}
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
            style={{ width: '100%', borderRadius: 'var(--r-sm)', border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', padding: '8px 10px' }}
          />
          <button className="btn ghost" type="button" onClick={() => void handleAddRemote()}>{t('settings.connectors.registry.addRemoteButton')}</button>
        </div>
        <div style={{ marginTop: 16 }}>
          <div className="section-label" style={{ marginBottom: 8 }}>{t('settings.connectors.approvals.heading')}</div>
          {approvals.length === 0 ? (
            <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-3)' }}>
              {t('settings.connectors.approvals.empty')}
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
                    {row.scope === 'always' ? t('settings.connectors.approvals.scopeAlways') : t('settings.connectors.approvals.scopeThisChat')}
                  </span>
                  <button
                    className="btn ghost"
                    type="button"
                    style={{ padding: '4px 10px' }}
                    onClick={() => {
                      void (async () => {
                        await revokeToolApprovalMemory(row.id);
                        refreshApprovals();
                        onStatus(t('settings.connectors.approvals.forgotStatus', { tool }));
                      })();
                    }}
                  >
                    {t('settings.connectors.approvals.forgetButton')}
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
