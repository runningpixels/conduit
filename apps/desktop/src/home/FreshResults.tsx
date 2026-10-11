/// "Fresh from your workflows": the newest results nobody has opened yet.
/// Rendered only when there are some; a card opens that result on the
/// Workflows page.

import { useId } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import type { WorkflowResult } from '../ipc/contracts';
import { primaryOutput } from '../workflows/results';
import type { HomeAction } from './areaInfo';
import type { WorkflowTarget } from './NeedsYou';

export function FreshResults({
  results,
  onAction,
}: {
  results: WorkflowResult[];
  onAction: (action: HomeAction, target?: WorkflowTarget) => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const labelId = useId();
  if (results.length === 0) return null;
  return (
    <section className="home-section" aria-labelledby={labelId}>
      <div className="home-section-head">
        <div className="home-section-heading">
          <h3 id={labelId} className="home-section-title">
            {t('home.fresh.title')}
          </h3>
        </div>
        <div className="home-section-tools">
          <button type="button" className="home-link" onClick={() => onAction('open-results')}>
            {t('home.fresh.seeAll')}
          </button>
        </div>
      </div>
      <ul className="home-fresh">
        {results.map(({ run, workflowName }) => {
          const primary = primaryOutput(run);
          return (
            <li key={run.id} className="home-fresh-item">
              <button
                type="button"
                className="home-fresh-card"
                onClick={() => onAction('open-results', { workflowId: run.workflowId, runId: run.id })}
              >
                <span className="home-fresh-name">
                  {primary ? primary.title : t('workspace.workflows.result.failedTitle', { name: workflowName })}
                </span>
                <span className="home-fresh-meta">
                  {t('home.fresh.meta', { name: workflowName, when: fmt.timeAgo(run.finishedAt ?? run.startedAt) })}
                </span>
                {primary?.preview ? <span className="home-fresh-preview">{primary.preview}</span> : null}
                {!primary && run.error ? <span className="home-fresh-preview">{run.error}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
