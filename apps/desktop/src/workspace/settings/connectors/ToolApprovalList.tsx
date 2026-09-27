/// Remembered tool approvals ("always" or "this chat"), each with Forget.
import type { ToolApprovalMemoryRow } from '../../../ipc/client';
import { useT } from '../../../i18n';
import { approvalTool } from './useConnectors';

export function ToolApprovalList({
  approvals,
  onForget,
}: {
  approvals: ToolApprovalMemoryRow[];
  onForget: (row: ToolApprovalMemoryRow) => void;
}) {
  const t = useT();
  if (approvals.length === 0) {
    return <p className="cx-note">{t('settings.connectors.approvals.empty')}</p>;
  }
  return (
    <ul className="cx-rows">
      {approvals.map((row) => (
        <li key={row.id} className="cx-row">
          <span className="cx-row-text">
            <b>{approvalTool(row)}</b>
            <small>
              {row.scope === 'always'
                ? t('settings.connectors.approvals.scopeAlways')
                : t('settings.connectors.approvals.scopeThisChat')}
            </small>
          </span>
          <button className="btn ghost" type="button" onClick={() => onForget(row)}>
            {t('settings.connectors.approvals.forgetButton')}
          </button>
        </li>
      ))}
    </ul>
  );
}
