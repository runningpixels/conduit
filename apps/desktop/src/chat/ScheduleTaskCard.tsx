/// The confirm card for the chat tool `schedule_task`. The assistant drafts a task; nothing is
/// created until the user presses Create. Create does what the task dialog does (save with the
/// schedule off, show what the task may do when nobody watches, approve, turn on); "Edit in form"
/// opens the dialog with the draft filled in; Cancel creates nothing. Whatever happens is sent back
/// as the tool's result (`submitAskUser`, the same way an `ask_user` form answers), in words the
/// model can repeat. A draft that does not check out is sent back at once as an error to fix.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { deleteWorkflow, submitAskUser } from '../ipc/client';
import type { RoutineCreated } from '../ipc/contracts';
import { describeSchedule } from '../scheduled/schedule';
import { parseScheduleTaskJson, proposalDraft, proposalRequest } from '../scheduled/scheduleTask';
import { TaskDialog } from '../scheduled/TaskDialog';
import { approveAndTurnOn, needsApproval, saveTask, turnOnTask } from '../scheduled/taskFlow';
import { helperNames as namesIn } from '../workflows/editorModel';
import { permissionText } from '../workflows/permissionText';
import { formatNextRun } from '../workflows/ScheduleSection';

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/// Saved, and waiting for the user to approve what it may do.
interface Awaiting {
  saved: RoutineCreated;
}

export function ScheduleTaskCard({
  toolCallId,
  argumentsJson,
  onDone,
}: {
  toolCallId: string;
  /// The model's arguments to `schedule_task`, as JSON.
  argumentsJson: string;
  onDone?: () => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const parsed = useMemo(() => parseScheduleTaskJson(argumentsJson), [argumentsJson]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [awaiting, setAwaiting] = useState<Awaiting | null>(null);
  const [form, setForm] = useState(false);
  const answered = useRef(false);

  /// Tell the model what came of it (once).
  const answer = async (ok: boolean, result: string) => {
    if (answered.current) return;
    answered.current = true;
    setBusy(true);
    try {
      await submitAskUser(toolCallId, { ok, result });
      onDone?.();
    } catch (e) {
      // The turn is gone (stopped, or the window reloaded): nothing is waiting for the answer.
      setProblem(errorText(e));
      setBusy(false);
    }
  };

  // A draft with a bad time, an unknown day or a past date is sent straight back to be fixed.
  useEffect(() => {
    if (!parsed.ok) void answer(false, `The task was not created. ${parsed.error}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!parsed.ok) {
    return (
      <div className="ask-user sched-card" role="status">
        <p className="ask-user-title">
          <b>{t('chat.scheduleTask.invalid')}</b>
        </p>
      </div>
    );
  }

  const { proposal } = parsed;
  const whenText = describeSchedule(proposal.schedule, null, t, fmt.locale);
  const modelText = proposal.model ? `${proposal.model.provider} / ${proposal.model.model}` : t('shell.scheduled.dialog.defaultModel');
  const taskLabel = `"${proposal.name}" (${whenText})`;

  const created = (nextRunAt: string | null | undefined) =>
    `Created ${taskLabel} and turned it on.${nextRunAt ? ` It runs next ${formatNextRun(nextRunAt, fmt.locale)}.` : ''} Each run arrives as a new chat.`;

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    let saved: RoutineCreated;
    try {
      saved = await saveTask(proposalRequest(proposal));
    } catch (e) {
      setBusy(false);
      await answer(false, `The task was not created: ${errorText(e)}`);
      return;
    }
    try {
      if (needsApproval(saved)) {
        setAwaiting({ saved });
        setBusy(false);
        return;
      }
      const schedule = await turnOnTask(saved.workflow.id, proposal.schedule);
      await answer(true, created(schedule?.nextRunAt));
    } catch (e) {
      void deleteWorkflow(saved.workflow.id).catch(() => {});
      setBusy(false);
      await answer(false, `The task was not created: ${errorText(e)}`);
    }
  };

  const approve = async () => {
    if (!awaiting || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const schedule = await approveAndTurnOn(awaiting.saved.workflow.id, proposal.schedule);
      await answer(true, created(schedule?.nextRunAt));
    } catch (e) {
      setProblem(errorText(e));
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (busy) return;
    if (awaiting) {
      // Saved but not approved: take it away again, as the dialog does.
      void deleteWorkflow(awaiting.saved.workflow.id).catch(() => {});
      await answer(true, 'The user did not approve what the task may do, so it was not created.');
      return;
    }
    await answer(true, 'The user cancelled; no task was created.');
  };

  if (form) {
    return (
      <TaskDialog
        draft={proposalDraft(proposal)}
        onClose={() => {
          setForm(false);
          void answer(true, 'The user opened the task form and closed it without saving; no task was created.');
        }}
        onSaved={(id) => {
          setForm(false);
          void answer(true, `The user finished setting the task up in the form (it may differ from your draft): it was created and turned on. Its id is ${id}.`);
        }}
      />
    );
  }

  const required = awaiting?.saved.permissions.required ?? [];
  const names = awaiting ? namesIn(awaiting.saved.workflow.definition ?? { steps: [] }, {}) : {};

  return (
    <div className="ask-user sched-card" role="form" aria-label={t('chat.scheduleTask.heading')}>
      <p className="ask-user-title">
        <b>{t('chat.scheduleTask.heading')}</b>
      </p>
      <dl className="sched-card-fields">
        <dt>{t('shell.agents.routines.name')}</dt>
        <dd>{proposal.name}</dd>
        <dt>{t('shell.scheduled.dialog.instructions')}</dt>
        <dd className="sched-card-instructions">{proposal.instructions}</dd>
        <dt>{t('chat.scheduleTask.when')}</dt>
        <dd>{whenText}</dd>
        <dt>{t('shell.scheduled.dialog.model')}</dt>
        <dd>{modelText}</dd>
        {proposal.notify ? (
          <>
            <dt>{t('chat.scheduleTask.notify')}</dt>
            <dd>{t('shell.agents.routines.notify')}</dd>
          </>
        ) : null}
      </dl>
      {awaiting ? (
        <div role="group" aria-label={t('workspace.workflows.permissions.approveTitle')}>
          <p>
            <b>{t('workspace.workflows.permissions.approveTitle')}</b>
          </p>
          <p className="wf-muted">{t('workspace.workflows.permissions.approveBody')}</p>
          <ul className="wf-permission-list">
            {required.map((p) => (
              <li key={JSON.stringify(p)}>{permissionText(p, t, names)}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="sched-note" role="note">
          {t('shell.scheduled.dialog.note')}
        </p>
      )}
      {problem ? (
        <p className="error-text" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="row">
        {awaiting ? (
          <button className="btn primary" type="button" disabled={busy} onClick={() => void approve()}>
            {t('workspace.workflows.permissions.approveAndTurnOn')}
          </button>
        ) : (
          <button className="btn primary" type="button" disabled={busy} onClick={() => void create()}>
            {t('shell.scheduled.dialog.create')}
          </button>
        )}
        {awaiting ? null : (
          <button className="btn ghost" type="button" disabled={busy} onClick={() => setForm(true)}>
            {t('chat.scheduleTask.editInForm')}
          </button>
        )}
        <button className="btn ghost" type="button" disabled={busy} onClick={() => void cancel()}>
          {t('common.actions.cancel')}
        </button>
      </div>
    </div>
  );
}
