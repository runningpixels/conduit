/// The Connectors page's detail pane for one connector version: status and
/// start/stop, what it offers (tools, prompts, resources), its remembered tool
/// approvals, other versions, and revoking its grant.
import type { ConnectorCapability, ConnectorRuntimeSnapshot } from '../../../ipc/contracts';
import type { ToolApprovalMemoryRow } from '../../../ipc/client';
import { useT } from '../../../i18n';
import { ToolApprovalList } from './ToolApprovalList';
import { approvalTool, canToggle, connectorLabel, needsSignIn, type ConnectorsState } from './useConnectors';

function capabilityDetail(cap: ConnectorCapability): string | undefined {
  const schema = cap.schemaJson;
  if (!schema) return undefined;
  if (cap.kind === 'resource' && typeof schema.uri === 'string') return schema.uri;
  if (typeof schema.description === 'string' && schema.description.trim()) return schema.description;
  return undefined;
}

export function transportLabelId(s: ConnectorRuntimeSnapshot): string {
  return s.transport === 'stdio' ? 'settings.connectors.transport.local' : 'settings.connectors.transport.remote';
}

export function ConnectorDetail({
  snapshot: s,
  versions,
  state,
  onSelectVersion,
}: {
  snapshot: ConnectorRuntimeSnapshot;
  /** Every registered version of this connector, including `snapshot`. */
  versions: ConnectorRuntimeSnapshot[];
  state: ConnectorsState;
  onSelectVersion: (connectorVersionId: string) => void;
}) {
  const t = useT();
  const st = connectorLabel(s);
  const caps = state.capabilities[s.connectorVersionId] ?? [];
  const tools = caps.filter((cap) => cap.kind === 'tool');
  const prompts = caps.filter((cap) => cap.kind === 'prompt');
  const resources = caps.filter((cap) => cap.kind === 'resource');
  const approvals = state.approvals.filter((row) =>
    row.toolKey.startsWith(`${s.connectorVersionId}::`),
  );
  const approvalByTool = new Map<string, ToolApprovalMemoryRow>();
  for (const row of approvals) approvalByTool.set(approvalTool(row), row);
  const busy = state.busy === s.connectorVersionId;

  const capList = (items: ConnectorCapability[], withApprovals: boolean) => (
    <ul className="cx-rows">
      {items.map((cap) => {
        const detail = capabilityDetail(cap);
        const approval = withApprovals ? approvalByTool.get(cap.name) : undefined;
        return (
          <li key={cap.id} className="cx-row">
            <span className="cx-row-text">
              <b className="cx-mono">{cap.name}</b>
              {detail ? <small>{detail}</small> : null}
            </span>
            {approval ? (
              <span className="cx-tag">
                {approval.scope === 'always'
                  ? t('settings.connectors.detail.allowedAlways')
                  : t('settings.connectors.detail.allowedThisChat')}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );

  return (
    <article className="cx-detail" aria-label={s.connectorName}>
      <header className="cx-detail-head">
        <div className="cx-detail-heading">
          <h3 className="cx-detail-title">{s.connectorName}</h3>
          <span className={`status-pill ${st.tone}`}>{t(st.labelId)}</span>
        </div>
        <div className="cx-detail-actions">
          <button
            className="btn ghost"
            type="button"
            disabled={state.refreshingDiscovery === s.connectorVersionId || !s.running}
            onClick={() => void state.refreshDiscovery(s)}
          >
            {t('settings.connectors.refreshToolsButton')}
          </button>
          {needsSignIn(s) && (
            <button className="btn primary" type="button" disabled={busy} onClick={() => void state.signIn(s)}>
              {t('settings.connectors.signInButton')}
            </button>
          )}
          {canToggle(s) && (
            <button
              className={s.running ? 'btn' : 'btn primary'}
              type="button"
              disabled={busy}
              onClick={() => void state.toggle(s)}
            >
              {s.running ? t('settings.connectors.stopButton') : t('settings.connectors.startButton')}
            </button>
          )}
        </div>
      </header>
      <p className="cx-detail-meta">
        {t('settings.connectors.detail.meta', { version: s.version, transport: t(transportLabelId(s)) })}
      </p>
      {s.lastError && (st.tone === 'bad' || st.tone === 'warn') ? (
        <p className="cx-error" role="status">
          {s.lastError}
        </p>
      ) : null}

      <section className="grp">
        <div className="grp-label">{t('settings.connectors.detail.tools', { count: tools.length })}</div>
        {tools.length > 0 ? (
          capList(tools, true)
        ) : (
          <p className="cx-note">{t('settings.connectors.detail.nothingDiscovered')}</p>
        )}
      </section>

      {prompts.length > 0 ? (
        <section className="grp">
          <div className="grp-label">{t('settings.connectors.detail.prompts', { count: prompts.length })}</div>
          {capList(prompts, false)}
        </section>
      ) : null}

      {resources.length > 0 ? (
        <section className="grp">
          <div className="grp-label">{t('settings.connectors.detail.resources', { count: resources.length })}</div>
          {capList(resources, false)}
        </section>
      ) : null}

      <section className="grp">
        <div className="grp-label">{t('settings.connectors.approvals.heading')}</div>
        {approvals.length > 0 ? (
          <ToolApprovalList approvals={approvals} onForget={(row) => void state.forgetApproval(row)} />
        ) : (
          <p className="cx-note">{t('settings.connectors.detail.approvalsEmpty')}</p>
        )}
      </section>

      {versions.length > 1 ? (
        <section className="grp">
          <div className="grp-label">{t('settings.connectors.detail.versions')}</div>
          <div className="cx-versions">
            {versions.map((v) => (
              <button
                key={v.connectorVersionId}
                type="button"
                className="cx-version"
                aria-current={v.connectorVersionId === s.connectorVersionId ? 'true' : undefined}
                onClick={() => onSelectVersion(v.connectorVersionId)}
              >
                v{v.version}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <section className="grp cx-danger">
        <div className="grp-label">{t('settings.connectors.detail.access')}</div>
        <div className="cx-row">
          <span className="cx-row-text">
            <small>{t('settings.connectors.detail.accessHint')}</small>
          </span>
          <button className="btn ghost" type="button" onClick={() => void state.revoke(s)}>
            {t('settings.connectors.revokeButton')}
          </button>
        </div>
      </section>
    </article>
  );
}
