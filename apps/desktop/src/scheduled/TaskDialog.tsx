/// The "New task" / "Edit task" dialog: a name, the instructions, who does them (the assistant or one
/// of the user's agents) and with which model, when it runs, and, under Advanced, where each result
/// goes, whether to notify and which folder it may work in. Saving makes (or rewrites) the routine
/// with its schedule off, then shows what it will be allowed to do when nobody is watching; approving
/// turns it on. Cancelling that step removes a new task again (an edited one stays, switched off).
///
/// Escape is caught in the capture phase, like the other dialogs over a page.

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useFocusTrap } from '../shell/useFocusTrap';
import { useT } from '../i18n';
import { deleteWorkflow, listLibraryAgents, pickWorkspaceFolder } from '../ipc/client';
import type { LibraryAgent, RoutineCreated, RoutineOutput, ScheduleSpec, WorkflowPermissionView } from '../ipc/contracts';
import { ProviderModelsProvider, WorkflowModelRow } from '../workflows/WorkflowModelRow';
import { permissionText, type HelperNames } from '../workflows/permissionText';
import { COMPUTER_TOOL, helperNames as namesIn } from '../workflows/editorModel';
import { WhenFields } from './WhenFields';
import { localDateTime } from './schedule';
import { emptyDraft, nameFromTask, taskRequest, type TaskDraft } from './taskForm';
import { approveAndTurnOn, needsApproval, saveTask, turnOnTask } from './taskFlow';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const NO_NAMES: HelperNames = {};

export function TaskDialog({
  draft: initial,
  editing = null,
  helperNames = NO_NAMES,
  onClose,
  onSaved,
  onSetUpInChat,
}: {
  /// What the fields start as (a template, or the task being edited); a blank task when left out.
  draft?: TaskDraft;
  /// The workflow being edited: saving rewrites it instead of making a new one.
  editing?: string | null;
  /// The user's agents' names by id, for the helpers named in what the task may do.
  helperNames?: HelperNames;
  onClose: () => void;
  /// The task is saved and on.
  onSaved: (workflowId: string) => void;
  /// Leave the form and set the task up in a chat instead; the link is left out without it.
  onSetUpInChat?: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const advancedId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  useFocusTrap(formRef, true);
  const [form, setForm] = useState<TaskDraft>(() => initial ?? emptyDraft());
  const patch = (next: Partial<TaskDraft>) => setForm((current) => ({ ...current, ...next }));
  const [advanced, setAdvanced] = useState(false);
  const [agents, setAgents] = useState<LibraryAgent[]>([]);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  /// Saved and waiting for the user to approve what it may do.
  const [created, setCreated] = useState<{ result: RoutineCreated; schedule: ScheduleSpec } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => listLibraryAgents())
      .then((list) => {
        if (!cancelled && Array.isArray(list)) setAgents(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const agent = agents.find((a) => a.agent.id === form.agentId);
  const usesComputer = agent?.agent.tools?.includes(COMPUTER_TOOL) ?? false;
  const needsFolder = form.when === 'folder' || usesComputer;
  const agentName = agent?.agent.name || form.agentId;

  /// Close; a new task saved but not approved is removed again.
  const close = () => {
    if (created && !editing) void deleteWorkflow(created.result.workflow.id).catch(() => {});
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
    await turnOnTask(id, schedule);
    onSaved(id);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!form.task.trim()) {
      setProblems([t('shell.scheduled.dialog.needTask')]);
      return;
    }
    if (needsFolder && !form.folder.trim()) {
      setProblems([t('shell.agents.routines.needFolder')]);
      return;
    }
    if (form.when === 'once' && form.spec.kind === 'once' && form.spec.at <= localDateTime(new Date())) {
      setProblems([t('shell.scheduled.dialog.needFuture')]);
      return;
    }
    const request = taskRequest(form);
    setBusy(true);
    setProblems([]);
    try {
      const result = await saveTask(request, editing);
      // Saved from here on: cancelling removes a new task again.
      setCreated({ result, schedule: request.schedule });
      if (!needsApproval(result)) await turnOn(result.workflow.id, request.schedule);
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
      await approveAndTurnOn(created.result.workflow.id, created.schedule);
      onSaved(created.result.workflow.id);
    } catch (e) {
      setProblems([errorText(e)]);
      setBusy(false);
    }
  }

  const chooseFolder = async () => {
    try {
      const picked = await pickWorkspaceFolder();
      if (picked) patch({ folder: picked });
    } catch {
      setProblems([t('workspace.workflows.folder.pickFailed')]);
    }
  };

  const required: WorkflowPermissionView[] = created?.result.permissions.required ?? [];
  // The step goes by the agent's name ("Let Researcher: …"), its helpers by theirs.
  const approvalNames = created
    ? {
        ...helperNames,
        ...namesIn(created.result.workflow.definition ?? { steps: [] }, {
          ...helperNames,
          ...(form.agentId ? { [form.agentId]: agentName } : {}),
        }),
      }
    : helperNames;

  const folderBlock = (
    <div className="app-field routine-folder">
      <span className="app-field-label">{t('workspace.workflows.folder.label')}</span>
      <span className="routine-folder-row">
        {form.folder ? (
          <code className="wfe-path">{form.folder}</code>
        ) : (
          <span className="wf-muted">{t('workspace.workflows.folder.none')}</span>
        )}
        <button type="button" className="btn ghost" onClick={() => void chooseFolder()}>
          {form.folder ? t('workspace.workflows.folder.change') : t('workspace.workflows.folder.choose')}
        </button>
      </span>
      <span className="wf-muted">
        {form.when === 'folder'
          ? t('shell.agents.routines.folderWatchHint')
          : usesComputer
            ? t('shell.agents.routines.folderComputerHint')
            : t('shell.scheduled.dialog.folderHint')}
      </span>
    </div>
  );

  const outputs: readonly [RoutineOutput, string][] = [
    ['chat', t('shell.scheduled.dialog.outputChat')],
    ['document', t('shell.agents.routines.outputDocument')],
    ['file', t('shell.agents.routines.outputFile')],
  ];

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
        className="app-inputs-dialog routine-dialog sched-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => {
          e.preventDefault();
          void (created ? approve() : submit(e));
        }}
      >
        <header className="agent-editor-head">
          <h2 id={titleId}>{editing ? t('shell.scheduled.dialog.editTitle') : t('shell.scheduled.dialog.newTitle')}</h2>
          {onSetUpInChat && !editing && !created ? (
            <button type="button" className="sched-chat-open" onClick={onSetUpInChat}>
              {t('shell.scheduled.dialog.setUpInChat')}
            </button>
          ) : null}
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
              <span className="app-field-label">{t('shell.agents.routines.name')}</span>
              <input
                type="text"
                autoFocus
                placeholder={nameFromTask(form.task) || t('shell.agents.routines.namePlaceholder')}
                value={form.name}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </label>
            <div className="app-field sched-instructions">
              <label className="app-field-label" htmlFor={`${titleId}-task`}>
                {t('shell.scheduled.dialog.instructions')}
              </label>
              <textarea
                id={`${titleId}-task`}
                className="mem-input"
                rows={5}
                placeholder={t('shell.agents.routines.taskPlaceholder')}
                value={form.task}
                onChange={(e) => patch({ task: e.target.value })}
              />
              <div className="sched-bar">
                <label className="wf-field sched-bar-agent">
                  <span>{t('shell.scheduled.dialog.agent')}</span>
                  <select
                    className="sel"
                    value={form.agentId}
                    onChange={(e) => patch({ agentId: e.target.value })}
                  >
                    <option value="">{t('shell.scheduled.dialog.assistant')}</option>
                    {agents.map((a) => (
                      <option key={a.agent.id} value={a.agent.id}>
                        {a.agent.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="sched-bar-model">
                  <ProviderModelsProvider>
                    <WorkflowModelRow
                      kind="step"
                      idPrefix={`${titleId}-model`}
                      label={t('shell.scheduled.dialog.model')}
                      followLabel={t('shell.scheduled.dialog.defaultModel')}
                      model={form.model ?? undefined}
                      onChange={(model) => patch({ model })}
                    />
                  </ProviderModelsProvider>
                </div>
              </div>
            </div>
            <p className="sched-note" role="note">
              {t('shell.scheduled.dialog.note')}
            </p>
            <WhenFields
              kind={form.when}
              spec={form.spec}
              triggers
              onKind={(when) => patch({ when })}
              onSpec={(spec) => patch({ spec })}
            />
            {form.when === 'feed' ? (
              <label className="app-field">
                <span className="app-field-label">{t('shell.agents.routines.feedUrl')}</span>
                <input type="url" value={form.feedUrl} onChange={(e) => patch({ feedUrl: e.target.value })} />
              </label>
            ) : null}
            {needsFolder ? folderBlock : null}
            <div className="sched-advanced">
              <button
                type="button"
                className="sched-advanced-toggle"
                aria-expanded={advanced}
                aria-controls={advancedId}
                onClick={() => setAdvanced((open) => !open)}
              >
                {t('shell.scheduled.dialog.advanced')}
              </button>
              {advanced ? (
                <div id={advancedId} className="sched-advanced-body">
                  <fieldset className="wf-tools routine-output">
                    <legend>{t('shell.scheduled.dialog.resultGoesTo')}</legend>
                    {outputs.map(([value, label]) => (
                      <label key={value} className="wf-check">
                        <input
                          type="radio"
                          name={`${titleId}-output`}
                          checked={form.output === value}
                          onChange={() => patch({ output: value })}
                        />
                        {label}
                      </label>
                    ))}
                    <label className="wf-check">
                      <input type="checkbox" checked={form.notify} onChange={(e) => patch({ notify: e.target.checked })} />
                      {t('shell.agents.routines.notify')}
                    </label>
                  </fieldset>
                  {needsFolder ? null : folderBlock}
                </div>
              ) : null}
            </div>
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
              {created
                ? t('workspace.workflows.permissions.approveAndTurnOn')
                : editing
                  ? t('common.actions.save')
                  : t('shell.scheduled.dialog.create')}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}
