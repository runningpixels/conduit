/// The Workflows page: saved routines, run by hand, with what each run did.
///
/// List on the left; on the right the selected workflow as a plain-English
/// list of steps, its inputs and "Run now", and its recent runs. Opening a
/// run shows every step it recorded, with the input it ran with and its
/// output or error, so a surprising result can be traced to the step that
/// produced it.
///
/// New workflows start from a ready-made one; editing is a checked JSON editor
/// for now (the backend validates every save).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  getWorkflowRun,
  listWorkflowRuns,
  listWorkflows,
  runWorkflow,
  updateWorkflow,
} from '../ipc/client';
import type {
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowRunStep,
  WorkflowStep,
  WorkflowSummary,
} from '../ipc/contracts';
import { PageEmpty, PageFrame, PageListItem } from '../shell/PageFrame';
import { describeStep, type InputLabels } from '../workflows/describeStep';
import { STARTER_WORKFLOWS, type StarterWorkflow } from '../workflows/starters';

/** Written out, not built from the status, so the stylesheet's dead-rule check sees them. */
const STATUS_CLASS: Record<string, string> = {
  completed: 'wf-status wf-status-completed',
  failed: 'wf-status wf-status-failed',
  running: 'wf-status wf-status-running',
};

type Mode = { kind: 'view' } | { kind: 'new' } | { kind: 'edit'; name: string; description: string; json: string };

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

function durationMs(start: string, end: string | null): number | null {
  if (!end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function WorkflowsPage({ onStatus }: { onStatus: (message: string) => void }) {
  const t = useT();
  const fmt = useFormatters();
  const [summaries, setSummaries] = useState<WorkflowSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [record, setRecord] = useState<WorkflowRecord | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [openRun, setOpenRun] = useState<WorkflowRunDetail | null>(null);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<Mode>({ kind: 'view' });
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    try {
      const next = await listWorkflows();
      setSummaries(next);
      setSelectedId((current) => (current && next.some((w) => w.id === current) ? current : (next[0]?.id ?? null)));
    } catch (e) {
      onStatus(t('workspace.workflows.status.loadFailed', { error: errorText(e) }));
    } finally {
      setLoaded(true);
    }
    // Loaded once on mount and after changes; `t`/`onStatus` identity must not reload it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // Load the selected workflow and its runs.
  useEffect(() => {
    if (!selectedId) {
      setRecord(null);
      setRuns([]);
      return;
    }
    let cancelled = false;
    setOpenRun(null);
    void Promise.all([getWorkflow(selectedId), listWorkflowRuns(selectedId, 20)]).then(
      ([nextRecord, nextRuns]) => {
        if (cancelled) return;
        setRecord(nextRecord);
        setRuns(nextRuns);
        setInputs(
          Object.fromEntries((nextRecord.definition.inputs ?? []).map((i) => [i.id, i.default ?? ''])),
        );
      },
      (e: unknown) => {
        if (!cancelled) onStatus(t('workspace.workflows.status.loadFailed', { error: errorText(e) }));
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  async function startFrom(starter: StarterWorkflow) {
    setBusy(true);
    try {
      const created = await createWorkflow(t(starter.nameKey), t(starter.blurbKey), starter.definition);
      onStatus(t('workspace.workflows.status.created', { name: created.name }));
      setMode({ kind: 'view' });
      await refreshList();
      setSelectedId(created.id);
    } catch (e) {
      onStatus(t('workspace.workflows.status.actionFailed', { error: errorText(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!record) return;
    setRunning(true);
    setOpenRun(null);
    try {
      const detail = await runWorkflow(record.id, inputs);
      setOpenRun(detail);
      onStatus(
        detail.run.status === 'completed'
          ? t('workspace.workflows.status.runCompleted', { name: record.name })
          : t('workspace.workflows.status.runFailed', { name: record.name }),
      );
      setRuns(await listWorkflowRuns(record.id, 20));
      await refreshList();
    } catch (e) {
      onStatus(t('workspace.workflows.status.actionFailed', { error: errorText(e) }));
    } finally {
      setRunning(false);
    }
  }

  async function openRunDetail(runId: string) {
    try {
      setOpenRun(await getWorkflowRun(runId));
    } catch (e) {
      onStatus(t('workspace.workflows.status.loadFailed', { error: errorText(e) }));
    }
  }

  async function saveEdit() {
    if (mode.kind !== 'edit' || !record) return;
    let definition: WorkflowDefinition;
    try {
      definition = JSON.parse(mode.json) as WorkflowDefinition;
    } catch (e) {
      setEditError(t('workspace.workflows.edit.invalidJson', { error: errorText(e) }));
      return;
    }
    setBusy(true);
    try {
      const saved = await updateWorkflow(record.id, mode.name, mode.description.trim() || null, definition);
      setRecord(saved);
      setMode({ kind: 'view' });
      setEditError(null);
      onStatus(t('workspace.workflows.status.saved', { name: saved.name }));
      await refreshList();
    } catch (e) {
      setEditError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!record || !window.confirm(t('workspace.workflows.delete.confirm', { name: record.name }))) return;
    setBusy(true);
    try {
      await deleteWorkflow(record.id);
      onStatus(t('workspace.workflows.status.deleted', { name: record.name }));
      setSelectedId(null);
      await refreshList();
    } catch (e) {
      onStatus(t('workspace.workflows.status.actionFailed', { error: errorText(e) }));
    } finally {
      setBusy(false);
    }
  }

  const statusLabel = (status: string) =>
    status === 'completed'
      ? t('workspace.workflows.run.completed')
      : status === 'failed'
        ? t('workspace.workflows.run.failed')
        : t('workspace.workflows.run.running');

  const list = summaries.map((w) => (
    <PageListItem
      key={w.id}
      selected={mode.kind !== 'new' && w.id === selectedId}
      onSelect={() => {
        setMode({ kind: 'view' });
        setSelectedId(w.id);
      }}
      title={w.name}
      meta={
        w.lastRunAt && w.lastRunStatus
          ? t('workspace.workflows.list.lastRun', { status: statusLabel(w.lastRunStatus), when: fmt.timeAgo(w.lastRunAt) })
          : t('workspace.workflows.list.neverRun')
      }
    />
  ));

  const newButton = (
    <button type="button" className="btn primary" onClick={() => setMode({ kind: 'new' })} disabled={busy}>
      {t('workspace.workflows.actions.new')}
    </button>
  );

  let detail;
  if (!loaded) {
    detail = <div className="artifact-skeleton" aria-hidden="true" />;
  } else if (mode.kind === 'new' || summaries.length === 0) {
    detail = (
      <StarterPicker
        empty={summaries.length === 0}
        busy={busy}
        onPick={(starter) => void startFrom(starter)}
        onCancel={summaries.length > 0 ? () => setMode({ kind: 'view' }) : undefined}
      />
    );
  } else if (!record) {
    detail = <div className="artifact-skeleton" aria-hidden="true" />;
  } else if (mode.kind === 'edit') {
    detail = (
      <section className="wf-edit" aria-label={t('workspace.workflows.edit.title')}>
        <label className="wf-field">
          <span>{t('workspace.workflows.edit.name')}</span>
          <input
            className="mem-input"
            value={mode.name}
            onChange={(e) => setMode({ ...mode, name: e.target.value })}
          />
        </label>
        <label className="wf-field">
          <span>{t('workspace.workflows.edit.description')}</span>
          <input
            className="mem-input"
            value={mode.description}
            onChange={(e) => setMode({ ...mode, description: e.target.value })}
          />
        </label>
        <label className="wf-field">
          <span>{t('workspace.workflows.edit.definition')}</span>
          <textarea
            className="mem-input wf-json"
            spellCheck={false}
            rows={18}
            value={mode.json}
            onChange={(e) => setMode({ ...mode, json: e.target.value })}
          />
        </label>
        {editError ? (
          <p className="wf-error" role="alert">
            {editError}
          </p>
        ) : null}
        <div className="mem-actions">
          <button type="button" className="btn primary" onClick={() => void saveEdit()} disabled={busy}>
            {t('workspace.workflows.edit.save')}
          </button>
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setMode({ kind: 'view' });
              setEditError(null);
            }}
          >
            {t('common.actions.cancel')}
          </button>
        </div>
      </section>
    );
  } else {
    const workflowInputs = record.definition.inputs ?? [];
    detail = (
      <div className="wf-detail">
        <header className="wf-detail-head">
          <div>
            <h3 className="wf-name">{record.name}</h3>
            {record.description ? <p className="wf-description">{record.description}</p> : null}
          </div>
          <div className="mem-actions">
            <button
              type="button"
              className="btn ghost"
              disabled={busy || running}
              onClick={() => {
                setEditError(null);
                setMode({
                  kind: 'edit',
                  name: record.name,
                  description: record.description ?? '',
                  json: JSON.stringify(record.definition, null, 2),
                });
              }}
            >
              {t('workspace.workflows.actions.edit')}
            </button>
            <button type="button" className="btn ghost" disabled={busy || running} onClick={() => void remove()}>
              {t('common.actions.delete')}
            </button>
          </div>
        </header>

        <section className="grp" aria-label={t('workspace.workflows.steps.title')}>
          <div className="grp-label">{t('workspace.workflows.steps.title')}</div>
          <StepList
            steps={record.definition.steps}
            labels={Object.fromEntries(workflowInputs.map((i) => [i.id, i.label]))}
          />
        </section>

        <section className="grp wf-run-box" aria-label={t('workspace.workflows.run.title')}>
          <div className="grp-label">{t('workspace.workflows.run.title')}</div>
          {workflowInputs.map((input) => (
            <label key={input.id} className="wf-field">
              <span>{input.label}</span>
              <input
                className="mem-input"
                value={inputs[input.id] ?? ''}
                onChange={(e) => setInputs({ ...inputs, [input.id]: e.target.value })}
                disabled={running}
              />
            </label>
          ))}
          <div className="mem-actions">
            <button type="button" className="btn primary" onClick={() => void run()} disabled={running || busy}>
              {running ? t('workspace.workflows.run.running') : t('workspace.workflows.run.now')}
            </button>
          </div>
        </section>

        <section className="grp" aria-label={t('workspace.workflows.runs.title')}>
          <div className="grp-label">{t('workspace.workflows.runs.title')}</div>
          {runs.length === 0 ? (
            <p className="wf-muted">{t('workspace.workflows.runs.none')}</p>
          ) : (
            <ul className="wf-runs">
              {runs.map((r) => {
                const ms = durationMs(r.startedAt, r.finishedAt);
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="wf-run-row"
                      aria-current={openRun?.run.id === r.id ? 'true' : undefined}
                      onClick={() => void openRunDetail(r.id)}
                    >
                      <span className={STATUS_CLASS[r.status] ?? 'wf-status'}>{statusLabel(r.status)}</span>
                      <span>{fmt.timeAgo(r.startedAt)}</span>
                      {ms != null ? <span className="wf-muted">{fmt.duration(ms)}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {openRun ? <RunDetail detail={openRun} statusLabel={statusLabel} /> : null}
      </div>
    );
  }

  return (
    <PageFrame
      className="wf-page"
      title={t('workspace.workflows.page.title')}
      subtitle={t('workspace.workflows.page.subtitle')}
      about={t('workspace.workflows.page.about')}
      actions={summaries.length > 0 ? newButton : undefined}
      list={summaries.length > 0 ? list : undefined}
      listLabel={t('workspace.workflows.page.title')}
    >
      {detail}
    </PageFrame>
  );
}

function StarterPicker({
  empty,
  busy,
  onPick,
  onCancel,
}: {
  empty: boolean;
  busy: boolean;
  onPick: (starter: StarterWorkflow) => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const cards = (
    <ul className="wf-starters">
      {STARTER_WORKFLOWS.map((starter) => (
        <li key={starter.id} className="wf-starter">
          <p className="wf-starter-name">{t(starter.nameKey)}</p>
          <p className="wf-muted">{t(starter.blurbKey)}</p>
          <button type="button" className="btn ghost" disabled={busy} onClick={() => onPick(starter)}>
            {t('workspace.workflows.starter.use')}
          </button>
        </li>
      ))}
    </ul>
  );
  if (empty) {
    return (
      <PageEmpty
        title={t('workspace.workflows.empty.title')}
        body={t('workspace.workflows.empty.body')}
        action={cards}
      />
    );
  }
  return (
    <section aria-label={t('workspace.workflows.starter.title')}>
      <div className="grp-label">{t('workspace.workflows.starter.title')}</div>
      {cards}
      {onCancel ? (
        <button type="button" className="btn ghost" onClick={onCancel}>
          {t('common.actions.cancel')}
        </button>
      ) : null}
    </section>
  );
}

function StepList({ steps, labels }: { steps: WorkflowStep[]; labels: InputLabels }) {
  const t = useT();
  return (
    <ol className="wf-steps">
      {steps.map((step) => (
        <li key={step.id}>
          <span>{describeStep(step, t, labels)}</span>
          {step.onError === 'skip' ? <span className="wf-flag">{t('workspace.workflows.step.continuesOnError')}</span> : null}
          {step.type === 'for_each' ? <StepList steps={step.steps} labels={labels} /> : null}
        </li>
      ))}
    </ol>
  );
}

function RunDetail({ detail, statusLabel }: { detail: WorkflowRunDetail; statusLabel: (s: string) => string }) {
  const t = useT();
  const fmt = useFormatters();
  const started = useMemo(() => fmt.timeAgo(detail.run.startedAt), [fmt, detail.run.startedAt]);
  return (
    <section className="grp wf-run-detail" aria-label={t('workspace.workflows.runDetail.title')}>
      <div className="grp-label">
        {t('workspace.workflows.runDetail.heading', { status: statusLabel(detail.run.status), when: started })}
      </div>
      {detail.run.error ? (
        <p className="wf-error" role="status">
          {detail.run.error}
        </p>
      ) : null}
      <ul className="wf-run-steps">
        {detail.steps.map((step) => (
          <RunStepRow key={step.id} step={step} statusLabel={statusLabel} />
        ))}
      </ul>
    </section>
  );
}

function RunStepRow({ step, statusLabel }: { step: WorkflowRunStep; statusLabel: (s: string) => string }) {
  const t = useT();
  const fmt = useFormatters();
  const ms = durationMs(step.startedAt, step.finishedAt);
  const name =
    step.iteration != null
      ? t('workspace.workflows.runDetail.iteration', { step: step.stepId, n: step.iteration + 1 })
      : step.stepId;
  return (
    <li className={step.iteration != null ? 'wf-run-step wf-run-step-nested' : 'wf-run-step'}>
      <details>
        <summary>
          <span className={STATUS_CLASS[step.status] ?? 'wf-status'}>{statusLabel(step.status)}</span>
          <span className="wf-step-name">{name}</span>
          {ms != null ? <span className="wf-muted">{fmt.duration(ms)}</span> : null}
        </summary>
        {step.error ? <p className="wf-error">{step.error}</p> : null}
        <p className="wf-io-label">{t('workspace.workflows.runDetail.input')}</p>
        <pre className="wf-io">{JSON.stringify(step.input, null, 2)}</pre>
        {step.output != null ? (
          <>
            <p className="wf-io-label">{t('workspace.workflows.runDetail.output')}</p>
            <pre className="wf-io">{JSON.stringify(step.output, null, 2)}</pre>
          </>
        ) : null}
      </details>
    </li>
  );
}
