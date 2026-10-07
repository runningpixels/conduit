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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  getWorkflowRun,
  answerWorkflowQuestion,
  answerWorkflowReview,
  listWorkflowQuestions,
  listWorkflowReviews,
  listProviderDescriptors,
  listWorkflowRuns,
  listWorkflows,
  rerunWorkflowFrom,
  runWorkflow,
  stopWorkflowRun,
  updateWorkflow,
  validateWorkflow,
} from '../ipc/client';
import type {
  ProviderDescriptor,
  WorkflowDefinition,
  WorkflowRecord,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowQuestion,
  WorkflowReview,
  WorkflowReviewDecision,
  WorkflowRunStep,
  WorkflowStep,
  WorkflowSummary,
} from '../ipc/contracts';
import { PageEmpty, PageFrame, PageListItem } from '../shell/PageFrame';
import { describeStep, type InputLabels } from '../workflows/describeStep';
import { newStep } from '../workflows/editorModel';
import { describeJsonError } from '../workflows/jsonError';
import { reviewText } from '../workflows/permissionText';
import { isNothingNew, nothingNewStop } from '../workflows/runOutcome';
import { formatNextRun, ScheduleSection } from '../workflows/ScheduleSection';
import { STARTER_WORKFLOWS, type StarterWorkflow } from '../workflows/starters';
import { WorkflowEditor, type WorkflowDraft } from '../workflows/WorkflowEditor';

/** Written out, not built from the status, so the stylesheet's dead-rule check sees them. */
const STATUS_CLASS: Record<string, string> = {
  completed: 'wf-status wf-status-completed',
  failed: 'wf-status wf-status-failed',
  running: 'wf-status wf-status-running',
  paused: 'wf-status wf-status-paused',
  reused: 'wf-status wf-status-reused',
  skipped: 'wf-status wf-status-skipped',
  stopped: 'wf-status wf-status-stopped',
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

/** The longest answer the engine accepts to a question. */
export const MAX_ANSWER_CHARS = 2000;
/** The counter shows once the answer is this close to the limit. */
const COUNTER_FROM = 1800;
/** How often a running workflow's runs are re-read. */
const RUN_POLL_MS = 2000;

const isLive = (status: string) => status === 'running' || status === 'paused';

function durationMs(start: string, end: string | null): number | null {
  if (!end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function WorkflowsPage({
  onStatus,
  onOpenDocument,
  refreshKey,
  startNew = false,
  focus = null,
}: {
  onStatus: (message: string) => void;
  /** Open a document a run saved, in its conversation's document panel. */
  onOpenDocument?: (conversationId: string, artifactId: string) => void;
  /** Changes when a scheduled run finishes elsewhere; the page re-reads. */
  refreshKey?: number;
  /** Open on the "new workflow" picker (Home's "New workflow"). */
  startNew?: boolean;
  /** Open on this workflow, with its waiting panel in view (Home's "Answer"/"Review"). */
  focus?: { workflowId: string; runId?: string; nonce?: number } | null;
}) {
  const t = useT();
  const fmt = useFormatters();
  const [summaries, setSummaries] = useState<WorkflowSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(focus?.workflowId ?? null);
  const [record, setRecord] = useState<WorkflowRecord | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [openRun, setOpenRun] = useState<WorkflowRunDetail | null>(null);
  const openRunRef = useRef<WorkflowRunDetail | null>(null);
  openRunRef.current = openRun;
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<Mode>(startNew ? { kind: 'new' } : { kind: 'view' });
  /// This page started a run and is waiting for it to end.
  const [started, setStarted] = useState(false);
  /// Reviews the backend has not accepted an answer to yet.
  const [answering, setAnswering] = useState<Set<string>>(new Set());
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});
  const detailRef = useRef<HTMLDivElement | null>(null);
  const [stopping, setStopping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  // The backend is the truth about whether a run is going: it survives leaving
  // this page and coming back, and covers runs the scheduler started.
  const liveRun = runs.find((r) => r.workflowId === selectedId && isLive(r.status)) ?? null;
  const running = started || liveRun != null;
  const [problems, setProblems] = useState<string[]>([]);
  /// Scheduled runs waiting for an answer (any workflow).
  const [reviews, setReviews] = useState<WorkflowReview[]>([]);
  /// Runs waiting at an "Ask me" step (any workflow).
  const [questions, setQuestions] = useState<WorkflowQuestion[]>([]);

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
        setProblems([jsonProblem(draftJson, e)]);
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

  /// Why this text isn't JSON, in plain words with a line and column.
  function jsonProblem(text: string, e: unknown): string {
    return describeJsonError(text, e, t) ?? t('workspace.workflows.edit.invalidJson', { error: errorText(e) });
  }

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

  // A scheduled run finished or paused: re-read the list, and the selected workflow's runs.
  useEffect(() => {
    if (!refreshKey) return;
    void refreshList();
    if (selectedId) void listWorkflowRuns(selectedId, 20).then(setRuns, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Home sent us to a particular workflow: show it, not the previous selection.
  useEffect(() => {
    if (!focus) return;
    setMode({ kind: 'view' });
    setSelectedId(focus.workflowId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.workflowId, focus?.runId, focus?.nonce]);

  // Once the focused workflow's waiting panel is on screen, bring it into view.
  useEffect(() => {
    if (!focus || !record || record.id !== focus.workflowId) return;
    const root = detailRef.current;
    if (!root) return;
    const panels = Array.from(root.querySelectorAll<HTMLElement>('[data-run-id]'));
    const panel = panels.find((el) => el.dataset.runId === focus.runId) ?? panels[0];
    panel?.scrollIntoView?.({ block: 'center' });
  }, [focus, record, reviews, questions]);

  // What scheduled runs are waiting for.
  useEffect(() => {
    let cancelled = false;
    void listWorkflowReviews().then(
      (next) => {
        if (!cancelled) setReviews(next);
      },
      () => {},
    );
    void listWorkflowQuestions().then(
      (next) => {
        if (!cancelled) setQuestions(next);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  function markAnswering(runId: string, on: boolean) {
    setAnswering((current) => {
      const next = new Set(current);
      if (on) next.add(runId);
      else next.delete(runId);
      return next;
    });
  }

  /// The panel stays until the backend takes the answer; a refusal is shown in it.
  async function answer(review: WorkflowReview, decision: WorkflowReviewDecision) {
    markAnswering(review.runId, true);
    setReviewErrors((current) => {
      const { [review.runId]: _cleared, ...rest } = current;
      return rest;
    });
    try {
      const taken = await answerWorkflowReview(review.runId, decision);
      if (!taken) onStatus(t('workspace.workflows.review.gone'));
    } catch (e) {
      setReviewErrors((current) => ({
        ...current,
        [review.runId]: t('workspace.workflows.status.actionFailed', { error: errorText(e) }),
      }));
      markAnswering(review.runId, false);
      return;
    }
    markAnswering(review.runId, false);
    setReviews(await listWorkflowReviews().catch(() => []));
    if (selectedId) setRuns(await listWorkflowRuns(selectedId, 20).catch(() => runs));
  }

  /// Resolves to why the answer was refused, or `null` once it was taken.
  async function reply(question: WorkflowQuestion, text: string): Promise<string | null> {
    try {
      const taken = await answerWorkflowQuestion(question.runId, text);
      if (!taken) onStatus(t('workspace.workflows.review.gone'));
    } catch (e) {
      return t('workspace.workflows.question.failed', { error: errorText(e) });
    }
    // Gone only now, so a refused answer keeps its panel and the typed text.
    setQuestions((current) => current.filter((q) => q.runId !== question.runId));
    setQuestions(await listWorkflowQuestions().catch(() => []));
    return null;
  }

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
        // A run still going (left and come back): show it, live.
        const live = nextRuns.find((r) => isLive(r.status));
        if (live) {
          void getWorkflowRun(live.id).then(
            (detail) => {
              if (!cancelled) setOpenRun(detail);
            },
            () => {},
          );
        }
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

  // While a run is going, follow it: the list, and the detail being shown.
  useEffect(() => {
    if (!running || !selectedId) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const next = await listWorkflowRuns(selectedId, 20);
          if (cancelled) return;
          setRuns(next);
          const live = next.find((r) => isLive(r.status));
          const shown = openRunRef.current;
          const target =
            live && (!shown || shown.run.id === live.id)
              ? live.id
              : shown && isLive(shown.run.status)
                ? shown.run.id
                : null;
          if (target) {
            const detail = await getWorkflowRun(target);
            if (!cancelled) setOpenRun(detail);
          }
          if (!live) void refreshList();
        } catch {
          // The next tick tries again.
        }
      })();
    }, RUN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, selectedId]);

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

  /// Run it (`start` begins the run and resolves when it ends), then show
  /// what it did.
  async function run(start: () => Promise<WorkflowRunDetail> = () => runWorkflow(record!.id, inputs)) {
    if (!record) return;
    setStarted(true);
    setStopping(false);
    setOpenRun(null);
    try {
      const detail = await start();
      setOpenRun(detail);
      onStatus(
        detail.run.status === 'completed'
          ? t('workspace.workflows.status.runCompleted', { name: record.name })
          : detail.run.status === 'stopped'
            ? t('workspace.workflows.status.runStopped', { name: record.name })
            : t('workspace.workflows.status.runFailed', { name: record.name }),
      );
      setRuns(await listWorkflowRuns(record.id, 20));
      await refreshList();
    } catch (e) {
      onStatus(t('workspace.workflows.status.actionFailed', { error: errorText(e) }));
    } finally {
      setStarted(false);
      setStopping(false);
    }
  }

  /// Ask the run to stop; `run()` hears it end, after the step it is on.
  async function stop() {
    if (!record) return;
    setStopping(true);
    try {
      await stopWorkflowRun(record.id);
    } catch (e) {
      setStopping(false);
      onStatus(t('workspace.workflows.status.actionFailed', { error: errorText(e) }));
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
      setEditError(jsonProblem(m.json, e));
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
        : status === 'stopped'
          ? t('workspace.workflows.run.stopped')
          : status === 'paused'
            ? t('workspace.workflows.run.paused')
            : status === 'reused'
              ? t('workspace.workflows.run.reused')
              : status === 'skipped'
                ? t('workspace.workflows.run.skipped')
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
      <div className="wf-detail" ref={detailRef}>
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

        {reviews
          .filter((review) => review.workflowId === record.id)
          .map((review) => (
            <section
              key={review.runId}
              className="wf-offer wf-review"
              role="group"
              aria-label={t('workspace.workflows.review.title')}
              data-run-id={review.runId}
            >
              <b>{t('workspace.workflows.review.title')}</b>
              <p className="wf-review-what">{reviewText(review, t)}</p>
              <p className="wf-muted">
                {t('workspace.workflows.review.expires', {
                  when: formatNextRun(review.expiresAt, fmt.locale),
                })}
              </p>
              <div className="wf-offer-actions">
                <button
                  type="button"
                  className="btn primary"
                  disabled={answering.has(review.runId)}
                  onClick={() => void answer(review, 'allowOnce')}
                >
                  {t('workspace.workflows.review.allowOnce')}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={answering.has(review.runId)}
                  onClick={() => void answer(review, 'alwaysAllow')}
                >
                  {t('workspace.workflows.review.alwaysAllow')}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={answering.has(review.runId)}
                  onClick={() => void answer(review, 'deny')}
                >
                  {t('workspace.workflows.review.deny')}
                </button>
              </div>
              {reviewErrors[review.runId] ? (
                <p className="wf-error" role="alert">
                  {reviewErrors[review.runId]}
                </p>
              ) : null}
            </section>
          ))}

        {questions
          .filter((question) => question.workflowId === record.id)
          .map((question) => (
            <QuestionPanel
              key={question.runId}
              question={question}
              expires={formatNextRun(question.expiresAt, fmt.locale)}
              onAnswer={(text) => reply(question, text)}
            />
          ))}

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
            {running ? (
              <button type="button" className="btn" onClick={() => void stop()} disabled={stopping}>
                {stopping ? t('workspace.workflows.run.stopping') : t('workspace.workflows.run.stop')}
              </button>
            ) : null}
          </div>
        </section>

        <ScheduleSection
          workflowId={record.id}
          refreshKey={refreshKey}
          definitionVersion={record.version}
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
                      <span className={STATUS_CLASS[r.status] ?? 'wf-status'}>
                        {isNothingNew(r) ? t('workspace.workflows.run.nothingNew') : statusLabel(r.status)}
                      </span>
                      <span>{fmt.timeAgo(r.startedAt)}</span>
                      {ms != null ? <span className="wf-muted">{fmt.duration(ms)}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {openRun ? (
          <RunDetail
            detail={openRun}
            statusLabel={statusLabel}
            onOpenDocument={onOpenDocument}
            canRerun={!running && !busy}
            onRerunFrom={(stepId) => void run(() => rerunWorkflowFrom(openRun.run.id, stepId))}
          />
        ) : null}
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

/// A run waiting at an "Ask me" step: the question, and its choices or a box
/// to type the answer in.
function QuestionPanel({
  question,
  expires,
  onAnswer,
}: {
  question: WorkflowQuestion;
  expires: string;
  /// Resolves to why the answer was refused, or `null` when it was taken.
  onAnswer: (answer: string) => Promise<string | null>;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const send = async (answer: string) => {
    setSending(true);
    setRefused(null);
    try {
      const why = await onAnswer(answer);
      if (why && alive.current) setRefused(why);
    } finally {
      if (alive.current) setSending(false);
    }
  };
  return (
    <section
      className="wf-offer wf-review"
      role="group"
      aria-label={t('workspace.workflows.review.title')}
      data-run-id={question.runId}
    >
      <b>{t('workspace.workflows.review.title')}</b>
      <p className="wf-review-what">{question.question}</p>
      {question.choices.length > 0 ? (
        <div className="wf-offer-actions">
          {question.choices.map((choice) => (
            <button key={choice} type="button" className="btn" disabled={sending} onClick={() => void send(choice)}>
              {choice}
            </button>
          ))}
        </div>
      ) : (
        <form
          className="wf-question-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) void send(text);
          }}
        >
          <label className="wf-field">
            <span>{t('workspace.workflows.question.answerLabel')}</span>
            <textarea
              className="mem-input"
              rows={2}
              maxLength={MAX_ANSWER_CHARS}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          {text.length >= COUNTER_FROM ? (
            <p className="wf-muted wf-counter">
              {t('workspace.workflows.question.counter', { count: text.length, max: MAX_ANSWER_CHARS })}
            </p>
          ) : null}
          <button type="submit" className="btn primary" disabled={sending || !text.trim()}>
            {t('workspace.workflows.question.send')}
          </button>
        </form>
      )}
      {refused ? (
        <p className="wf-error" role="alert">
          {refused}
        </p>
      ) : null}
      <p className="wf-muted">
        {question.default != null
          ? t('workspace.workflows.question.expiresDefault', { when: expires, answer: question.default })
          : t('workspace.workflows.review.expires', { when: expires })}
      </p>
    </section>
  );
}

function RunDetail({
  detail,
  statusLabel,
  onOpenDocument,
  canRerun = false,
  onRerunFrom,
}: {
  detail: WorkflowRunDetail;
  statusLabel: (s: string) => string;
  onOpenDocument?: (conversationId: string, artifactId: string) => void;
  canRerun?: boolean;
  /// Run the workflow again from this top-level step, reusing what came before.
  onRerunFrom?: (stepId: string) => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const started = useMemo(() => fmt.timeAgo(detail.run.startedAt), [fmt, detail.run.startedAt]);
  const docs = savedDocuments(detail);
  const nothingNew = nothingNewStop(detail);
  return (
    <section className="grp wf-run-detail" aria-label={t('workspace.workflows.runDetail.title')}>
      <div className="grp-label">
        {t('workspace.workflows.runDetail.heading', {
          status: nothingNew ? t('workspace.workflows.run.nothingNew') : statusLabel(detail.run.status),
          when: started,
        })}
      </div>
      {nothingNew ? (
        <p className="wf-muted" role="status">
          {nothingNew.stepId
            ? t('workspace.workflows.runDetail.nothingNewAt', { step: nothingNew.stepId })
            : t('workspace.workflows.run.nothingNew')}
        </p>
      ) : null}
      {/* A stop is the user's choice, not an error; the heading already says it. */}
      {detail.run.error && detail.run.status !== 'stopped' ? (
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
          <RunStepRow
            key={step.id}
            step={step}
            statusLabel={statusLabel}
            onRerun={onRerunFrom && step.iteration == null ? () => onRerunFrom(step.stepId) : undefined}
            canRerun={canRerun}
          />
        ))}
      </ul>
    </section>
  );
}

function RunStepRow({
  step,
  statusLabel,
  onRerun,
  canRerun = false,
}: {
  step: WorkflowRunStep;
  statusLabel: (s: string) => string;
  /// Offered on top-level steps: run again from here.
  onRerun?: () => void;
  canRerun?: boolean;
}) {
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
          {usedModelId(step.output) ? <span className="wf-muted wf-step-model">{usedModelId(step.output)}</span> : null}
          {conditionText(step) ? (
            <span className="wf-muted wf-step-reason">{conditionText(step)}</span>
          ) : null}
          {ms != null ? <span className="wf-muted">{fmt.duration(ms)}</span> : null}
        </summary>
        {step.error ? <p className="wf-error">{step.error}</p> : null}
        <StepModelLine output={step.output} />
        {onRerun ? (
          <button
            type="button"
            className="btn ghost wf-rerun"
            disabled={!canRerun}
            aria-label={t('workspace.workflows.runDetail.rerunFromStep', { step: step.stepId })}
            onClick={onRerun}
          >
            {t('workspace.workflows.runDetail.rerunFrom')}
          </button>
        ) : null}
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

/** The model a summarize/agent step used, from its recorded output
 *  (`output.model`), and why it differs from the choice when it fell back
 *  (`output.modelNote`). Nothing for steps that recorded neither. */
/// The model id a summarize/agent step recorded, shown on the collapsed row.
function usedModelId(output: unknown): string | null {
  if (!output || typeof output !== 'object') return null;
  const used = (output as Record<string, unknown>).model;
  if (!used || typeof used !== 'object') return null;
  const model = (used as Record<string, unknown>).model;
  return typeof model === 'string' && model ? model : null;
}

/** A condition step's one-line reason (`output.text`), e.g. "Same as the last run.". */
function conditionText(step: WorkflowRunStep): string | null {
  const out = step.output;
  if (!out || typeof out !== 'object') return null;
  const record = out as Record<string, unknown>;
  return typeof record.passed === 'boolean' && typeof record.text === 'string' && record.text ? record.text : null;
}

function StepModelLine({ output }: { output: unknown }) {
  const t = useT();
  const [names, setNames] = useState<ProviderDescriptor[]>([]);
  const record = output && typeof output === 'object' ? (output as Record<string, unknown>) : null;
  const used = record?.model && typeof record.model === 'object' ? (record.model as Record<string, unknown>) : null;
  const provider = typeof used?.provider === 'string' ? used.provider : null;
  const model = typeof used?.model === 'string' ? used.model : null;
  const note = typeof record?.modelNote === 'string' && record.modelNote ? record.modelNote : null;
  const wantNames = provider !== null;
  useEffect(() => {
    if (!wantNames) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => listProviderDescriptors())
      .then((list) => {
        if (!cancelled) setNames(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wantNames]);
  if (!provider || !model) return null;
  const label = names.find((p) => p.id === provider)?.displayName ?? provider;
  return (
    <p className="wf-muted wf-model-used">
      {t('workspace.workflows.runDetail.model', { model, provider: label })}
      {note ? ` ${note}` : null}
    </p>
  );
}
