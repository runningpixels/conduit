/// The approval card for a command or file change an agent wants to make on
/// this computer. It leads with why it asks and what outside content the agent
/// read first (the safety signal), then the exact command or change, which the
/// user can run, edit, or refuse. "Allow from now on" adds a rule the user can
/// word themselves before confirming.

import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { answerWorkflowAction } from '../ipc/client';
import type { ComputerRequest, WorkflowAction } from '../ipc/contracts';
import { rejectionText } from './CommandRuleList';
import { lineDiff } from './lineDiff';
import { formatNextRun } from './ScheduleSection';

/// The folder and where inside it, as a path; just the folder for ".".
function whereText(request: ComputerRequest): string {
  const inner = request.path.trim();
  if (inner === '' || inner === '.') return request.folder;
  return `${request.folder.replace(/[\\/]+$/, '')}\\${inner}`;
}

function textArg(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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
  const args = request.args ?? [];
  const offered = !action.sensitive && Boolean(request.suggestedRule);
  const [editing, setEditing] = useState(false);
  const [argsText, setArgsText] = useState('');
  const [contentText, setContentText] = useState('');
  const [remember, setRemember] = useState(false);
  const [rule, setRule] = useState(request.suggestedRule ?? '');
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function startEditing() {
    setArgsText(args.join('\n'));
    setContentText(request.content ?? '');
    setEditing(true);
  }

  async function answer(send: boolean, edited?: Record<string, unknown>) {
    setSending(true);
    setRefused(null);
    const ruleText = rule.trim();
    try {
      const taken = await answerWorkflowAction(action.runId, action.stepId, {
        send,
        ...(edited ? { arguments: edited } : {}),
        ...(send && offered && remember && ruleText ? { remember: true, rule: ruleText } : {}),
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

  return (
    <section
      className="wf-offer wf-review wf-action wf-computer"
      role="group"
      aria-labelledby={headingId}
      data-run-id={action.runId}
    >
      <b id={headingId}>{t(titleKey)}</b>
      <p className="wf-review-what wf-computer-reason">{request.reason}</p>
      {request.readBefore ? (
        <p className="wf-computer-read" role="note">
          {t('workspace.workflows.computer.readBefore', { what: request.readBefore })}
        </p>
      ) : null}
      {request.why ? <p className="wf-muted">{t('workspace.workflows.computer.why', { why: request.why })}</p> : null}

      {command ? (
        <>
          {editing ? (
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
            <pre className="wf-computer-command" aria-label={t('workspace.workflows.computer.commandLabel')}>
              {[request.program ?? '', ...args].join('\n')}
            </pre>
          )}
          <p className="wf-muted">{t('workspace.workflows.computer.runsIn', { where: whereText(request) })}</p>
        </>
      ) : (
        <>
          <p className="wf-muted">
            {request.previous === undefined
              ? t('workspace.workflows.computer.newFile', { path: request.path, folder: request.folder })
              : t('workspace.workflows.computer.changeFile', { path: request.path, folder: request.folder })}
          </p>
          {editing ? (
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
            <FileChange previous={request.previous} content={request.content ?? ''} />
          )}
        </>
      )}

      <p className="wf-muted">
        {t('workspace.workflows.review.expires', { when: formatNextRun(action.expiresAt, fmt.locale) })}
      </p>
      {action.sensitive ? (
        // A file change says why it asks above; outside content asks only this time.
        command && !request.readBefore ? <p className="wf-muted">{t('workspace.workflows.computer.alwaysAsks')}</p> : null
      ) : offered ? (
        <div className="wf-computer-remember">
          <label className="wf-action-remember">
            <input type="checkbox" checked={remember} disabled={sending} onChange={(e) => setRemember(e.target.checked)} />
            <span>{t('workspace.workflows.computer.remember', { rule: request.suggestedRule ?? '' })}</span>
          </label>
          {remember ? (
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
          ) : null}
        </div>
      ) : null}
      <div className="wf-offer-actions">
        {editing ? (
          <>
            <button type="button" className="btn primary" disabled={sending} onClick={sendEdited}>
              {command ? t('workspace.workflows.computer.run') : t('workspace.workflows.computer.change')}
            </button>
            <button type="button" className="btn" disabled={sending} onClick={() => setEditing(false)}>
              {t('workspace.workflows.action.cancel')}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn primary" disabled={sending} onClick={() => void answer(true)}>
              {command ? t('workspace.workflows.computer.run') : t('workspace.workflows.computer.change')}
            </button>
            <button type="button" className="btn" disabled={sending} onClick={startEditing}>
              {t('workspace.workflows.action.edit')}
            </button>
            <button type="button" className="btn ghost" disabled={sending} onClick={() => void answer(false)}>
              {command ? t('workspace.workflows.computer.dontRun') : t('workspace.workflows.computer.dontChange')}
            </button>
          </>
        )}
      </div>
      {refused ? (
        <p className="wf-error" role="alert">
          {refused}
        </p>
      ) : null}
    </section>
  );
}

/// The new content of a file, as a line diff against the old when there is one.
function FileChange({ previous, content }: { previous: string | undefined; content: string }) {
  const t = useT();
  if (previous === undefined) {
    return (
      <pre className="wf-computer-file" aria-label={t('workspace.workflows.computer.contentLabel')}>
        {content}
      </pre>
    );
  }
  const rows = lineDiff(previous, content);
  if (rows.every((r) => r.kind === 'same')) {
    return <p className="wf-muted">{t('workspace.workflows.computer.noChange')}</p>;
  }
  return (
    <div className="wf-diff" role="group" aria-label={t('workspace.workflows.computer.diffLabel')}>
      {rows.map((row, i) =>
        row.kind === 'skip' ? (
          <div key={i} className="wf-diff-line skip">
            {t('workspace.workflows.computer.unchangedLines', { count: row.count })}
          </div>
        ) : (
          <div key={i} className={`wf-diff-line ${row.kind}`} data-diff={row.kind}>
            <span aria-hidden="true">{row.kind === 'add' ? '+ ' : row.kind === 'del' ? '- ' : '  '}</span>
            {row.text}
          </div>
        ),
      )}
    </div>
  );
}
