/// The approval card for a command or file change an agent wants to make on
/// this computer. It leads with what the agent says it is for, then the exact
/// command (as a terminal line) or file change, and one chip saying why it asks.
/// The user can run it, run it and allow its rule, edit it, or refuse. A risky
/// one makes "Don’t run" the main button. A command that already failed kept in
/// the folder (`request.outside`) offers only "Run once outside the folder" or
/// "Don’t run": no editing, no rule.

import { useEffect, useId, useRef, useState } from 'react';
import { useT, type Translate } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { answerWorkflowAction, getWorkflowRun } from '../ipc/client';
import type { ComputerRecord, ComputerRequest, WorkflowAction } from '../ipc/contracts';
import { rejectionText } from './CommandRuleList';
import { FileDiff } from './FileDiff';
import { formatNextRun } from './ScheduleSection';
import { stepComputer } from './StepComputer';
import { translateComputerReason } from './computerReasons';
import '../styles/computer-card.css';

/// The folder and where inside it, as a path; just the folder for ".".
function whereText(request: ComputerRequest): string {
  const inner = request.path.trim();
  if (inner === '' || inner === '.') return request.folder;
  return `${request.folder.replace(/[\\/]+$/, '')}\\${inner}`;
}

function textArg(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/// The program's file name without a Windows executable extension.
function programName(program: string): string {
  const base = program.split(/[\\/]/).pop() || program;
  return base.replace(/\.(exe|cmd|bat)$/i, '');
}

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

function quoteArg(arg: string): string {
  return /\s/.test(arg) ? `"${arg}"` : arg;
}

/// Most earlier records shown in "So far in this run".
const SO_FAR_MAX = 4;

function soFarItem(r: ComputerRecord, t: Translate): string {
  const what = r.kind === 'command' ? [programName(r.program), ...r.args].join(' ').slice(0, 60) : r.path;
  const outcome = t(`workspace.workflows.computer.soFar.outcome.${r.outcome}`);
  let by = '';
  if (r.approvedBy === 'you') by = t('workspace.workflows.computer.soFar.by.you');
  else if (r.approvedBy.startsWith('rule:')) by = t('workspace.workflows.computer.soFar.by.rule');
  else if (r.approvedBy === "the workflow's edit mode") by = t('workspace.workflows.computer.soFar.by.editMode');
  else if (r.approvedBy) by = r.approvedBy;
  return by
    ? t('workspace.workflows.computer.soFar.item', { what, outcome, by })
    : t('workspace.workflows.computer.soFar.itemPlain', { what, outcome });
}

export function ComputerActionCard({
  action,
  request,
  onAnswered,
}: {
  action: WorkflowAction;
  request: ComputerRequest;
  onAnswered: (action: WorkflowAction, taken: boolean) => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const headingId = useId();
  const command = request.kind === 'run_command';
  // A command that failed kept in the folder: only "run this once outside" or not.
  const outside = command ? request.outside : undefined;
  const risky = Boolean(request.risky);
  const args = request.args ?? [];
  const offered = !action.sensitive && !risky && !outside && Boolean(request.suggestedRule);
  const [editing, setEditing] = useState(false);
  const [argsText, setArgsText] = useState('');
  const [contentText, setContentText] = useState('');
  const [remember, setRemember] = useState(false);
  const [rule, setRule] = useState(request.suggestedRule ?? '');
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [earlier, setEarlier] = useState<ComputerRecord[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    // What this step did so far comes with the request (a step's output is
    // saved only when it ends); finished steps' records are read from the run.
    // A failed lookup just leaves those out.
    const current = stepComputer({ computer: request.soFar ?? [] });
    setEarlier(current.slice(-SO_FAR_MAX));
    try {
      void Promise.resolve(getWorkflowRun(action.runId))
        .then((detail) => {
          if (!alive.current) return;
          setEarlier([...detail.steps.flatMap((step) => stepComputer(step.output)), ...current].slice(-SO_FAR_MAX));
        })
        .catch(() => {});
    } catch {
      /* no run to read */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch when the run or what this step did changes, not on every poll
  }, [action.runId, request.soFar?.length]);

  function startEditing() {
    setArgsText(args.join('\n'));
    setContentText(request.content ?? '');
    setEditing(true);
  }

  async function answer(send: boolean, edited?: Record<string, unknown>, rememberNow = false) {
    setSending(true);
    setRefused(null);
    const ruleText = rule.trim();
    try {
      const taken = await answerWorkflowAction(action.runId, action.stepId, {
        send,
        ...(edited ? { arguments: edited } : {}),
        ...(send && offered && (rememberNow || remember) && ruleText ? { remember: true, rule: ruleText } : {}),
      });
      onAnswered(action, taken);
    } catch (e) {
      if (alive.current) setRefused(t('workspace.workflows.action.failed', { error: rejectionText(e) }));
    } finally {
      if (alive.current) setSending(false);
    }
  }

  function sendEdited() {
    if (command) {
      const list = argsText.split('\n').filter((line) => line !== '');
      void answer(true, {
        program: request.program ?? textArg(action.arguments.program) ?? '',
        args: list,
        cwd: textArg(action.arguments.cwd) ?? request.path,
      });
    } else {
      void answer(true, { path: request.path, content: contentText });
    }
  }

  const titleKey = command ? 'workspace.workflows.computer.title.command' : 'workspace.workflows.computer.title.file';
  const reasonText = outside
    ? t(`workspace.workflows.computer.outside.cause.${outside.cause}`)
    : request.readBefore
      ? t('workspace.workflows.computer.readBeforeChip', { what: request.readBefore })
      : translateComputerReason(request.reason, t);
  const name = request.program ? programName(request.program) : '';
  const termLine = `${folderName(whereText(request))}> ${[name, ...args.map(quoteArg)].join(' ')}`;
  const runLabel = command ? t('workspace.workflows.computer.run') : t('workspace.workflows.computer.change');
  const runAnywayLabel = command
    ? t('workspace.workflows.computer.runAnyway')
    : t('workspace.workflows.computer.changeAnyway');
  const noLabel = command ? t('workspace.workflows.computer.dontRun') : t('workspace.workflows.computer.dontChange');
  const sofar = earlier.map((r) => soFarItem(r, t)).join(' · ');

  return (
    <section
      className={`wf-offer wf-review wf-action wf-computer${risky ? ' cc-risky' : ''}`}
      role="group"
      aria-labelledby={headingId}
      data-run-id={action.runId}
    >
      <p className="cc-meta">
        {t('workspace.workflows.computer.meta', {
          workflow: action.workflowName,
          step: action.stepId,
          when: fmt.timeAgo(action.requestedAt),
        })}
      </p>
      <b id={headingId} className="cc-headline">
        {request.why ? request.why : t(titleKey)}
      </b>

      {command ? (
        editing ? (
          <label className="wf-field">
            <span>{t('workspace.workflows.computer.argsLabel')}</span>
            <textarea
              className="mem-input wf-action-json"
              rows={Math.min(10, Math.max(3, argsText.split('\n').length + 1))}
              spellCheck={false}
              value={argsText}
              disabled={sending}
              onChange={(e) => setArgsText(e.target.value)}
            />
            <span className="wf-muted">{t('workspace.workflows.computer.argsHint')}</span>
          </label>
        ) : (
          <>
            <pre className="cc-term" aria-label={t('workspace.workflows.computer.commandLabel')} title={whereText(request)}>
              {termLine}
            </pre>
            {request.program && request.program !== name ? (
              <p className="wf-muted">{t('workspace.workflows.computer.programIs', { name, path: request.program })}</p>
            ) : null}
          </>
        )
      ) : editing ? (
        <label className="wf-field">
          <span>{t('workspace.workflows.computer.contentLabel')}</span>
          <textarea
            className="mem-input wf-action-json"
            rows={10}
            spellCheck={false}
            value={contentText}
            disabled={sending}
            onChange={(e) => setContentText(e.target.value)}
          />
        </label>
      ) : (
        <>
          <FileDiff path={request.path} previous={request.previous} content={request.content ?? ''} />
          <p className="wf-muted">{t('workspace.workflows.computer.runsIn', { where: request.folder })}</p>
        </>
      )}

      <p className={`cc-chip${risky || request.readBefore || outside ? ' warn' : ''}`} role="note">
        {reasonText}
      </p>

      {outside ? (
        <>
          <p className="wf-muted">{t('workspace.workflows.computer.outside.explain')}</p>
          {outside.output?.trim() ? (
            <details>
              <summary className="wf-muted">{t('workspace.workflows.computer.outside.output')}</summary>
              <pre className="wf-io wf-computer-output">{outside.output.trim()}</pre>
            </details>
          ) : null}
        </>
      ) : null}

      {editing && offered ? (
        <div className="cc-rule">
          <label className="wf-field">
            <span>{t('workspace.workflows.computer.ruleLabel')}</span>
            <input
              className="mem-input wf-action-json"
              spellCheck={false}
              value={rule}
              disabled={sending}
              onChange={(e) => setRule(e.target.value)}
            />
          </label>
          <label className="wf-action-remember">
            <input type="checkbox" checked={remember} disabled={sending} onChange={(e) => setRemember(e.target.checked)} />
            <span>{t('workspace.workflows.computer.allowRule')}</span>
          </label>
        </div>
      ) : null}

      <p className="wf-muted">
        {t(command ? 'workspace.workflows.computer.deadline.command' : 'workspace.workflows.computer.deadline.file', {
          when: formatNextRun(action.expiresAt, fmt.locale),
        })}
      </p>

      <div className="wf-offer-actions">
        {outside ? (
          <>
            <button type="button" className="btn primary" disabled={sending} onClick={() => void answer(false)}>
              {noLabel}
            </button>
            <button type="button" className="btn" disabled={sending} onClick={() => void answer(true)}>
              {t('workspace.workflows.computer.outside.runOnce')}
            </button>
          </>
        ) : editing ? (
          <>
            <button type="button" className="btn primary" disabled={sending} onClick={sendEdited}>
              {risky ? runAnywayLabel : runLabel}
            </button>
            <button type="button" className="btn" disabled={sending} onClick={() => setEditing(false)}>
              {t('workspace.workflows.action.cancel')}
            </button>
          </>
        ) : risky ? (
          <>
            <button type="button" className="btn primary" disabled={sending} onClick={() => void answer(false)}>
              {noLabel}
            </button>
            <button type="button" className="btn" disabled={sending} onClick={() => void answer(true)}>
              {runAnywayLabel}
            </button>
            <button type="button" className="btn ghost" disabled={sending} onClick={startEditing}>
              {t('workspace.workflows.action.edit')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn primary" disabled={sending} onClick={() => void answer(true)}>
              {runLabel}
            </button>
            {offered ? (
              <button type="button" className="btn" disabled={sending} onClick={() => void answer(true, undefined, true)}>
                {t('workspace.workflows.computer.runAndAllow', { rule: request.suggestedRule ?? '' })}
              </button>
            ) : null}
            <button type="button" className="btn" disabled={sending} onClick={startEditing}>
              {t('workspace.workflows.action.edit')}
            </button>
            <button type="button" className="btn ghost" disabled={sending} onClick={() => void answer(false)}>
              {noLabel}
            </button>
          </>
        )}
      </div>
      {sofar ? <p className="wf-muted cc-sofar">{t('workspace.workflows.computer.soFar', { items: sofar })}</p> : null}
      {refused ? (
        <p className="wf-error" role="alert">
          {refused}
        </p>
      ) : null}
    </section>
  );
}
