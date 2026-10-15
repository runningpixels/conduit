/// What an agent step handed to its helpers, in a run's details: for each
/// hand-off the helper's name, the task, then its answer (or why it failed) and
/// the tokens it used. A long answer is folded under its first lines.

import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import type { AgentHandoff } from '../ipc/contracts';

/// Longest text shown without folding.
const FOLD_AT = 240;

/// The hand-offs an agent step recorded in its output, in order; none when it has none.
export function handoffsOf(output: unknown): AgentHandoff[] {
  if (!output || typeof output !== 'object') return [];
  const list = (output as Record<string, unknown>).handoffs;
  if (!Array.isArray(list)) return [];
  return list.filter((h): h is AgentHandoff => !!h && typeof h === 'object' && typeof (h as AgentHandoff).task === 'string');
}

/// The tokens an agent step used in total, when it recorded them.
export function stepTokens(output: unknown): number | null {
  if (!output || typeof output !== 'object') return null;
  const tokens = (output as Record<string, unknown>).tokens;
  return typeof tokens === 'number' ? tokens : null;
}

function Folded({ text, className }: { text: string; className?: string }) {
  const flat = text.trim();
  if (flat.length <= FOLD_AT) return <p className={className}>{flat}</p>;
  return (
    <details className="wf-handoff-fold">
      <summary className={className}>{`${flat.slice(0, FOLD_AT - 1)}…`}</summary>
      <p className={className}>{flat}</p>
    </details>
  );
}

export function AgentHandoffs({ output }: { output: unknown }) {
  const t = useT();
  const fmt = useFormatters();
  const handoffs = handoffsOf(output);
  const total = stepTokens(output);
  if (handoffs.length === 0 && total === null) return null;
  return (
    <section className="wf-handoffs" aria-label={t('workspace.workflows.runDetail.handoffs')}>
      {total !== null ? (
        <p className="wf-muted wf-handoff-total">
          {t('workspace.workflows.runDetail.agentTokens', { tokens: fmt.count(total) })}
        </p>
      ) : null}
      {handoffs.length > 0 ? <p className="wf-io-label">{t('workspace.workflows.runDetail.handoffs')}</p> : null}
      <ol className="wf-handoff-list">
        {handoffs.map((h, i) => (
          <li key={i} className="wf-handoff">
            <p className="wf-handoff-head">
              <b>{h.name || h.agent}</b>
              <span className="wf-muted">{t('workspace.workflows.runDetail.handoffTokens', { tokens: fmt.count(h.tokens ?? 0) })}</span>
            </p>
            <Folded className="wf-handoff-task wf-muted" text={`${t('workspace.workflows.runDetail.handoffTask')} ${h.task}`} />
            {h.error ? <p className="wf-error">{h.error}</p> : h.answer ? <Folded text={h.answer} /> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
