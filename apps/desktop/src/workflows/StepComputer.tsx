/// What an agent step did on the computer, in a run's details: one line per
/// command or file change with how it ended, who approved it, and (for a
/// command) its exit code, time and output. Long output is folded.

import { useT, type Translate } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import type { ComputerOutcome, ComputerRecord } from '../ipc/contracts';
import { FileDiff } from './FileDiff';
import '../styles/computer-card.css';

const OUTCOME_KEY: Record<ComputerOutcome, string> = {
  ran: 'workspace.workflows.runDetail.computer.outcome.ran',
  timedOut: 'workspace.workflows.runDetail.computer.outcome.timedOut',
  failed: 'workspace.workflows.runDetail.computer.outcome.failed',
  notRun: 'workspace.workflows.runDetail.computer.outcome.notRun',
  declined: 'workspace.workflows.runDetail.computer.outcome.declined',
  skipped: 'workspace.workflows.runDetail.computer.outcome.skipped',
  changed: 'workspace.workflows.runDetail.computer.outcome.changed',
};

/// Output longer than this (characters) or taller than `INLINE_LINES` is folded.
const INLINE_CHARS = 200;
const INLINE_LINES = 3;
/// Most output shown, however long.
const MAX_SHOWN = 20000;

function isRecord(v: unknown): v is ComputerRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (typeof r.outcome !== 'string' || !(r.outcome in OUTCOME_KEY)) return false;
  if (r.kind === 'command') return typeof r.program === 'string' && Array.isArray(r.args);
  return (r.kind === 'write' || r.kind === 'edit') && typeof r.path === 'string';
}

/// The computer records in a step's output (`computer[]`); none when it has none.
export function stepComputer(output: unknown): ComputerRecord[] {
  if (!output || typeof output !== 'object') return [];
  const list = (output as Record<string, unknown>).computer;
  return Array.isArray(list) ? list.filter(isRecord) : [];
}

/// The program's file name, so a long path doesn't bury the command.
function baseName(program: string): string {
  const parts = program.split(/[\\/]/);
  return parts[parts.length - 1] || program;
}

/// Who approved it, in words; `null` when nobody did (it was not run).
function approvedText(by: string, t: Translate): string | null {
  if (!by) return null;
  if (by === 'you') return t('workspace.workflows.runDetail.computer.approved.you');
  if (by.startsWith('rule:')) return t('workspace.workflows.runDetail.computer.approved.rule', { rule: by.slice(5).trim() });
  if (by === "the workflow's edit mode") return t('workspace.workflows.runDetail.computer.approved.editMode');
  return t('workspace.workflows.runDetail.computer.approved.other', { by });
}

export function StepComputer({ output }: { output: unknown }) {
  const t = useT();
  const fmt = useFormatters();
  const records = stepComputer(output);
  if (records.length === 0) return null;
  return (
    <section className="wf-computer-taken" aria-label={t('workspace.workflows.runDetail.computer.title')}>
      <p className="wf-io-label">{t('workspace.workflows.runDetail.computer.title')}</p>
      <ul className="wf-actions-taken">
        {records.map((r, i) => {
          const badExit = r.kind === 'command' && r.exitCode !== undefined && r.exitCode !== 0;
          const bad = r.outcome === 'failed' || r.outcome === 'timedOut' || badExit;
          const approved = approvedText(r.approvedBy, t);
          const what = r.kind === 'command' ? [baseName(r.program), ...r.args].join(' ') : r.path;
          const output = r.kind === 'command' ? (r.output ?? '').trim() : '';
          const inline = output.length <= INLINE_CHARS && output.split('\n').length <= INLINE_LINES;
          return (
            <li key={i} className="wf-computer-record">
              <span className={bad ? 'wf-error' : undefined}>
                <b>{t(OUTCOME_KEY[r.outcome])}</b> <code>{what}</code>
              </span>
              <span className="wf-muted wf-computer-meta">
                {[
                  approved,
                  r.kind === 'command' && r.cwd && r.cwd !== '.' ? t('workspace.workflows.runDetail.computer.in', { cwd: r.cwd }) : null,
                  r.kind === 'command' && r.exitCode !== undefined ? (
                    <span key="exit" className={badExit ? 'cc-exit' : undefined}>
                      {t('workspace.workflows.runDetail.computer.exit', { code: r.exitCode })}
                    </span>
                  ) : null,
                  r.kind === 'command' && r.durationMs !== undefined ? fmt.duration(r.durationMs) : null,
                ]
                  .filter((x): x is NonNullable<typeof x> => Boolean(x))
                  .flatMap((x, n) => (n === 0 ? [x] : [' · ', x]))}
              </span>
              {r.kind !== 'command' && r.previous !== undefined && r.content !== undefined ? (
                <details>
                  <summary className="wf-muted">{t('workspace.workflows.runDetail.computer.showChanges')}</summary>
                  <FileDiff previous={r.previous} content={r.content} />
                </details>
              ) : null}
              {r.kind === 'command' && r.reason ? <span className="wf-muted">{r.reason}</span> : null}
              {r.kind === 'command' && r.error ? <span className="wf-error">{r.error}</span> : null}
              {output ? (
                inline ? (
                  <pre className="wf-io wf-computer-output">{output}</pre>
                ) : (
                  <details>
                    <summary className="wf-muted">{t('workspace.workflows.runDetail.computer.output')}</summary>
                    <pre className="wf-io wf-computer-output">
                      {output.length > MAX_SHOWN ? `${output.slice(0, MAX_SHOWN)}…` : output}
                    </pre>
                  </details>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
