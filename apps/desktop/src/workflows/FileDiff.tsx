/// A file change as a line diff: the path and +/- counts on top, old and new
/// line numbers in the gutter, and long diffs folded behind "Show all N lines".
/// Shared by the approval card and a run's details.

import { useState } from 'react';
import { useT } from '../i18n';
import { diffStats, lineDiff, numberRows } from './lineDiff';
import '../styles/computer-card.css';

/// Rows shown before a long diff folds.
const FOLD_AT = 40;

export function FileDiff({ path, previous, content }: { path?: string; previous: string | undefined; content: string }) {
  const t = useT();
  const [all, setAll] = useState(false);
  const isNew = previous === undefined;
  const rows = lineDiff(previous ?? '', content);
  const unchanged = !isNew && rows.every((r) => r.kind === 'same');
  const stats = diffStats(rows);
  const total = rows.reduce((n, r) => n + (r.kind === 'skip' ? r.count : 1), 0);
  const numbered = numberRows(rows);
  const long = numbered.length > FOLD_AT;
  const shown = long && !all ? numbered.slice(0, FOLD_AT) : numbered;

  return (
    <div className="fd">
      {path !== undefined ? (
        <div className="fd-head">
          <code className="fd-path">{path}</code>
          {isNew ? (
            <span className="fd-badge">{t('workspace.workflows.computer.newFileBadge')}</span>
          ) : !unchanged ? (
            <span className="fd-counts">
              <span className="fd-add">+{stats.added}</span> <span className="fd-del">−{stats.removed}</span>
            </span>
          ) : null}
        </div>
      ) : null}
      {unchanged ? (
        <p className="wf-muted">{t('workspace.workflows.computer.noChange')}</p>
      ) : (
        <div
          className="fd-body"
          role="group"
          aria-label={isNew ? t('workspace.workflows.computer.contentLabel') : t('workspace.workflows.computer.diffLabel')}
        >
          {shown.map((row, i) =>
            row.kind === 'skip' ? (
              <div key={i} className="fd-line skip">
                <span className="fd-text">{t('workspace.workflows.computer.unchangedLines', { count: row.count })}</span>
              </div>
            ) : (
              <div key={i} className={`fd-line ${row.kind}`} data-diff={row.kind}>
                <span className="fd-no" aria-hidden="true">{row.oldNo ?? ''}</span>
                <span className="fd-no" aria-hidden="true">{row.newNo ?? ''}</span>
                <span className="fd-sign" aria-hidden="true">{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}</span>
                <span className="fd-text">{row.text}</span>
              </div>
            ),
          )}
        </div>
      )}
      {long && !unchanged ? (
        <button type="button" className="btn ghost fd-toggle" onClick={() => setAll((v) => !v)}>
          {all
            ? t('workspace.workflows.computer.showFewer')
            : t('workspace.workflows.computer.showAll', { count: total })}
        </button>
      ) : null}
    </div>
  );
}
