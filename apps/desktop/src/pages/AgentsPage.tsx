/// The Agents page, in two sections of cards, the way Apps shows apps: what each
/// agent is doing now, what it may use, and how busy it was in the last 30 days.
/// "Your agents" are the ones the user made once to use in any workflow (New,
/// Edit, Duplicate, Delete). "In workflows" are the agent steps and helpers that
/// belong to one workflow; the whole card opens it. Working agents come first.
/// It reads the lists when it opens and again every few seconds while shown.
/// Above them, "Running now" lists every agent at work, in chats and workflow
/// runs, from the shell's live list; a row opens it where it works.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentEditorDialog } from '../agents/AgentEditorDialog';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { RoutineDialog } from '../agents/RoutineDialog';
import { libraryNames } from '../agents/useLibraryAgents';
import {
  createLibraryAgent,
  deleteLibraryAgent,
  listAgents,
  listLibraryAgents,
  listRoutines,
  setWorkflowSchedule,
} from '../ipc/client';
import type { AgentCallChange, AgentEntry, LibraryAgent, RoutineSummary } from '../ipc/contracts';
import { formatNextRun } from '../workflows/ScheduleSection';
import { useNow } from '../agents/useNow';
import { PageFrame } from '../shell/PageFrame';
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

type Filter = 'all' | 'working' | 'helpers' | 'routines';

/// When a routine runs, in words: "On weekdays at 08:00", "Every 4 hours", "When a file arrives".
export function routineWhenText(routine: RoutineSummary, t: ReturnType<typeof useT>): string {
  const spec = routine.schedule;
  if (spec?.kind === 'trigger' || routine.trigger) {
    return routine.trigger?.kind === 'feed' ? t('shell.agents.routines.onFeed') : t('shell.agents.routines.onFolder');
  }
  if (spec?.kind === 'daily') return t('shell.agents.routines.dailyAt', { time: spec.time });
  if (spec?.kind === 'weekdays') return t('shell.agents.routines.weekdaysAt', { time: spec.time });
  if (spec?.kind === 'interval') return t('shell.agents.routines.everyHours', { count: spec.hours });
  return t('shell.agents.routines.noSchedule');
}

/// Working agents first; otherwise the order `list_agents` gives.
function busyFirst(entries: readonly AgentEntry[]): AgentEntry[] {
  return [...entries].sort((a, b) => Number(b.currentTask !== null) - Number(a.currentTask !== null));
}

/// Where "Working on <task>" leads: the run it is part of, or the chat it is working in.
type TaskLink = { kind: 'run'; workflowId: string; runId: string } | { kind: 'chat'; conversationId: string };

/// The place to watch an entry's current task, when there is one.
function runLink(entry: AgentEntry | undefined): TaskLink | null {
  return entry?.currentTask != null && entry.currentRunId
    ? { kind: 'run', workflowId: entry.workflowId, runId: entry.currentRunId }
    : null;
}

/// What one of the user's agents did, in workflows and in chat: their tasks and tokens added up.
function activityOf(agent: LibraryAgent, entries: readonly AgentEntry[]) {
  const mine = entries.filter((e) => e.library === agent.agent.id);
  const chat = agent.chat;
  const latest = (a: string | null, b: string | null | undefined) => (b && (!a || b > a) ? b : a);
  const busyEntry = mine.find((e) => e.currentTask !== null);
  const link: TaskLink | null =
    runLink(busyEntry) ??
    (!busyEntry && chat?.currentTask != null && chat.currentConversationId
      ? { kind: 'chat', conversationId: chat.currentConversationId }
      : null);
  return {
    link,
    working: busyEntry?.currentTask ?? chat?.currentTask ?? null,
    lastActive: latest(mine.reduce<string | null>((acc, e) => latest(acc, e.lastActive), null), chat?.lastActive),
    tasks: mine.reduce((n, e) => n + e.tasks, 0) + (chat?.tasks ?? 0),
    failed: mine.reduce((n, e) => n + e.failed, 0) + (chat?.failed ?? 0),
    tokens: mine.reduce((n, e) => n + e.tokens, 0) + (chat?.tokens ?? 0),
  };
}

const NO_RUNNING: readonly AgentCallChange[] = [];

export function AgentsPage({
  onOpenWorkflow,
  onOpenWorkflows,
  onOpenConversation,
  running = NO_RUNNING,
  chatTitle,
  onOpenAgent,
  onOpenDocuments,
  onAskAgent,
}: {
  /// Agent calls running now, chats and workflow runs (the shell keeps the list).
  running?: readonly AgentCallChange[];
  /// A chat's title, for where a running agent works.
  chatTitle?: (conversationId: string) => string | null;
  /// Open a chat helper's own view.
  onOpenAgent?: (conversationId: string, callId: string) => void;
  /// Open this workflow in the Workflows page, on this run when one is given.
  onOpenWorkflow: (workflowId: string, runId?: string) => void;
  /// Open this chat conversation.
  onOpenConversation?: (conversationId: string) => void;
  /// Go to the Workflows page (the empty "In workflows" section's button).
  onOpenWorkflows: () => void;
  /// Go to Documents, where collections are made (the agent editor's "What it can read").
  onOpenDocuments?: () => void;
  /// Start a new chat with this agent picked in the composer.
  onAskAgent?: (agent: { id: string; name: string }) => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const [entries, setEntries] = useState<AgentEntry[] | null>(null);
  const [library, setLibrary] = useState<LibraryAgent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  /// The editor dialog; `agent` null makes a new one.
  const [editing, setEditing] = useState<{ agent: LibraryAgent | null } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /// Every routine (an agent on a schedule); read with the lists, but a failure only leaves it empty.
  const [routines, setRoutines] = useState<RoutineSummary[]>([]);
  /// The agent being put on a schedule.
  const [scheduling, setScheduling] = useState<LibraryAgent | null>(null);
  const now = useNow(running.length > 0);
  const stopped = useRef(false);
  const read = useCallback(() => {
    Promise.resolve()
      .then(() => Promise.all([listAgents(), listLibraryAgents()]))
      .then(([list, mine]) => {
        if (stopped.current) return;
        setEntries(Array.isArray(list) ? list : []);
        setLibrary(Array.isArray(mine) ? mine : []);
        setFailed(false);
      })
      .catch(() => {
        if (!stopped.current) setFailed(true);
      });
    Promise.resolve()
      .then(() => listRoutines())
      .then((list) => {
        if (!stopped.current) setRoutines(Array.isArray(list) ? list : []);
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    stopped.current = false;
    read();
    const timer = setInterval(read, AGENTS_REFRESH_MS);
    return () => {
      stopped.current = true;
      clearInterval(timer);
    };
  }, [read]);

  const failedAction = (e: unknown) =>
    setActionError(t('shell.agents.actionFailed', { error: e instanceof Error ? e.message : String(e) }));
  const duplicate = (agent: LibraryAgent) => {
    setActionError(null);
    createLibraryAgent({ ...agent.agent, id: '', name: t('shell.agents.copyName', { name: agent.agent.name }) })
      .then(read)
      .catch(failedAction);
  };
  const remove = (agent: LibraryAgent) => {
    if (!window.confirm(t('shell.agents.deleteConfirm', { name: agent.agent.name }))) return;
    setActionError(null);
    deleteLibraryAgent(agent.agent.id).then(read).catch(failedAction);
  };

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

  /// The user's agents with what their copies in workflows did, busy ones first.
  const mine = useMemo(
    () =>
      (library ?? [])
        .map((agent) => ({ agent, ...activityOf(agent, entries ?? []) }))
        .sort((a, b) => Number(b.working !== null) - Number(a.working !== null)),
    [library, entries],
  );
  /// Entries that belong to one workflow; the user's agents have their own cards.
  const all = useMemo(() => busyFirst((entries ?? []).filter((e) => !e.library)), [entries]);
  const routinesOf = (agentId: string) => routines.filter((r) => r.agentId === agentId);
  const routineIds = new Set(routines.map((r) => r.workflowId));
  /// The line under an agent's name. Routines are listed on the card, so they count here too.
  const usedBySubtitle = (workflows: number, routineCount: number) =>
    routineCount === 0
      ? t('shell.agents.usedIn', { count: workflows })
      : workflows === 0
        ? t('shell.agents.usedInRoutines', { count: routineCount })
        : t('shell.agents.usedInBoth', { workflows, routines: routineCount });
  const counts: Record<Filter, number> = {
    all: all.length + mine.length,
    working: all.filter((e) => e.currentTask !== null).length + mine.filter((m) => m.working !== null).length,
    helpers: all.filter((e) => e.kind === 'helper').length + mine.length,
    routines: routines.length,
  };
  const q = query.trim().toLocaleLowerCase();
  const shown = all.filter((e) => {
    if (filter === 'working' && e.currentTask === null) return false;
    if (filter === 'helpers' && e.kind !== 'helper') return false;
    if (filter === 'routines') return false;
    if (!q) return true;
    return [nameOf(e).name, e.workflowName, e.about].some((s) => s.toLocaleLowerCase().includes(q));
  });
  const shownMine = mine.filter((m) => {
    if (filter === 'working' && m.working === null) return false;
    if (filter === 'routines' && routinesOf(m.agent.agent.id).length === 0) return false;
    if (!q) return true;
    return [m.agent.agent.name, m.agent.agent.instructions, ...routinesOf(m.agent.agent.id).map((r) => r.name)].some((s) =>
      s.toLocaleLowerCase().includes(q),
    );
  });

  /// Pause or resume a routine: its schedule, switched off or on.
  const setRoutineOn = (routine: RoutineSummary, on: boolean) => {
    if (!routine.schedule) return;
    setActionError(null);
    setWorkflowSchedule(routine.workflowId, routine.schedule, on).then(read).catch(failedAction);
  };

  /// A card's routines: a heading with "Run on a schedule…", then for each when it runs, its next run or
  /// that it is paused, its last result, and its controls.
  const routineList = (lib: LibraryAgent, agentName: string, list: readonly RoutineSummary[]) => (
    <div className="agent-routines-block">
      <div className="agent-routines-head">
        <span className="agent-routines-title">{t('shell.agents.routines.filter')}</span>
        <button
          type="button"
          className="agent-routines-add"
          aria-label={t('shell.agents.routines.scheduleLabel', { name: agentName })}
          onClick={() => setScheduling(lib)}
        >
          <span aria-hidden="true">+ </span>
          {t('shell.agents.routines.schedule')}
        </button>
      </div>
      {list.length === 0 ? null : (
      <ul className="agent-routines" aria-label={t('shell.agents.routines.listLabel', { name: agentName })}>
        {list.map((r) => (
          <li key={r.workflowId} className="agent-routine">
            <span className="agent-routine-text">
              <span className="agent-routine-name">{r.name}</span>
              <span className="agent-routine-when">
                {routineWhenText(r, t)}
                {' · '}
                {r.enabled
                  ? r.nextRunAt
                    ? t('shell.agents.routines.next', { when: formatNextRun(r.nextRunAt, fmt.locale) })
                    : t('shell.agents.routines.on')
                  : t('shell.agents.routines.paused')}
              </span>
              {r.lastRunAt ? (
                <span className={r.lastRunStatus === 'failed' ? 'agent-routine-last is-bad' : 'agent-routine-last'}>
                  {r.lastRunStatus === 'failed'
                    ? t('shell.agents.routines.lastFailed', { when: fmt.timeAgo(r.lastRunAt) })
                    : r.lastResultTitle
                      ? t('shell.agents.routines.lastResult', { title: r.lastResultTitle, when: fmt.timeAgo(r.lastRunAt) })
                      : t('shell.agents.routines.lastRun', { when: fmt.timeAgo(r.lastRunAt) })}
                </span>
              ) : null}
            </span>
            <span className="agent-routine-actions">
              {r.schedule ? (
                <button
                  type="button"
                  className="btn ghost"
                  aria-label={
                    r.enabled
                      ? t('shell.agents.routines.pauseLabel', { name: r.name })
                      : t('shell.agents.routines.resumeLabel', { name: r.name })
                  }
                  onClick={() => setRoutineOn(r, !r.enabled)}
                >
                  {r.enabled ? t('shell.agents.routines.pause') : t('shell.agents.routines.resume')}
                </button>
              ) : null}
              <button
                type="button"
                className="btn ghost"
                aria-label={t('shell.agents.routines.openLabel', { name: r.name })}
                onClick={() => onOpenWorkflow(r.workflowId, r.lastRunId ?? undefined)}
              >
                {t('shell.agents.routines.open')}
              </button>
            </span>
          </li>
        ))}
      </ul>
      )}
    </div>
  );
  const filtering = q !== '' || filter !== 'all';

  const follow = (link: TaskLink) =>
    link.kind === 'run' ? onOpenWorkflow(link.workflowId, link.runId) : onOpenConversation?.(link.conversationId);

  /// What a card says it is doing, or when it was last busy. The task is a link to
  /// where it is happening; inside a card that is itself a button it is a link role.
  const status = (working: string | null, lastActive: string | null, link: TaskLink | null = null, nested = false) =>
    working !== null ? (
      <span className="agent-status is-busy" role="status" title={t('shell.agents.working', { task: working })}>
        {link && (link.kind === 'run' || onOpenConversation) ? (
          nested ? (
            <span
              className="agent-status-text agent-status-link"
              role="link"
              tabIndex={0}
              title={t('shell.agents.openTask')}
              onClick={(e) => {
                e.stopPropagation();
                follow(link);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  follow(link);
                }
              }}
            >
              {t('shell.agents.working', { task: working })}
            </span>
          ) : (
            <button
              type="button"
              className="agent-status-text agent-status-link"
              title={t('shell.agents.openTask')}
              onClick={() => follow(link)}
            >
              {t('shell.agents.working', { task: working })}
            </button>
          )
        ) : (
          <span className="agent-status-text">{t('shell.agents.working', { task: working })}</span>
        )}
      </span>
    ) : (
      <span className="agent-status">
        <span className="agent-status-text">
          {lastActive ? t('shell.agents.idleSince', { when: fmt.timeAgo(lastActive) }) : t('shell.agents.notUsed')}
        </span>
      </span>
    );

  /// The model, computer use, tool count and who it hands work to.
  const traits = (model: { model: string } | null | undefined, tools: readonly string[], handsTo: readonly string[], extra?: { notes: number | null; collections: number }) => {
    const others = tools.filter((x) => x !== COMPUTER_TOOL).length;
    return (
      <span className="agent-traits">
        <span className="apps-home-trait" data-tone="ai">
          {model ? model.model : t('shell.agents.workflowModel')}
        </span>
        {tools.includes(COMPUTER_TOOL) ? (
          <span className="apps-home-trait" data-tone="net">
            {t('shell.agents.usesComputer')}
          </span>
        ) : null}
        {others > 0 ? <span className="apps-home-trait">{t('shell.agents.tools', { count: others })}</span> : null}
        {handsTo.length > 0 ? (
          <span className="apps-home-trait">{t('shell.agents.handsTo', { names: handsTo.join(', ') })}</span>
        ) : null}
        {extra && extra.notes !== null ? (
          <span className="apps-home-trait">{t('shell.agents.remembers', { count: extra.notes })}</span>
        ) : null}
        {extra && extra.collections > 0 ? (
          <span className="apps-home-trait">{t('shell.agents.reads', { count: extra.collections })}</span>
        ) : null}
      </span>
    );
  };

  /// Tasks, failures and tokens of the last 30 days.
  const stats = (tasks: number, failedCount: number, tokens: number) => (
    <span className="agent-stats" title={t('shell.agents.statsLabel')}>
      <span className="agent-stat">
        <b>{fmt.count(tasks)}</b>
        <span>{t('shell.agents.statTasks', { count: tasks })}</span>
      </span>
      <span className={failedCount > 0 ? 'agent-stat is-bad' : 'agent-stat'}>
        <b>{fmt.count(failedCount)}</b>
        <span>{t('shell.agents.statFailed')}</span>
      </span>
      <span className="agent-stat">
        <b>{fmt.compact(tokens)}</b>
        <span>{t('shell.agents.statTokens')}</span>
      </span>
    </span>
  );

  /// One of the user's agents: not a link, it has its own buttons.
  const libraryCard = (m: (typeof mine)[number]) => {
    const { agent: lib } = m;
    const def = lib.agent;
    const name = def.name || def.id;
    const busy = m.working !== null;
    const about = def.instructions.trim().split('\n')[0]?.trim() ?? '';
    const handsTo = (def.agents ?? []).map((id) => library?.find((a) => a.agent.id === id)?.agent.name || id);
    return (
      <li key={def.id}>
        <div className={busy ? 'agent-card is-busy' : 'agent-card'} data-agent-id={def.id} role="group" aria-label={name}>
          <span className="agent-card-top">
            <span className="agent-tile" aria-hidden="true">
              {destinationIcon('agents')}
            </span>
            <span className="agent-card-title">
              <span className="agent-name">{name}</span>
              <span className="agent-sub">
                {usedBySubtitle(lib.usedBy.filter((u) => !routineIds.has(u.workflowId)).length, routinesOf(def.id).length)}
              </span>
            </span>
          </span>
          {/* Never busy yet: the line under its name already says it isn't used. */}
          {m.working !== null || m.lastActive ? status(m.working, m.lastActive, m.link) : null}
          {about ? <span className="agent-about">{about}</span> : null}
          {traits(def.model, def.tools ?? [], handsTo, {
            notes: def.memory ? lib.notes : null,
            collections: (def.knowledge ?? []).length,
          })}
          {stats(m.tasks, m.failed, m.tokens)}
          {routineList(lib, name, routinesOf(def.id))}
          <span className="agent-actions">
            {onAskAgent && (
              <button
                type="button"
                className="btn"
                aria-label={t('shell.agents.askLabel', { name })}
                onClick={() => onAskAgent({ id: def.id, name })}
              >
                {t('shell.agents.ask')}
              </button>
            )}
            <button
              type="button"
              className="btn ghost"
              aria-label={t('shell.agents.editLabel', { name })}
              onClick={() => setEditing({ agent: lib })}
            >
              {t('common.actions.edit')}
            </button>
            <button type="button" className="btn ghost" aria-label={t('shell.agents.duplicateLabel', { name })} onClick={() => duplicate(lib)}>
              {t('shell.agents.duplicate')}
            </button>
            <button type="button" className="btn ghost" aria-label={t('shell.agents.deleteLabel', { name })} onClick={() => remove(lib)}>
              {t('common.actions.delete')}
            </button>
          </span>
        </div>
      </li>
    );
  };

  /// An agent step or a helper that belongs to one workflow: the whole card opens it.
  const card = (entry: AgentEntry) => {
    const { name, named } = nameOf(entry);
    const busy = entry.currentTask !== null;
    const kind = entry.kind === 'helper' ? t('shell.agents.kindHelper') : t('shell.agents.kindStep');
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
          {status(entry.currentTask, entry.lastActive, runLink(entry), true)}
          {named && entry.about.trim() ? <span className="agent-about">{entry.about.trim()}</span> : null}
          {traits(entry.model, entry.tools, entry.handsTo)}
          {stats(entry.tasks, entry.failed, entry.tokens)}
        </button>
      </li>
    );
  };

  /// One agent at work: who, on what, where, for how long. It opens where it works.
  const runningRow = (row: AgentCallChange) => {
    const name = row.name || row.agentId;
    // A helper inside a workflow run can lack its own workflow id; its run's
    // other calls (or its parent) know it.
    const workflowId =
      row.workflowId ??
      (row.runId
        ? running.find((r) => r.runId === row.runId && r.workflowId)?.workflowId
        : running.find((r) => r.id === row.parentId)?.workflowId) ??
      null;
    const workflowName = workflowId
      ? (entries ?? []).find((e) => e.workflowId === workflowId)?.workflowName
      : undefined;
    const title = row.conversationId ? chatTitle?.(row.conversationId) : null;
    const where = row.runId
      ? workflowName
        ? t('shell.agents.runningIn', { name: workflowName })
        : t('shell.agents.runningInWorkflow')
      : title
        ? t('shell.agents.runningIn', { name: title })
        : t('shell.agents.runningInChat');
    const started = Date.parse(row.startedAt);
    const elapsed = Number.isFinite(started) ? fmt.duration(Math.max(0, now - started)) : '';
    const open = () => {
      if (workflowId) onOpenWorkflow(workflowId, row.runId ?? undefined);
      else if (row.runId) onOpenWorkflows();
      else if (row.conversationId && row.kind === 'helper' && onOpenAgent) onOpenAgent(row.conversationId, row.id);
      else if (row.conversationId) onOpenConversation?.(row.conversationId);
    };
    return (
      <li key={row.id}>
        <button
          type="button"
          className="agents-running-row"
          title={row.task}
          aria-label={t('chat.agentView.openAria', { name, task: row.task })}
          onClick={open}
        >
          <span className="agents-running-name">{name}</span>
          <span className="agents-running-task">{row.task}</span>
          <span className="agents-running-where">{where}</span>
          <span className="agents-running-time">{elapsed}</span>
        </button>
      </li>
    );
  };

  const FILTERS: [Filter, string][] = [
    ['all', t('shell.agents.filterAll')],
    ['working', t('shell.agents.filterWorking')],
    ['helpers', t('shell.agents.filterHelpers')],
    ['routines', t('shell.agents.routines.filter')],
  ];

  return (
    <PageFrame
      destination="agents"
      title={t('shell.agents.title')}
      subtitle={t('shell.agents.subtitle')}
      className="agents-page"
      actions={
        <button type="button" className="btn primary" onClick={() => setEditing({ agent: null })}>
          {t('shell.agents.newAgent')}
        </button>
      }
    >
      {running.length > 0 ? (
        <section className="agents-section agents-running" aria-labelledby="agents-running-title">
          <div className="agents-section-head">
            <h3 id="agents-running-title">{t('shell.agents.runningTitle')}</h3>
            <p>{t('shell.agents.runningHint')}</p>
          </div>
          <ul className="agents-running-list" aria-label={t('shell.agents.runningTitle')}>
            {running.map(runningRow)}
          </ul>
        </section>
      ) : null}
      {entries === null || library === null ? (
        <p className="wf-muted">{failed ? t('shell.agents.loadFailed') : t('shell.agents.loading')}</p>
      ) : (
        <>
          {failed ? <p className="wf-error">{t('shell.agents.loadFailed')}</p> : null}
          {actionError ? (
            <p className="wf-error" role="alert">
              {actionError}
            </p>
          ) : null}
          {counts.all > 0 ? (
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
          ) : null}
          {filtering && shown.length === 0 && shownMine.length === 0 ? (
            <p className="apps-home-nomatch">
              {q ? t('shell.agents.noMatch', { query: query.trim() }) : t('shell.agents.noneShown')}
            </p>
          ) : (
            <>
              <section className="agents-section" aria-labelledby="agents-yours-title">
                <div className="agents-section-head">
                  <h3 id="agents-yours-title">{t('shell.agents.yourTitle')}</h3>
                  <p>{t('shell.agents.yourHint')}</p>
                </div>
                {mine.length === 0 ? (
                  <p className="agents-lib-empty">{t('shell.agents.yourEmpty')}</p>
                ) : shownMine.length > 0 ? (
                  <ul className="agents-grid" aria-label={t('shell.agents.yourTitle')}>
                    {shownMine.map(libraryCard)}
                  </ul>
                ) : null}
              </section>
              {!filtering || shown.length > 0 ? (
                <section className="agents-section" aria-labelledby="agents-workflows-title">
                  <div className="agents-section-head">
                    <h3 id="agents-workflows-title">{t('shell.agents.workflowsTitle')}</h3>
                    <p>{t('shell.agents.workflowsHint')}</p>
                  </div>
                  {all.length === 0 ? (
                    <p className="agents-lib-empty">
                      {t('shell.agents.workflowsEmpty')}{' '}
                      <button type="button" className="btn ghost" onClick={onOpenWorkflows}>
                        {t('shell.agents.action')}
                      </button>
                    </p>
                  ) : (
                    <ul className="agents-grid" aria-label={t('shell.agents.gridLabel')}>
                      {shown.map(card)}
                    </ul>
                  )}
                </section>
              ) : null}
            </>
          )}
        </>
      )}
      {editing ? (
        <AgentEditorDialog
          agent={editing.agent}
          library={library ?? []}
          onOpenDocuments={onOpenDocuments}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            read();
          }}
        />
      ) : null}
      {scheduling ? (
        <RoutineDialog
          agent={scheduling.agent}
          helperNames={libraryNames(library ?? [])}
          onClose={() => setScheduling(null)}
          onCreated={() => {
            setScheduling(null);
            read();
          }}
        />
      ) : null}
    </PageFrame>
  );
}
