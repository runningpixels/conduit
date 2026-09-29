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
  validateWorkflow,
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
import { newStep } from '../workflows/editorModel';
import { formatNextRun, ScheduleSection } from '../workflows/ScheduleSection';
import { STARTER_WORKFLOWS, type StarterWorkflow } from '../workflows/starters';
import { WorkflowEditor, type WorkflowDraft } from '../workflows/WorkflowEditor';

/** Written out, not built from the status, so the stylesheet's dead-rule check sees them. */
const STATUS_CLASS: Record<string, string> = {
  completed: 'wf-status wf-status-completed',
  failed: 'wf-status wf-status-failed',
  running: 'wf-status wf-status-running',
};

/// `draft` is the editor, for a new workflow (`workflowId: null`) or an
/// existing one. `json` is set while the JSON view is open.
type Mode =
  | { kind: 'view' }
  | { kind: 'new' }
  | { kind: 'draft'; workflowId: string | null; draft: WorkflowDraft; json: string | null };

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

function durationMs(start: string, end: string | null): number | null {
  if (!end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function WorkflowsPage({
  onStatus,
  onOpenDocument,
  refreshKey,
}: {
  onStatus: (message: string) => void;
  /** Open a document a run saved, in its conversation's document panel. */
  onOpenDocument?: (conversationId: string, artifactId: string) => void;
  /** Changes when a scheduled run finishes elsewhere; the page re-reads. */
  refreshKey?: number;
}) {
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
  const [problems, setProblems] = useState<string[]>([]);

  // Check the draft as it changes, so problems show before saving.
  const draftDefinition = mode.kind === 'draft' ? mode.draft.definition : null;
  const draftJson = mode.kind === 'draft' ? mode.json : null;
  useEffect(() => {
    if (!draftDefinition) {
      setProblems([]);
      return;
    }
    let definition = draftDefinition;
    if (draftJson != null) {
      try {
        definition = JSON.parse(draftJson) as WorkflowDefinition;
      } catch (e) {
        setProblems([t('workspace.workflows.edit.invalidJson', { error: errorText(e) })]);
        return;
      }
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void validateWorkflow(definition).then(
        (next) => {
          if (!cancelled) setProblems(next);
        },
        () => {},
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftDefinition, draftJson]);

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

  // A scheduled run finished: re-read the list, and the selected workflow's runs.
  useEffect(() => {
    if (!refreshKey) return;
    void refreshList();
    if (selectedId) void listWorkflowRuns(selectedId, 20).then(setRuns, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

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

  /// The definition being edited, from whichever view is open.
  function currentDefinition(m: Extract<Mode, { kind: 'draft' }>): WorkflowDefinition | null {
    if (m.json == null) return m.draft.definition;
    try {
      return JSON.parse(m.json) as WorkflowDefinition;
    } catch (e) {
      setEditError(t('workspace.workflows.edit.invalidJson', { error: errorText(e) }));
      return null;
    }
  }

  async function saveDraft() {
    if (mode.kind !== 'draft') return;
    const definition = currentDefinition(mode);
    if (!definition) return;
    const { name, description } = mode.draft;
    setBusy(true);
    try {
      const saved = mode.workflowId
        ? await updateWorkflow(mode.workflowId, name, description.trim() || null, definition)
        : await createWorkflow(name, description.trim() || null, definition);
      setMode({ kind: 'view' });
      setEditError(null);
      onStatus(
        t(mode.workflowId ? 'workspace.workflows.status.saved' : 'workspace.workflows.status.created', {
          name: saved.name,
        }),
      );
      await refreshList();
      if (mode.workflowId) setRecord(saved);
      else setSelectedId(saved.id);
    } catch (e) {
      setEditError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  /// Switch between the visual editor and the JSON view, keeping the draft.
  function toggleJson() {
    if (mode.kind !== 'draft') return;
    if (mode.json == null) {
      setMode({ ...mode, json: JSON.stringify(mode.draft.definition, null, 2) });
      return;
    }
    const definition = currentDefinition(mode);
    if (!definition) return;
    setEditError(null);
    setMode({ ...mode, draft: { ...mode.draft, definition }, json: null });
  }

  function startBlank() {
    setEditError(null);
    setMode({
      kind: 'draft',
      workflowId: null,
      draft: {
        name: t('workspace.workflows.editor.newName'),
        description: '',
        definition: { inputs: [], steps: [newStep('fetch_page', new Set())] },
      },
      json: null,
    });
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
      selected={mode.kind === 'view' && w.id === selectedId}
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
      status={
        w.nextRunAt ? (
          <span className="wf-flag">
            {t('workspace.workflows.list.nextRun', { when: formatNextRun(w.nextRunAt, fmt.locale) })}
          </span>
        ) : undefined
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
  } else if (mode.kind === 'new' || (summaries.length === 0 && mode.kind !== 'draft')) {
    detail = (
      <StarterPicker
        empty={summaries.length === 0}
        busy={busy}
        onPick={(starter) => void startFrom(starter)}
        onBlank={startBlank}
        onCancel={summaries.length > 0 ? () => setMode({ kind: 'view' }) : undefined}
      />
    );
  } else if (mode.kind === 'draft') {
    detail = (
      <section className="wf-edit" aria-label={t('workspace.workflows.edit.title')}>
        {mode.json == null ? (
          <WorkflowEditor draft={mode.draft} onChange={(draft) => setMode({ ...mode, draft })} />
        ) : (
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
        )}
        {problems.length > 0 ? (
          <div className="wf-problems" role="status">
            <p className="wf-io-label">{t('workspace.workflows.editor.problems')}</p>
            <ul>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {editError ? (
          <p className="wf-error" role="alert">
            {editError}
          </p>
        ) : null}
        <div className="mem-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => void saveDraft()}
            disabled={busy || problems.length > 0 || !mode.draft.name.trim()}
          >
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
          <button type="button" className="btn ghost wf-json-toggle" onClick={toggleJson}>
            {mode.json == null ? t('workspace.workflows.editor.showJson') : t('workspace.workflows.editor.showVisual')}
          </button>
        </div>
      </section>
    );
  } else if (!record) {
    detail = <div className="artifact-skeleton" aria-hidden="true" />;
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
                  kind: 'draft',
                  workflowId: record.id,
                  draft: { name: record.name, description: record.description ?? '', definition: record.definition },
                  json: null,
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

        <ScheduleSection
          workflowId={record.id}
          refreshKey={refreshKey}
          onStatus={onStatus}
          onChanged={() => void refreshList()}
        />

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

        {openRun ? <RunDetail detail={openRun} statusLabel={statusLabel} onOpenDocument={onOpenDocument} /> : null}
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
  onBlank,
  onCancel,
}: {
  empty: boolean;
  busy: boolean;
  onPick: (starter: StarterWorkflow) => void;
  onBlank: () => void;
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
      <li className="wf-starter">
        <p className="wf-starter-name">{t('workspace.workflows.starter.blank.name')}</p>
        <p className="wf-muted">{t('workspace.workflows.starter.blank.blurb')}</p>
        <button type="button" className="btn ghost" disabled={busy} onClick={onBlank}>
          {t('workspace.workflows.starter.blank.use')}
        </button>
      </li>
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

/** A document a run saved, from a save step's output. */
interface SavedDocument {
  artifactId: string;
  conversationId: string;
  title: string;
}

/** The documents a run saved, once each, in the order they were saved. */
export function savedDocuments(detail: WorkflowRunDetail): SavedDocument[] {
  const seen = new Set<string>();
  const docs: SavedDocument[] = [];
  for (const step of detail.steps) {
    const out = step.output as Partial<Record<string, unknown>> | null;
    if (!out || typeof out.artifactId !== 'string' || typeof out.conversationId !== 'string') continue;
    if (seen.has(out.artifactId)) continue;
    seen.add(out.artifactId);
    docs.push({
      artifactId: out.artifactId,
      conversationId: out.conversationId,
      title: typeof out.title === 'string' && out.title ? out.title : out.artifactId,
    });
  }
  return docs;
}

function RunDetail({
  detail,
  statusLabel,
  onOpenDocument,
}: {
  detail: WorkflowRunDetail;
  statusLabel: (s: string) => string;
  onOpenDocument?: (conversationId: string, artifactId: string) => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const started = useMemo(() => fmt.timeAgo(detail.run.startedAt), [fmt, detail.run.startedAt]);
  const docs = savedDocuments(detail);
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
      {docs.length > 0 && onOpenDocument ? (
        <div className="wf-saved">
          <span className="wf-muted">{t('workspace.workflows.runDetail.saved')}</span>
          {docs.map((doc) => (
            <button
              key={doc.artifactId}
              type="button"
              className="btn ghost"
              onClick={() => onOpenDocument(doc.conversationId, doc.artifactId)}
            >
              {t('workspace.workflows.runDetail.openDocument', { title: doc.title })}
            </button>
          ))}
        </div>
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
