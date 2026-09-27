/// Connectors (rail destination): MCP servers and what they offer.
///
/// List-and-detail: the list holds every registered connector (status +
/// "local · N tools") and, under Permissions, every remembered tool approval;
/// the detail is the selected connector, or the add flow ("Add connector").
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { PageEmpty, PageFrame, PageListItem } from '../shell/PageFrame';
import { ConnectorAddPanel } from '../workspace/settings/connectors/ConnectorAddPanel';
import { ConnectorDetail, transportLabelId } from '../workspace/settings/connectors/ConnectorDetail';
import { ToolApprovalList } from '../workspace/settings/connectors/ToolApprovalList';
import { connectorLabel, useConnectors } from '../workspace/settings/connectors/useConnectors';

/** Pseudo-selection for the "Remembered approvals" list item. */
const APPROVALS = 'approvals';

export function ConnectorsPage({ onStatus }: { onStatus: (message: string) => void }) {
  const t = useT();
  const state = useConnectors(onStatus);
  const { rows, loaded, approvals } = state;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** A just-added connector: selected before the refresh that lists it lands. */
  const justAdded = useRef<string | null>(null);

  // First connector selected by default; fall back when the selection goes.
  useEffect(() => {
    if (selectedId === APPROVALS) return;
    if (selectedId && rows.some((r) => r.connectorVersionId === selectedId)) {
      if (justAdded.current === selectedId) justAdded.current = null;
      return;
    }
    if (selectedId && justAdded.current === selectedId) return;
    setSelectedId(rows[0]?.connectorVersionId ?? null);
  }, [rows, selectedId]);

  const selected = rows.find((r) => r.connectorVersionId === selectedId) ?? null;
  const select = (id: string) => {
    setAdding(false);
    setSelectedId(id);
  };

  const addButton = (
    <button className="btn primary" type="button" onClick={() => setAdding(true)}>
      {t('settings.connectors.page.add')}
    </button>
  );

  const list = (
    <>
      {rows.length === 0 ? (
        <p className="cx-list-hint">{loaded ? t('settings.connectors.page.listEmpty') : null}</p>
      ) : (
        rows.map((s) => {
          const st = connectorLabel(s);
          const toolCount = (state.capabilities[s.connectorVersionId] ?? []).filter((c) => c.kind === 'tool').length;
          return (
            <PageListItem
              key={s.connectorVersionId}
              selected={!adding && selectedId === s.connectorVersionId}
              onSelect={() => select(s.connectorVersionId)}
              title={s.connectorName}
              status={<span className={`status-pill ${st.tone}`}>{t(st.labelId)}</span>}
              meta={t('settings.connectors.page.meta', { transport: t(transportLabelId(s)), count: toolCount })}
            />
          );
        })
      )}
      <div className="page-list-group">{t('settings.connectors.page.permissionsGroup')}</div>
      <PageListItem
        selected={!adding && selectedId === APPROVALS}
        onSelect={() => select(APPROVALS)}
        title={t('settings.connectors.approvals.heading')}
        meta={t('settings.connectors.page.approvalsMeta', { count: approvals.length })}
      />
    </>
  );

  let detail;
  if (adding) {
    detail = (
      <article className="cx-detail" aria-label={t('settings.connectors.page.addHeading')}>
        <header className="cx-detail-head">
          <div className="cx-detail-heading">
            <h3 className="cx-detail-title">{t('settings.connectors.page.addHeading')}</h3>
          </div>
          <div className="cx-detail-actions">
            <button className="btn ghost" type="button" onClick={() => setAdding(false)}>
              {t('common.actions.cancel')}
            </button>
          </div>
        </header>
        <p className="cx-detail-meta">{t('settings.connectors.page.addHint')}</p>
        <ConnectorAddPanel
          onStatus={onStatus}
          onAdded={(id) => {
            justAdded.current = id;
            state.refresh();
            setAdding(false);
            setSelectedId(id);
          }}
        />
      </article>
    );
  } else if (selectedId === APPROVALS) {
    detail = (
      <article className="cx-detail" aria-label={t('settings.connectors.approvals.heading')}>
        <header className="cx-detail-head">
          <div className="cx-detail-heading">
            <h3 className="cx-detail-title">{t('settings.connectors.approvals.heading')}</h3>
          </div>
        </header>
        <p className="cx-detail-meta">{t('settings.connectors.page.approvalsHint')}</p>
        <ToolApprovalList approvals={approvals} onForget={(row) => void state.forgetApproval(row)} />
      </article>
    );
  } else if (selected) {
    detail = (
      <ConnectorDetail
        snapshot={selected}
        versions={rows.filter((r) => r.connectorId === selected.connectorId)}
        state={state}
        onSelectVersion={select}
      />
    );
  } else if (loaded && rows.length === 0 && !justAdded.current) {
    detail = (
      <PageEmpty
        title={t('settings.connectors.page.emptyTitle')}
        body={t('settings.connectors.page.emptyBody')}
        action={addButton}
      />
    );
  } else {
    detail = null;
  }

  return (
    <PageFrame
      title={t('shell.settingsSheet.connectors.heading')}
      subtitle={t('settings.connectors.page.subtitle')}
      actions={addButton}
      about={
        <>
          <p>{t('shell.settingsSheet.connectors.intro')}</p>
          <p>{t('settings.connectors.page.about')}</p>
        </>
      }
      list={list}
      listLabel={t('shell.settingsSheet.connectors.heading')}
    >
      {detail}
    </PageFrame>
  );
}
