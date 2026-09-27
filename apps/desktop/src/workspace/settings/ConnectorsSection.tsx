import { useT } from '../../i18n';
import { ConnectorAddPanel } from './connectors/ConnectorAddPanel';
import { ToolApprovalList } from './connectors/ToolApprovalList';
import { canToggle, connectorLabel, needsSignIn, useConnectors } from './connectors/useConnectors';

/** Connectors section — the compact, single-column layout: registered
 *  connectors with health + start/stop, revoke a grant, the add flows
 *  (registry, remote URL, local stdio) and remembered tool approvals.
 *  The Connectors rail page (pages/ConnectorsPage.tsx) builds a
 *  list-and-detail layout from the same pieces; this one stays for the
 *  first-run `Onboarding` and the Settings sheet. */
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
  const c = useConnectors(onStatus);

  return (
    <div className="settings-section">
      {showHeader && (
        <div className="settings-section-header">
          <span>{t('settings.connectors.header')}</span>
        </div>
      )}
      <div className="status-item">
        {c.rows.length === 0 ? (
          <p className="cx-note">{t('settings.connectors.emptyState')}</p>
        ) : (
          <ul className="cx-rows">
            {c.rows.map((s) => {
              const st = connectorLabel(s);
              const toolCaps = (c.capabilities[s.connectorVersionId] ?? []).filter((cap) => cap.kind === 'tool');
              const toolsText =
                toolCaps.length > 0
                  ? toolCaps.map((cap) => cap.name).join(', ')
                  : t('settings.connectors.noToolsDiscovered');
              return (
                <li key={s.connectorVersionId} className="cx-row">
                  <span className="cx-row-text">
                    <b>
                      {s.connectorName} <small className="cx-inline-meta">v{s.version} · {s.transport}</small>
                    </b>
                    <small>{t('settings.connectors.toolsList', { list: toolsText })}</small>
                    {s.lastError && (st.tone === 'bad' || st.tone === 'warn') && <small>{s.lastError}</small>}
                  </span>
                  <span className={`status-pill ${st.tone}`}>{t(st.labelId)}</span>
                  {needsSignIn(s) && (
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={c.busy === s.connectorVersionId}
                      onClick={() => void c.signIn(s)}
                    >
                      {t('settings.connectors.signInButton')}
                    </button>
                  )}
                  {canToggle(s) && (
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={c.busy === s.connectorVersionId}
                      onClick={() => void c.toggle(s)}
                    >
                      {s.running ? t('settings.connectors.stopButton') : t('settings.connectors.startButton')}
                    </button>
                  )}
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={c.refreshingDiscovery === s.connectorVersionId || !s.running}
                    onClick={() => void c.refreshDiscovery(s)}
                  >
                    {t('settings.connectors.refreshToolsButton')}
                  </button>
                  <button className="btn ghost" type="button" onClick={() => void c.revoke(s)}>
                    {t('settings.connectors.revokeButton')}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <ConnectorAddPanel onStatus={onStatus} onAdded={() => c.refresh()} />
        <div className="cx-add-block">
          <div className="grp-label">{t('settings.connectors.approvals.heading')}</div>
          <ToolApprovalList approvals={c.approvals} onForget={(row) => void c.forgetApproval(row)} />
        </div>
      </div>
    </div>
  );
}
