/// The Agents page: every agent step and helper across the workflows, grouped by
/// workflow, with what each is doing now and how busy it was in the last 30 days.
/// It reads `list_agents` when it opens and again every few seconds while shown.

import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { listAgents } from '../ipc/client';
import type { AgentEntry } from '../ipc/contracts';
import { PageEmpty, PageFrame } from '../shell/PageFrame';

/// Longest step name: an agent step is named by its instruction's first line.
const STEP_NAME_CHARS = 80;

/// An agent step's name: the first line of its instruction, shortened.
export function stepName(instruction: string): string {
  const line = instruction.trim().split('\n')[0]?.trim() ?? '';
  return line.length > STEP_NAME_CHARS ? `${line.slice(0, STEP_NAME_CHARS - 1).trimEnd()}…` : line;
}

/// How often the list is read while the page is shown.
export const AGENTS_REFRESH_MS = 3000;

interface Group {
  workflowId: string;
  workflowName: string;
  agents: AgentEntry[];
}

function groupByWorkflow(entries: readonly AgentEntry[]): Group[] {
  const groups = new Map<string, Group>();
  for (const entry of entries) {
    const group = groups.get(entry.workflowId) ?? { workflowId: entry.workflowId, workflowName: entry.workflowName, agents: [] };
    group.agents.push(entry);
    groups.set(entry.workflowId, group);
  }
  return [...groups.values()];
}

export function AgentsPage({
  onOpenWorkflow,
  onOpenWorkflows,
}: {
  /// Open this workflow in the Workflows page.
  onOpenWorkflow: (workflowId: string) => void;
  /// Go to the Workflows page (the empty state's button).
  onOpenWorkflows: () => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const [entries, setEntries] = useState<AgentEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const read = () => {
      Promise.resolve()
        .then(() => listAgents())
        .then((list) => {
          if (cancelled) return;
          setEntries(Array.isArray(list) ? list : []);
          setFailed(false);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    read();
    const timer = setInterval(read, AGENTS_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const groups = useMemo(() => groupByWorkflow(entries ?? []), [entries]);

  const nameOf = (entry: AgentEntry): string =>
    entry.kind === 'helper' ? entry.name || entry.agentId : stepName(entry.about) || t('shell.agents.kindStep');

  /// Its model, tools and who it hands work to; empty when it has none of them.
  const meta = (entry: AgentEntry): string =>
    [
      entry.model ? entry.model.model : null,
      entry.tools.length > 0 ? t('shell.agents.tools', { count: entry.tools.length }) : null,
      entry.handsTo.length > 0 ? t('shell.agents.handsTo', { names: entry.handsTo.join(', ') }) : null,
    ]
      .filter((x): x is string => x !== null)
      .join(' · ');

  const status = (entry: AgentEntry) => {
    if (entry.currentTask !== null) {
      return (
        <span className="agent-status agent-status-busy" role="status">
          <span className="agent-pulse" aria-hidden="true" />
          {t('shell.agents.working', { task: entry.currentTask })}
        </span>
      );
    }
    return (
      <span className="agent-status wf-muted">
        {entry.lastActive
          ? t('shell.agents.idleSince', { when: fmt.timeAgo(entry.lastActive) })
          : t('shell.agents.notUsed')}
      </span>
    );
  };

  return (
    <PageFrame title={t('shell.agents.title')} subtitle={t('shell.agents.subtitle')} className="agents-page">
      {entries === null ? (
        <p className="wf-muted">{failed ? t('shell.agents.loadFailed') : t('shell.agents.loading')}</p>
      ) : entries.length === 0 ? (
        <PageEmpty
          title={t('shell.agents.emptyTitle')}
          body={t('shell.agents.emptyBody')}
          action={
            <button type="button" className="btn" onClick={onOpenWorkflows}>
              {t('shell.agents.action')}
            </button>
          }
        />
      ) : (
        <div className="agents-groups">
          {failed ? <p className="wf-error">{t('shell.agents.loadFailed')}</p> : null}
          {groups.map((group) => (
            <section key={group.workflowId} className="agents-group" aria-label={group.workflowName}>
              <header className="agents-group-head">
                <h3 className="agents-group-title">{group.workflowName}</h3>
                <button type="button" className="btn ghost" onClick={() => onOpenWorkflow(group.workflowId)}>
                  {t('shell.agents.openWorkflow')}
                </button>
              </header>
              <ul className="agents-list">
                {group.agents.map((entry) => (
                  <li
                    key={`${entry.kind}:${entry.agentId}`}
                    className={entry.currentTask !== null ? 'agent-card is-busy' : 'agent-card'}
                    data-agent-id={entry.agentId}
                  >
                    <div className="agent-card-head">
                      <b className="agent-name">{nameOf(entry)}</b>
                      <span className="wf-flag">
                        {entry.kind === 'helper' ? t('shell.agents.kindHelper') : t('shell.agents.kindStep')}
                      </span>
                    </div>
                    {status(entry)}
                    {meta(entry) ? <p className="wf-muted agent-meta">{meta(entry)}</p> : null}
                    <p className="wf-muted agent-stats">
                      {t('shell.agents.stats', {
                        tasks: entry.tasks,
                        failed: fmt.count(entry.failed),
                        tokens: fmt.count(entry.tokens),
                      })}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </PageFrame>
  );
}
