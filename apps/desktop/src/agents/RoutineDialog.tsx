/// The dialog that puts one of the user's agents on a schedule: what to do each time, when (a time
/// of day, every few hours, a new file in a folder, a new post in a feed), where each result goes, and
/// whether to notify. Saving makes the routine with its schedule off, then shows what it will be
/// allowed to do when nobody is watching; approving turns it on. Cancelling there removes it again.
///
/// Escape is caught in the capture phase, like the other dialogs over a page.

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useFocusTrap } from '../shell/useFocusTrap';
import { useT } from '../i18n';
import {
  approveWorkflowPermissions,
  createRoutine,
  deleteWorkflow,
  listLibraryAgents,
  pickWorkspaceFolder,
  setWorkflowSchedule,
} from '../ipc/client';
import type { RoutineCreated, RoutineRequest, ScheduleSpec, WorkflowPermissionView } from '../ipc/contracts';
import { DEFAULT_TIME, INTERVAL_HOURS } from '../workflows/ScheduleSection';
import { permissionText, type HelperNames } from '../workflows/permissionText';
import { COMPUTER_TOOL, helperNames as namesIn } from '../workflows/editorModel';

/// When a routine runs: a time schedule, or a folder or feed trigger.
export type RoutineWhen = 'daily' | 'weekdays' | 'interval' | 'folder' | 'feed';

/// Most words, and characters, of a name made from the task.
const NAME_FROM_TASK_WORDS = 6;
const NAME_FROM_TASK_CHARS = 60;

/// A short name for the routine from its task: the first words of its first line, without
/// trailing punctuation.
export function nameFromTask(task: string): string {
  const line = task.trim().split('\n')[0]?.trim() ?? '';
  const words = line.split(/\s+/).filter(Boolean).slice(0, NAME_FROM_TASK_WORDS).join(' ');
  const short = words.length > NAME_FROM_TASK_CHARS ? words.slice(0, NAME_FROM_TASK_CHARS) : words;
  return short.replace(/[\s.,;:!?…-]+$/u, '');
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/// What the form sends for these choices.
export function routineRequest(form: {
  agentId: string;
  name: string;
  task: string;
  when: RoutineWhen;
  time: string;
  hours: number;
  folder: string;
  feedUrl: string;
  output: 'document' | 'file';
  notify: boolean;
}): RoutineRequest {
  const schedule: ScheduleSpec =
    form.when === 'daily' || form.when === 'weekdays'
      ? { kind: form.when, time: form.time }
      : form.when === 'interval'
        ? { kind: 'interval', hours: form.hours }
        : { kind: 'trigger' };
  const trigger =
    form.when === 'folder'
      ? ({ kind: 'folder' } as const)
      : form.when === 'feed'
        ? ({ kind: 'feed', url: form.feedUrl.trim(), everyMinutes: 30 } as const)
        : null;
  return {
    agentId: form.agentId,
    name: form.name.trim() || nameFromTask(form.task),
    task: form.task.trim(),
    schedule,
    trigger,
    notify: form.notify,
    output: form.output,
    folder: form.folder.trim() || null,
  };
}

const NO_NAMES: HelperNames = {};

export function RoutineDialog({
  agent,
  task: initialTask = '',
  helperNames = NO_NAMES,
  onClose,
  onCreated,
}: {
  /// The agent that does the work: its library id, name and tools (read from the library when not given).
  agent: { id: string; name: string; tools?: readonly string[] };
  /// The user's agents' names by id, for the helpers named in what it may do.
  helperNames?: HelperNames;
  /// The task to start from (a chat message it answered).
  task?: string;
  onClose: () => void;
  /// The routine is saved and on.
  onCreated: (workflowId: string) => void;
}) {
  const t = useT();
  const titleId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  useFocusTrap(formRef, true);
  // From chat the task is there already, and so is a short name for it.
  const [name, setName] = useState(() => nameFromTask(initialTask));
  const [task, setTask] = useState(initialTask);
  const [when, setWhen] = useState<RoutineWhen>('weekdays');
  const [time, setTime] = useState(DEFAULT_TIME);
  const [hours, setHours] = useState(4);
  const [folder, setFolder] = useState('');
  const [feedUrl, setFeedUrl] = useState('');
  const [output, setOutput] = useState<'document' | 'file'>('document');
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  /// Saved and waiting for the user to approve what it may do.
  const [created, setCreated] = useState<{ result: RoutineCreated; schedule: ScheduleSpec } | null>(null);
  /// The agent's tools: as given, else read from the library (a chat turn knows only its name).
  const [tools, setTools] = useState<readonly string[]>(agent.tools ?? []);
  const toolsGiven = agent.tools !== undefined;
  useEffect(() => {
    if (toolsGiven) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => listLibraryAgents())
      .then((list) => {
        const found = Array.isArray(list) ? list.find((a) => a.agent.id === agent.id) : undefined;
        if (!cancelled && found) setTools(found.agent.tools ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [agent.id, toolsGiven]);
  const usesComputer = tools.includes(COMPUTER_TOOL);
  const needsFolder = when === 'folder' || usesComputer;

  /// Close; a routine saved but not approved is removed again.
  const close = () => {
    if (created) void deleteWorkflow(created.result.workflow.id).catch(() => {});
    onClose();
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);

  const turnOn = async (id: string, schedule: ScheduleSpec) => {
    await setWorkflowSchedule(id, schedule, true);
    onCreated(id);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!task.trim()) {
      setProblems([t('shell.agents.routines.needTask')]);
      return;
    }
    if (needsFolder && !folder.trim()) {
      setProblems([t('shell.agents.routines.needFolder')]);
      return;
    }
    const request = routineRequest({ agentId: agent.id, name, task, when, time, hours, folder, feedUrl, output, notify });
    setBusy(true);
    setProblems([]);
    try {
      const result = await createRoutine(request);
      // Saved from here on: cancelling removes it again.
      setCreated({ result, schedule: request.schedule });
      if (result.permissions.missing.length === 0) await turnOn(result.workflow.id, request.schedule);
    } catch (e) {
      setProblems(errorText(e).split('\n').filter((line) => line.trim() !== ''));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!created || busy) return;
    setBusy(true);
    setProblems([]);
    try {
      await approveWorkflowPermissions(created.result.workflow.id);
      await turnOn(created.result.workflow.id, created.schedule);
    } catch (e) {
      setProblems([errorText(e)]);
      setBusy(false);
    }
  }

  const chooseFolder = async () => {
    try {
      const picked = await pickWorkspaceFolder();
      if (picked) setFolder(picked);
    } catch {
      setProblems([t('workspace.workflows.folder.pickFailed')]);
    }
  };

  const agentName = agent.name || agent.id;
  const required: WorkflowPermissionView[] = created?.result.permissions.required ?? [];
  // The routine's step goes by the agent's name ("Let Researcher: …"), its helpers by theirs.
  const approvalNames = created
    ? {
        ...helperNames,
        ...namesIn(created.result.workflow.definition ?? { steps: [] }, { ...helperNames, [agent.id]: agentName }),
      }
    : helperNames;

  return (
    <div
      className="consent-overlay app-inputs-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <form
        ref={formRef}
        className="app-inputs-dialog routine-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => {
          e.preventDefault();
          void (created ? approve() : submit(e));
        }}
      >
        <header className="agent-editor-head">
          <h2 id={titleId}>{t('shell.agents.routines.dialogTitle', { name: agentName })}</h2>
        </header>

        {created ? (
          <div className="routine-dialog-body" role="group" aria-label={t('workspace.workflows.permissions.approveTitle')}>
            <b>{t('workspace.workflows.permissions.approveTitle')}</b>
            <p className="wf-muted">{t('workspace.workflows.permissions.approveBody')}</p>
            <ul className="wf-permission-list">
              {required.map((p) => (
                <li key={JSON.stringify(p)}>{permissionText(p, t, approvalNames)}</li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="routine-dialog-body">
            <label className="app-field">
              <span className="app-field-label">{t('shell.agents.routines.task')}</span>
              <textarea
                className="mem-input"
                rows={4}
                autoFocus
                placeholder={t('shell.agents.routines.taskPlaceholder')}
                value={task}
                onChange={(e) => setTask(e.target.value)}
              />
            </label>
            <label className="app-field">
              <span className="app-field-label">{t('shell.agents.routines.name')}</span>
              <input
                type="text"
                placeholder={nameFromTask(task) || t('shell.agents.routines.namePlaceholder')}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="routine-when">
              <label className="wf-field">
                <span>{t('shell.agents.routines.when')}</span>
                <select className="sel" value={when} onChange={(e) => setWhen(e.target.value as RoutineWhen)}>
                  <option value="daily">{t('workspace.workflows.schedule.daily')}</option>
                  <option value="weekdays">{t('workspace.workflows.schedule.weekdays')}</option>
                  <option value="interval">{t('workspace.workflows.schedule.interval')}</option>
                  <option value="folder">{t('shell.agents.routines.whenFolder')}</option>
                  <option value="feed">{t('shell.agents.routines.whenFeed')}</option>
                </select>
              </label>
              {when === 'daily' || when === 'weekdays' ? (
                <label className="wf-field">
                  <span>{t('workspace.workflows.schedule.at')}</span>
                  <input
                    className="mem-input"
                    type="time"
                    value={time}
                    onChange={(e) => {
                      if (e.target.value) setTime(e.target.value);
                    }}
                  />
                </label>
              ) : null}
              {when === 'interval' ? (
                <label className="wf-field">
                  <span>{t('workspace.workflows.schedule.every')}</span>
                  <select className="sel" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
                    {INTERVAL_HOURS.map((h) => (
                      <option key={h} value={h}>
                        {t('workspace.workflows.schedule.hours', { count: h })}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>
            {when === 'feed' ? (
              <label className="app-field">
                <span className="app-field-label">{t('shell.agents.routines.feedUrl')}</span>
                <input
                  type="url"
                  value={feedUrl}
                  onChange={(e) => setFeedUrl(e.target.value)}
                />
              </label>
            ) : null}
            {needsFolder ? (
              <div className="app-field routine-folder">
                <span className="app-field-label">{t('workspace.workflows.folder.label')}</span>
                <span className="routine-folder-row">
                  {folder ? <code className="wfe-path">{folder}</code> : <span className="wf-muted">{t('workspace.workflows.folder.none')}</span>}
                  <button type="button" className="btn ghost" onClick={() => void chooseFolder()}>
                    {folder ? t('workspace.workflows.folder.change') : t('workspace.workflows.folder.choose')}
                  </button>
                </span>
                <span className="wf-muted">
                  {when === 'folder' ? t('shell.agents.routines.folderWatchHint') : t('shell.agents.routines.folderComputerHint')}
                </span>
              </div>
            ) : null}
            <fieldset className="wf-tools routine-output">
              <legend>{t('shell.agents.routines.output')}</legend>
              <label className="wf-check">
                <input type="radio" name={`${titleId}-output`} checked={output === 'document'} onChange={() => setOutput('document')} />
                {t('shell.agents.routines.outputDocument')}
              </label>
              <label className="wf-check">
                <input type="radio" name={`${titleId}-output`} checked={output === 'file'} onChange={() => setOutput('file')} />
                {t('shell.agents.routines.outputFile')}
              </label>
              <label className="wf-check">
                <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
                {t('shell.agents.routines.notify')}
              </label>
            </fieldset>
          </div>
        )}

        <footer className="agent-editor-foot">
          {problems.length > 0 ? (
            <ul className="agent-editor-problems" role="alert">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : null}
          <div className="app-details-actions">
            <button type="button" className="btn ghost" onClick={close}>
              {t('common.actions.cancel')}
            </button>
            <button type="submit" className="btn primary" disabled={busy}>
              {created ? t('workspace.workflows.permissions.approveAndTurnOn') : t('common.actions.save')}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
