/// The outside actions a finished step took, in a run's details: one line per
/// action ("Sent “post_message” in Slack") and the exact arguments behind it.
/// A connector step records one `action`; an agent step records `actions[]`.

import { useT, type Translate } from '../i18n';
import type { WorkflowActionOutcome, WorkflowActionRecord } from '../ipc/contracts';

const OUTCOME_KEY: Record<WorkflowActionOutcome, string> = {
  sent: 'workspace.workflows.runDetail.outside.sent',
  sentWithoutAsking: 'workspace.workflows.runDetail.outside.sentWithoutAsking',
  notSent: 'workspace.workflows.runDetail.outside.notSent',
  failed: 'workspace.workflows.runDetail.outside.failed',
};

function isRecord(v: unknown): v is WorkflowActionRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const c = r.connector as Record<string, unknown> | null | undefined;
  return (
    typeof r.tool === 'string' &&
    typeof r.outcome === 'string' &&
    r.outcome in OUTCOME_KEY &&
    !!c &&
    typeof c === 'object' &&
    typeof c.name === 'string'
  );
}

/// The action records in a step's output (`action`, or `actions[]`).
export function stepActions(output: unknown): WorkflowActionRecord[] {
  if (!output || typeof output !== 'object') return [];
  const o = output as Record<string, unknown>;
  if (Array.isArray(o.actions)) return o.actions.filter(isRecord);
  return isRecord(o.action) ? [o.action] : [];
}

/// The outside actions a step took, in a few words for its row in the run.
export function stepActionsSummary(output: unknown, t: Translate): string | null {
  const actions = stepActions(output);
  if (actions.length === 0) return null;
  return actions.map((a) => t(OUTCOME_KEY[a.outcome], { tool: a.tool, connector: a.connector.name })).join(' ');
}

export function StepActions({ output }: { output: unknown }) {
  const t = useT();
  const actions = stepActions(output);
  if (actions.length === 0) return null;
  return (
    <ul className="wf-actions-taken">
      {actions.map((a, i) => (
        <li key={i}>
          <span className={a.outcome === 'failed' ? 'wf-error' : undefined}>
            {t(OUTCOME_KEY[a.outcome], { tool: a.tool, connector: a.connector.name })}
            {a.error ? ` ${a.error}` : ''}
          </span>
          <details>
            <summary className="wf-muted">{t('workspace.workflows.runDetail.outside.arguments')}</summary>
            <pre className="wf-io">{JSON.stringify(a.arguments, null, 2)}</pre>
          </details>
        </li>
      ))}
    </ul>
  );
}
