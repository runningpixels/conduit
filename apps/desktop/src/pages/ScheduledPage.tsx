/// Scheduled tasks: one place for everything that runs on its own (tasks, an agent's routines and
/// scheduled workflows) and a gallery of templates to start from. "Yours" lists each with when it
/// runs, its next run, how the last one went and what it can do (run now, pause, edit, delete);
/// "Templates" opens the New task dialog filled in. With nothing scheduled yet, Yours shows the
/// empty state and the templates below it.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { deleteWorkflow, getWorkflow, listScheduled, runWorkflow, setWorkflowSchedule } from '../ipc/client';
import type { ScheduledItem } from '../ipc/contracts';
import { AgentsIcon, ClockIcon, WorkflowIcon } from '../icons';
import { TaskDialog } from '../scheduled/TaskDialog';
import { describeSchedule } from '../scheduled/schedule';
import { draftFromTask, emptyDraft, type TaskDraft } from '../scheduled/taskForm';
import { TEMPLATES, draftFromTemplate, templateText, type TaskTemplate } from '../scheduled/templates';
import { PageFrame } from '../shell/PageFrame';
import { formatNextRun } from '../workflows/ScheduleSection';
import { Menu } from '../workspace/Menu';

/// How often the list is read while the page is shown.
export const SCHEDULED_REFRESH_MS = 5000;

type Tab = 'yours' | 'templates';
type Filter = 'all' | 'task' | 'routine' | 'workflow';
type Sort = 'next' | 'name' | 'recent';

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

const KIND_ICON: Record<ScheduledItem['kind'], ReactNode> = {
  task: <ClockIcon />,
  routine: <AgentsIcon />,
  workflow: <WorkflowIcon />,
};

export function ScheduledPage({
  onOpenWorkflow,
  onOpenConversation,
  onSetUpInChat,
  onRunDone,
  refreshKey,
}: {
  /// Open a workflow in the Workflows page, on this run's results when one is given.
  onOpenWorkflow: (workflowId: string, runId?: string) => void;
  /// Open the chat a run saved.
  onOpenConversation: (conversationId: string) => void;
  /// Open a new chat and send it `message`, which asks the assistant to set a task up. Without it, New task is just the form.
  onSetUpInChat?: (message: string) => void;
  /// After "Run now" ends: the run may have saved a chat the history should show.
  onRunDone?: () => void;
  /// Changes when a run starts or ends elsewhere; the page re-reads.
  refreshKey?: number;
}) {
  const t = useT();
  const fmt = useFormatters();
  const [items, setItems] = useState<ScheduledItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tab, setTab] = useState<Tab>('yours');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('next');
  /// The task dialog: `editing` is the workflow being edited, null for a new task.
  const [dialog, setDialog] = useState<{ draft: TaskDraft; editing: string | null } | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  /// Tasks whose "Run now" is still going.
  const [running, setRunning] = useState<ReadonlySet<string>>(new Set());
  const stopped = useRef(false);
  const newButton = useRef<HTMLButtonElement>(null);
  const [newMenu, setNewMenu] = useState(false);

  const read = useCallback(() => {
    return Promise.resolve()
      .then(() => listScheduled())
      .then((list) => {
        if (stopped.current) return;
        setItems(Array.isArray(list) ? list : []);
        setFailed(false);
      })
      .catch(() => {
        if (stopped.current) return;
        setItems((current) => current ?? []);
        setFailed(true);
      });
  }, []);

  useEffect(() => {
    stopped.current = false;
    void read();
    const timer = window.setInterval(() => void read(), SCHEDULED_REFRESH_MS);
    return () => {
      stopped.current = true;
      window.clearInterval(timer);
    };
  }, [read, refreshKey]);

  const failedAction = (e: unknown) => setActionError(errorText(e));

  const setOn = (item: ScheduledItem, on: boolean) => {
    if (!item.schedule) return;
    setActionError(null);
    setWorkflowSchedule(item.workflowId, item.schedule, on).then(() => read()).catch(failedAction);
  };

  const runNow = (item: ScheduledItem) => {
    setActionError(null);
    setRunning((current) => new Set(current).add(item.workflowId));
    runWorkflow(item.workflowId, {})
      .catch(failedAction)
      .finally(() => {
        setRunning((current) => {
          const next = new Set(current);
          next.delete(item.workflowId);
          return next;
        });
        void read();
        onRunDone?.();
      });
  };

  const remove = (item: ScheduledItem) => {
    if (!window.confirm(t('shell.scheduled.deleteConfirm', { name: item.name }))) return;
    setActionError(null);
    deleteWorkflow(item.workflowId).then(() => read()).catch(failedAction);
  };

  const edit = async (item: ScheduledItem) => {
    if (item.kind === 'workflow') {
      onOpenWorkflow(item.workflowId);
      return;
    }
    setActionError(null);
    const record = await Promise.resolve()
      .then(() => getWorkflow(item.workflowId))
      .catch(() => null);
    setDialog({ draft: draftFromTask(item, record), editing: item.workflowId });
  };

  const openResult = (item: ScheduledItem) => {
    if (item.lastConversationId) onOpenConversation(item.lastConversationId);
    else onOpenWorkflow(item.workflowId, item.lastRunId ?? undefined);
  };

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (items ?? []).filter(
      (i) =>
        (filter === 'all' || i.kind === filter) &&
        (needle === '' || i.name.toLowerCase().includes(needle) || (i.task ?? '').toLowerCase().includes(needle)),
    );
    const when = (i: ScheduledItem) => (i.enabled && i.nextRunAt ? i.nextRunAt : null);
    return [...matches].sort((a, b) => {
      if (sort === 'name') return fmt.compare(a.name, b.name);
      if (sort === 'recent') return (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? '') || fmt.compare(a.name, b.name);
      const [x, y] = [when(a), when(b)];
      if (x && y) return x.localeCompare(y);
      if (x) return -1;
      if (y) return 1;
      return fmt.compare(a.name, b.name);
    });
  }, [items, query, filter, sort, fmt]);

  const startManual = () => setDialog({ draft: emptyDraft(), editing: null });
  const setUpInChat = onSetUpInChat ? () => onSetUpInChat(t('shell.scheduled.setUpInChatPrompt')) : undefined;
  const startTemplate = (template: TaskTemplate) => setDialog({ draft: draftFromTemplate(template, t), editing: null });

  const whenText = (item: ScheduledItem) => describeSchedule(item.schedule, item.trigger, t, fmt.locale);

  /// "next Tue, Sep 29, 8:00 AM", "on", "paused" or "done" (a one-time task that ran).
  const stateText = (item: ScheduledItem) => {
    if (!item.enabled) {
      return item.schedule?.kind === 'once' && item.lastRunAt ? t('shell.scheduled.done') : t('shell.agents.routines.paused');
    }
    return item.nextRunAt
      ? t('shell.agents.routines.next', { when: formatNextRun(item.nextRunAt, fmt.locale) })
      : t('shell.agents.routines.on');
  };

  const lastText = (item: ScheduledItem): string | null => {
    if (!item.lastRunAt) return null;
    const when = fmt.timeAgo(item.lastRunAt);
    if (item.lastRunStatus === 'failed') return t('shell.agents.routines.lastFailed', { when });
    return item.lastResultTitle
      ? t('shell.agents.routines.lastResult', { title: item.lastResultTitle, when })
      : t('shell.agents.routines.lastRun', { when });
  };

  const row = (item: ScheduledItem) => {
    const last = lastText(item);
    const canOpen = item.lastConversationId != null || item.lastArtifactId != null;
    const busy = running.has(item.workflowId);
    const canToggle = item.schedule != null;
    return (
      <li key={item.workflowId} className="sched-row" data-kind={item.kind}>
        <span className="sched-icon" aria-hidden="true">
          {KIND_ICON[item.kind]}
        </span>
        <span className="sched-text">
          <span className="sched-name">
            {item.name}
            <span className="sched-kind">{t(`shell.scheduled.kind.${item.kind}`)}</span>
          </span>
          <span className="sched-when-text">
            {whenText(item)} · {stateText(item)}
          </span>
          {last ? (
            <span className={item.lastRunStatus === 'failed' ? 'sched-last is-bad' : 'sched-last'}>{last}</span>
          ) : null}
        </span>
        <span className="sched-actions">
          {canOpen ? (
            <button
              type="button"
              className="btn ghost"
              aria-label={t('shell.scheduled.openResultLabel', { name: item.name })}
              onClick={() => openResult(item)}
            >
              {t('shell.scheduled.openResult')}
            </button>
          ) : null}
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            aria-label={t('shell.scheduled.runNowLabel', { name: item.name })}
            onClick={() => runNow(item)}
          >
            {busy ? t('shell.scheduled.running') : t('shell.scheduled.runNow')}
          </button>
          {canToggle ? (
            <button
              type="button"
              className="btn ghost"
              aria-label={
                item.enabled
                  ? t('shell.agents.routines.pauseLabel', { name: item.name })
                  : t('shell.agents.routines.resumeLabel', { name: item.name })
              }
              onClick={() => setOn(item, !item.enabled)}
            >
              {item.enabled ? t('shell.agents.routines.pause') : t('shell.agents.routines.resume')}
            </button>
          ) : null}
          <button
            type="button"
            className="btn ghost"
            aria-label={t('shell.scheduled.editLabel', { name: item.name })}
            onClick={() => void edit(item)}
          >
            {t('common.actions.edit')}
          </button>
          <button
            type="button"
            className="btn ghost"
            aria-label={t('shell.scheduled.deleteLabel', { name: item.name })}
            onClick={() => remove(item)}
          >
            {t('common.actions.delete')}
          </button>
        </span>
      </li>
    );
  };

  const templateGrid = (
    <ul className="sched-templates" aria-label={t('shell.scheduled.tab.templates')}>
      {TEMPLATES.map((template) => {
        const text = templateText(template.id, t);
        const clock =
          'folder' in template.when
            ? t('shell.agents.routines.onFolder')
            : describeSchedule(template.when.spec, null, t, fmt.locale);
        return (
          <li key={template.id}>
            <button type="button" className="sched-template" onClick={() => startTemplate(template)}>
              <span className="sched-template-tile" aria-hidden="true">
                <template.Icon />
              </span>
              <span className="sched-template-text">
                <span className="sched-template-name">{text.name}</span>
                <span className="sched-template-desc">{text.description}</span>
                <span className="sched-template-when">
                  <ClockIcon aria-hidden="true" />
                  {clock}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  const empty = items !== null && items.length === 0;

  const yours =
    items === null ? (
      <p className="wf-muted">{t('shell.agents.loading')}</p>
    ) : empty ? (
      <div className="sched-empty">
        <span className="sched-empty-art" aria-hidden="true">
          <ClockIcon />
        </span>
        <p className="sched-empty-title">{t('shell.scheduled.empty')}</p>
        <button type="button" className="btn" onClick={startManual}>
          {t('shell.scheduled.setUpManually')}
        </button>
        <hr className="sched-divider" />
        {templateGrid}
      </div>
    ) : (
      <>
        <div className="sched-bar-tools">
          <input
            type="search"
            className="apps-home-search sched-search"
            aria-label={t('shell.scheduled.search')}
            placeholder={t('shell.scheduled.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="wf-field sched-tool">
            <span>{t('shell.scheduled.filter.label')}</span>
            <select className="sel" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
              <option value="all">{t('shell.scheduled.filter.all')}</option>
              <option value="task">{t('shell.scheduled.filter.task')}</option>
              <option value="routine">{t('shell.scheduled.filter.routine')}</option>
              <option value="workflow">{t('shell.scheduled.filter.workflow')}</option>
            </select>
          </label>
          <label className="wf-field sched-tool">
            <span>{t('shell.scheduled.sort.label')}</span>
            <select className="sel" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
              <option value="next">{t('shell.scheduled.sort.next')}</option>
              <option value="name">{t('shell.scheduled.sort.name')}</option>
              <option value="recent">{t('shell.scheduled.sort.recent')}</option>
            </select>
          </label>
        </div>
        {shown.length === 0 ? (
          <p className="apps-home-nomatch">{t('shell.scheduled.noMatch')}</p>
        ) : (
          <ul className="sched-list" aria-label={t('shell.scheduled.tab.yours')}>
            {shown.map(row)}
          </ul>
        )}
      </>
    );

  return (
    <PageFrame
      title={t('shell.scheduled.title')}
      destination="scheduled"
      className="scheduled-page"
      actions={
        setUpInChat ? (
          <span className="sched-new">
            <button
              ref={newButton}
              type="button"
              className="btn primary"
              aria-haspopup="menu"
              aria-expanded={newMenu}
              onClick={() => setNewMenu((open) => !open)}
            >
              {t('shell.scheduled.newTask')}
              <span aria-hidden="true"> ▾</span>
            </button>
            <Menu
              open={newMenu}
              onClose={() => setNewMenu(false)}
              triggerRef={newButton}
              className="menu sched-new-menu"
              label={t('shell.scheduled.newTask')}
              dismissOnOutsidePress
            >
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setNewMenu(false);
                  startManual();
                }}
              >
                {t('shell.scheduled.newTask')}
              </button>
              <button
                type="button"
                role="menuitem"
                className="menu-item"
                onClick={() => {
                  setNewMenu(false);
                  setUpInChat();
                }}
              >
                {t('shell.scheduled.setUpInChat')}
              </button>
            </Menu>
          </span>
        ) : (
          <button type="button" className="btn primary" onClick={startManual}>
            {t('shell.scheduled.newTask')}
          </button>
        )
      }
    >
      <div className="sched-tabs" role="tablist" aria-label={t('shell.scheduled.title')}>
        {(['yours', 'templates'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`sched-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="sched-panel"
            className="sched-tab"
            onClick={() => setTab(id)}
          >
            {t(`shell.scheduled.tab.${id}`)}
          </button>
        ))}
      </div>
      {failed ? <p className="wf-error">{t('shell.scheduled.loadFailed')}</p> : null}
      {actionError ? (
        <p className="wf-error" role="alert">
          {actionError}
        </p>
      ) : null}
      <div id="sched-panel" role="tabpanel" aria-labelledby={`sched-tab-${tab}`}>
        {tab === 'yours' ? yours : templateGrid}
      </div>
      {dialog ? (
        <TaskDialog
          draft={dialog.draft}
          editing={dialog.editing}
          onClose={() => setDialog(null)}
          onSetUpInChat={
            setUpInChat
              ? () => {
                  setDialog(null);
                  setUpInChat();
                }
              : undefined
          }
          onSaved={() => {
            setDialog(null);
            setTab('yours');
            void read();
          }}
        />
      ) : null}
    </PageFrame>
  );
}
