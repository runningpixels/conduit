/// The Agents page: every agent step and helper across the workflows as cards,
/// the way Apps shows apps: what each is doing now, what it may use, and how
/// busy it was in the last 30 days. Working agents come first; the whole card
/// opens its workflow. It reads `list_agents` when it opens and again every few
/// seconds while shown.

import { useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { listAgents } from '../ipc/client';
import type { AgentEntry } from '../ipc/contracts';
import { PageEmpty, PageFrame } from '../shell/PageFrame';
import { destinationIcon } from '../shell/Rail';
import { COMPUTER_TOOL } from '../workflows/editorModel';

/// Longest step name: an agent step is named by its instruction's first line.
const STEP_NAME_CHARS = 80;

/// An agent step's name: the first line of its instruction, shortened.
export function stepName(instruction: string): string {
  const line = instruction.trim().split('\n')[0]?.trim() ?? '';
  return line.length > STEP_NAME_CHARS ? `${line.slice(0, STEP_NAME_CHARS - 1).trimEnd()}…` : line;
}

/// How often the list is read while the page is shown.
export const AGENTS_REFRESH_MS = 3000;

type Filter = 'all' | 'working' | 'helpers';

/// Working agents first; otherwise the order `list_agents` gives.
function busyFirst(entries: readonly AgentEntry[]): AgentEntry[] {
  return [...entries].sort((a, b) => Number(b.currentTask !== null) - Number(a.currentTask !== null));
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
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
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

  /// Agent steps per workflow: a workflow's only step goes by the workflow's name.
  const stepsIn = useMemo(() => {
    const counts = new Map<string, number>();
    for (const e of entries ?? []) if (e.kind === 'step') counts.set(e.workflowId, (counts.get(e.workflowId) ?? 0) + 1);
    return counts;
  }, [entries]);

  /// The card's name, and whether that name is the workflow's (then the prompt shows below it).
  const nameOf = (entry: AgentEntry): { name: string; named: boolean } => {
    if (entry.kind === 'helper') return { name: entry.name || entry.agentId, named: true };
    if (stepsIn.get(entry.workflowId) === 1) return { name: entry.workflowName, named: true };
    return { name: stepName(entry.about) || t('shell.agents.kindStep'), named: false };
  };

  const all = useMemo(() => busyFirst(entries ?? []), [entries]);
  const counts = {
    all: all.length,
    working: all.filter((e) => e.currentTask !== null).length,
    helpers: all.filter((e) => e.kind === 'helper').length,
  };
  const q = query.trim().toLocaleLowerCase();
  const shown = all.filter((e) => {
    if (filter === 'working' && e.currentTask === null) return false;
    if (filter === 'helpers' && e.kind !== 'helper') return false;
    if (!q) return true;
    return [nameOf(e).name, e.workflowName, e.about].some((s) => s.toLocaleLowerCase().includes(q));
  });

  const card = (entry: AgentEntry) => {
    const { name, named } = nameOf(entry);
    const busy = entry.currentTask !== null;
    const kind = entry.kind === 'helper' ? t('shell.agents.kindHelper') : t('shell.agents.kindStep');
    const others = entry.tools.filter((x) => x !== COMPUTER_TOOL).length;
    /// The whole task stays in the tooltip; the card shows three lines of it.
    const working = busy ? t('shell.agents.working', { task: entry.currentTask ?? '' }) : '';
    return (
      <li key={`${entry.workflowId}:${entry.kind}:${entry.agentId}`}>
        <button
          type="button"
          className={busy ? 'agent-card is-busy' : 'agent-card'}
          data-agent-id={entry.agentId}
          aria-label={name}
          onClick={() => onOpenWorkflow(entry.workflowId)}
        >
          <span className="agent-card-top">
            <span className="agent-tile" aria-hidden="true">
              {destinationIcon('agents')}
            </span>
            <span className="agent-card-title">
              <span className="agent-name">{name}</span>
              <span className="agent-sub">{name === entry.workflowName ? kind : `${kind} · ${entry.workflowName}`}</span>
            </span>
          </span>
          {busy ? (
            <span className="agent-status is-busy" role="status" title={working}>
              <span className="agent-status-text">{working}</span>
            </span>
          ) : (
            <span className="agent-status">
              <span className="agent-status-text">
                {entry.lastActive ? t('shell.agents.idleSince', { when: fmt.timeAgo(entry.lastActive) }) : t('shell.agents.notUsed')}
              </span>
            </span>
          )}
          {named && entry.about.trim() ? <span className="agent-about">{entry.about.trim()}</span> : null}
          <span className="agent-traits">
            <span className="apps-home-trait" data-tone="ai">
              {entry.model ? entry.model.model : t('shell.agents.workflowModel')}
            </span>
            {entry.tools.includes(COMPUTER_TOOL) ? (
              <span className="apps-home-trait" data-tone="net">
                {t('shell.agents.usesComputer')}
              </span>
            ) : null}
            {others > 0 ? <span className="apps-home-trait">{t('shell.agents.tools', { count: others })}</span> : null}
            {entry.handsTo.length > 0 ? (
              <span className="apps-home-trait">{t('shell.agents.handsTo', { names: entry.handsTo.join(', ') })}</span>
            ) : null}
          </span>
          <span className="agent-stats" title={t('shell.agents.statsLabel')}>
            <span className="agent-stat">
              <b>{fmt.count(entry.tasks)}</b>
              <span>{t('shell.agents.statTasks', { count: entry.tasks })}</span>
            </span>
            <span className={entry.failed > 0 ? 'agent-stat is-bad' : 'agent-stat'}>
              <b>{fmt.count(entry.failed)}</b>
              <span>{t('shell.agents.statFailed')}</span>
            </span>
            <span className="agent-stat">
              <b>{fmt.compact(entry.tokens)}</b>
              <span>{t('shell.agents.statTokens')}</span>
            </span>
          </span>
        </button>
      </li>
    );
  };

  const FILTERS: [Filter, string][] = [
    ['all', t('shell.agents.filterAll')],
    ['working', t('shell.agents.filterWorking')],
    ['helpers', t('shell.agents.filterHelpers')],
  ];

  return (
    <PageFrame destination="agents" title={t('shell.agents.title')} subtitle={t('shell.agents.subtitle')} className="agents-page">
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
        <>
          {failed ? <p className="wf-error">{t('shell.agents.loadFailed')}</p> : null}
          <div className="agents-bar">
            <input
              className="apps-home-search"
              type="search"
              value={query}
              placeholder={t('shell.agents.search')}
              aria-label={t('shell.agents.search')}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="agents-filters" role="group" aria-label={t('shell.agents.filterLabel')}>
              {FILTERS.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className="agents-filter"
                  aria-pressed={filter === key}
                  onClick={() => setFilter(key)}
                >
                  {label}
                  <b>{fmt.count(counts[key])}</b>
                </button>
              ))}
            </div>
          </div>
          {shown.length === 0 ? (
            <p className="apps-home-nomatch">
              {q ? t('shell.agents.noMatch', { query: query.trim() }) : t('shell.agents.noneShown')}
            </p>
          ) : (
            <ul className="agents-grid" aria-label={t('shell.agents.gridLabel')}>
              {shown.map(card)}
            </ul>
          )}
        </>
      )}
    </PageFrame>
  );
}
