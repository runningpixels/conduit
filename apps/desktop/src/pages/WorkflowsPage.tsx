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

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { workflowRunStatus, type StatusState } from '../chat/statusTypes';
import { useLocale, useT } from '../i18n';
import { withInterfaceLanguage } from '../workflows/starterLanguage';
import { useExampleItems } from '../examples/useExampleItems';
import { ExampleChip } from '../examples/ExampleChip';
import { useFormatters } from '../i18n/formatters';
import { documentEditSummary } from '../workflows/documentEditSummary';
import { UndoUpdate } from '../workflows/UndoUpdate';
import { useConnectorNames } from '../workflows/useConnectorNames';
import { WorkflowCanvas } from '../workflows/canvas/WorkflowCanvas';
import { START_ID } from '../workflows/canvas/canvasModel';
import { readWorkflowView, writeWorkflowView, type WorkflowViewPref } from '../shell/uiPrefs';
import { MoreMenu, SummaryChips, WorkflowTabs, tabPanelId, tabButtonId, type WorkflowTab } from '../workflows/WorkflowViewParts';
import { WorkflowEditBar } from '../workflows/WorkflowEditBar';
import {
  connectorStepSummary,
  dataStepSummary,
  documentsStepSummary,
  exportedFile,
  exportStepSummary,
  memoryStepSummary,
  researchReport,
  researchStepSummary,
} from '../workflows/stepSummary';
import {
  createWorkflow,
  deleteWorkflow,
  draftWorkflow,
  draftWorkflowFromChat,
  cancelWorkflowDraft,
  getWorkflow,
  getWorkflowRun,
  listWorkflowResults,
  markWorkflowRunsSeen,
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
  WorkflowDraftResult,
  WorkflowRecord,
  WorkflowRun,
  WorkflowRunDetail,
  WorkflowQuestion,
  WorkflowReview,
  WorkflowReviewDecision,
  WorkflowResult,
  WorkflowRunStep,
  WorkflowStep,
  WorkflowSummary,
} from '../ipc/contracts';
import { PageEmpty, PageFrame, PageListItem } from '../shell/PageFrame';
import { describeStep, type InputLabels } from '../workflows/describeStep';
import { findStep, needsCollections, needsDocumentTarget, newStep, triggerNeedsFolder } from '../workflows/editorModel';
import { describeJsonError } from '../workflows/jsonError';
import { reviewText } from '../workflows/permissionText';
import { ResultView } from '../workflows/ResultView';
import { isUnread, primaryOutput } from '../workflows/results';
import { isNothingNew, nothingNewStop } from '../workflows/runOutcome';
import { formatNextRun, ScheduleSection } from '../workflows/ScheduleSection';
import { revealExportedFile, runTriggerLabel } from '../workflows/triggers';
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

/** The colour of a run's status word, written out so the stylesheet's dead-rule check sees the classes. */
const RUN_TONE: Record<string, string> = {
  completed: 'wfv-tone wfv-tone-ok',
  failed: 'wfv-tone wfv-tone-err',
  running: 'wfv-tone wfv-tone-warn',
  paused: 'wfv-tone wfv-tone-warn',
  stopped: 'wfv-tone wfv-tone-muted',
};

const NO_STEPS: WorkflowStep[] = [];

/// `draft` is the editor, for a new workflow (`workflowId: null`) or an
/// existing one. `json` is set while the JSON view is open.
type Mode =
  | { kind: 'view' }
  | { kind: 'new' }
  | { kind: 'draft'; workflowId: string | null; draft: WorkflowDraft; json: string | null; notes?: string[] };

/// A request from elsewhere in the app to draft a workflow: Home's "Automate"
/// chip (a description) or a chat's "Save as workflow" (a conversation).
/// `nonce` makes a second request for the same text count as a new one.
export type WorkflowDraftRequest =
  | { nonce: number; description: string; conversationId?: undefined }
  | { nonce: number; conversationId: string; description?: string };

/// Where Home, a toast or the rail sends the page: a workflow (with its waiting
/// panel in view), or the Results list on a run.
export type WorkflowsFocus =
  | { workflowId: string; runId?: string; nonce?: number; view?: undefined }
  | { view: 'results'; runId?: string; nonce?: number; workflowId?: undefined };

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
  onOpenDeck,
  onOpenDraft,
  onRestoreDocument,
  refreshKey,
  startNew = false,
  focus = null,
  draftRequest = null,
  onResultsSeen,
}: {
  onStatus: (message: string | StatusState) => void;
  /** Open a document a run saved, in its conversation's document panel. */
  onOpenDocument?: (conversationId: string, artifactId: string) => void;
  /** Open a deck an "Update a deck" step changed, in Slides. */
  onOpenDeck?: (deckId: string) => void;
  /** Open a draft an "Update a draft" step changed, in Writing. */
  onOpenDraft?: (draftId: string) => void;
  /** Put a deck or draft back to a history entry ("Undo this update"); reloads it if it is open. */
  onRestoreDocument?: (kind: 'deck' | 'draft', id: string, snapshotId: string) => Promise<void>;
  /** Changes when a scheduled run finishes elsewhere; the page re-reads. */
  refreshKey?: number;
  /** Open on the "new workflow" picker (Home's "New workflow"). */
  startNew?: boolean;
  /** Open on this workflow, with its waiting panel in view (Home's "Answer"/"Review"), or on the Results list. */
  focus?: WorkflowsFocus | null;
  /** Draft a workflow from a description or a chat as soon as the page opens. */
  draftRequest?: WorkflowDraftRequest | null;
  /** Runs were marked seen here, so the shell can refresh its unread dot. */
  onResultsSeen?: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const { isExample } = useExampleItems();
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
  /// The left column shows the workflows or the Results inbox. Component state only.
  const [view, setView] = useState<'workflows' | 'results'>(focus?.view === 'results' ? 'results' : 'workflows');
  const [results, setResults] = useState<WorkflowResult[]>([]);
  const [selectedResultId, setSelectedResultId] = useState<string | null>(
    focus?.view === 'results' ? (focus.runId ?? null) : null,
  );
  /// The open workflow's tab, the node selected in its Steps tab (a step id or the start node), and the
  /// result picked in its Results tab. Component state only; a different workflow starts over.
  const [tab, setTab] = useState<WorkflowTab>('steps');
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [resultSel, setResultSel] = useState<string | null>(null);
  const [stepsPref, setStepsPref] = useState<WorkflowViewPref>(() => readWorkflowView());
  /// A run to open on its workflow page once that workflow has loaded ("Run details" from Results).
  const pendingRunRef = useRef<string | null>(null);
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

  /// Drafting from a description: one request at a time. Cancel does not stop
  /// the model on the other side; it ignores the answer, so the page stays
  /// usable and nothing opens when the answer arrives.
  const draftToken = useRef(0);
  const handledRequest = useRef<number | null>(null);
  const [describeText, setDescribeText] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);

  const runDraft = useCallback(
    async (request: () => Promise<WorkflowDraftResult>) => {
      const token = ++draftToken.current;
      setDrafting(true);
      setDraftError(null);
      try {
        const result = await request();
        if (token !== draftToken.current || !mounted.current) return;
        setDrafting(false);
        setDescribeText('');
        setEditError(null);
        setProblems(result.problems);
        setMode({
          kind: 'draft',
          workflowId: null,
          draft: { name: result.name, description: result.description, definition: result.definition },
          json: null,
          notes: result.notes,
        });
      } catch (e) {
        if (token !== draftToken.current || !mounted.current) return;
        setDrafting(false);
        setDraftError(errorText(e));
      }
    },
    [],
  );

  function describeIt() {
    const description = describeText.trim();
    if (!description || drafting) return;
    void runDraft(() => draftWorkflow(description));
  }

  function cancelDraft() {
    draftToken.current += 1;
    setDrafting(false);
    // Stop the model call too; the token above already drops a late answer.
    void Promise.resolve()
      .then(() => cancelWorkflowDraft())
      .catch(() => {});
  }

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!draftRequest || handledRequest.current === draftRequest.nonce) return;
    handledRequest.current = draftRequest.nonce;
    setMode({ kind: 'new' });
    setDescribeText(draftRequest.description ?? '');
    const { conversationId, description } = draftRequest;
    void runDraft(() =>
      conversationId ? draftWorkflowFromChat(conversationId, description?.trim() || undefined) : draftWorkflow(description ?? ''),
    );
  }, [draftRequest, runDraft]);

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

  /// Everything the workflows produced, newest first (the Results list and its count).
  const refreshResults = useCallback(async () => {
    try {
      const next = await listWorkflowResults({ limit: 100 });
      if (mounted.current && Array.isArray(next)) setResults(next);
    } catch {
      // The list stays as it was; the next refresh tries again.
    }
  }, []);

  useEffect(() => {
    void refreshResults();
  }, [refreshResults]);

  // A scheduled run finished or paused: re-read the list, and the selected workflow's runs.
  useEffect(() => {
    if (!refreshKey) return;
    void refreshList();
    void refreshResults();
    if (selectedId) void listWorkflowRuns(selectedId, 20).then(setRuns, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Home sent us to a particular workflow (or to Results): show it, not the previous selection.
  useEffect(() => {
    if (!focus) return;
    setMode({ kind: 'view' });
    if (focus.view === 'results') {
      setView('results');
      setSelectedResultId(focus.runId ?? null);
      void refreshResults();
    } else {
      setView('workflows');
      setSelectedId(focus.workflowId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.view, focus?.workflowId, focus?.runId, focus?.nonce]);

  /// Mark runs as seen: at once in what is on screen, then in the backend.
  function markSeen(runIds: string[]) {
    const ids = new Set(runIds);
    const seenAt = new Date().toISOString();
    const stamp = (run: WorkflowRun) => (ids.has(run.id) && !run.seenAt ? { ...run, seenAt } : run);
    setRuns((current) => current.map(stamp));
    setResults((current) => current.map((r) => ({ ...r, run: stamp(r.run) })));
    void Promise.resolve()
      .then(() => markWorkflowRunsSeen(runIds))
      .then(() => onResultsSeen?.())
      .catch(() => {});
  }

  function markAllSeen() {
    const seenAt = new Date().toISOString();
    setRuns((current) => current.map((r) => (r.seenAt ? r : { ...r, seenAt })));
    setResults((current) => current.map((r) => (r.run.seenAt ? r : { ...r, run: { ...r.run, seenAt } })));
    void Promise.resolve()
      .then(() => markWorkflowRunsSeen([]))
      .then(() => onResultsSeen?.())
      .catch(() => {});
  }

  /// Open a run on its workflow page, in the Runs tab with its steps showing.
  function showRunDetails(workflowId: string, runId: string) {
    setView('workflows');
    setMode({ kind: 'view' });
    if (workflowId === selectedId) {
      void openRunInTab(runId);
    } else {
      pendingRunRef.current = runId;
      setSelectedId(workflowId);
    }
  }

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
    setTab('steps');
    setSelectedStep(null);
    setResultSel(null);
    void Promise.all([getWorkflow(selectedId), listWorkflowRuns(selectedId, 20)]).then(
      ([nextRecord, nextRuns]) => {
        if (cancelled) return;
        setRecord(nextRecord);
        setRuns(nextRuns);
        const pending = pendingRunRef.current;
        pendingRunRef.current = null;
        if (pending) {
          void getWorkflowRun(pending).then(
            (detail) => {
              if (cancelled) return;
              setOpenRun(detail);
              setTab('runs');
            },
            () => {},
          );
        }
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

  async function startFrom(starterWorkflow: StarterWorkflow) {
    const starter = { ...starterWorkflow, definition: withInterfaceLanguage(starterWorkflow.definition, locale) };
    // A starter that changes a deck or draft cannot be saved until the user
    // picks which one, so it opens in the editor with that step flagged.
    if (needsDocumentTarget(starter.definition) || needsCollections(starter.definition) || triggerNeedsFolder(starter.definition)) {
      setEditError(null);
      setMode({
        kind: 'draft',
        workflowId: null,
        draft: {
          name: t(starter.nameKey),
          description: t(starter.blurbKey),
          definition: starter.definition,
        },
        json: null,
      });
      return;
    }
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
      // Leaves by itself after ~10 s: the run list keeps the detail.
      onStatus(
        detail.run.status === 'completed'
          ? workflowRunStatus(t('workspace.workflows.status.runCompleted', { name: record.name }), 'success')
          : detail.run.status === 'stopped'
            ? workflowRunStatus(t('workspace.workflows.status.runStopped', { name: record.name }), 'success')
            : workflowRunStatus(t('workspace.workflows.status.runFailed', { name: record.name }), 'error'),
      );
      setRuns(await listWorkflowRuns(record.id, 20));
      await refreshList();
      void refreshResults();
      onResultsSeen?.();
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

  async function openRunDetail(runId: string): Promise<boolean> {
    try {
      setOpenRun(await getWorkflowRun(runId));
      return true;
    } catch (e) {
      onStatus(t('workspace.workflows.status.loadFailed', { error: errorText(e) }));
      return false;
    }
  }

  /// Open a run and switch to the Runs tab once it is loaded (so the tab does not pick the newest first).
  async function openRunInTab(runId: string) {
    if (await openRunDetail(runId)) setTab('runs');
  }

  // The Runs tab always has a run open: the newest, until one is picked. A run
  // in progress is followed by the poll instead.
  useEffect(() => {
    if (tab !== 'runs' || openRun || running || !runs[0]) return;
    void openRunDetail(runs[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, openRun, running, runs]);

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

  function cancelEdit() {
    setMode({ kind: 'view' });
    setEditError(null);
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

  const runWord = (r: WorkflowRun) => (isNothingNew(r) ? t('workspace.workflows.run.nothingNew') : statusLabel(r.status));
  const runTone = (r: WorkflowRun) => (isNothingNew(r) ? RUN_TONE.stopped : (RUN_TONE[r.status] ?? RUN_TONE.stopped));
  const stepNames = useConnectorNames(record?.definition.steps ?? NO_STEPS);
  /// This workflow's runs that saved something, for its Results tab.
  const wfResults = useMemo(() => runs.filter((r) => primaryOutput(r) != null), [runs]);

  const effectiveView = !loaded || summaries.length > 0 ? view : 'workflows';
  // A result picked in the Results tab is seen once it is on screen.
  const shownWfResult =
    tab === 'results' && mode.kind === 'view' && effectiveView === 'workflows' && record
      ? (wfResults.find((r) => r.id === resultSel) ?? wfResults[0] ?? null)
      : null;
  const shownWfResultId = shownWfResult?.id ?? null;
  const shownWfResultUnread = shownWfResult != null && isUnread(shownWfResult);
  useEffect(() => {
    if (shownWfResultId && shownWfResultUnread) markSeen([shownWfResultId]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownWfResultId, shownWfResultUnread]);
  const unreadCount = results.filter((r) => isUnread(r.run)).length;
  const shownResult = results.find((r) => r.run.id === selectedResultId) ?? results[0] ?? null;
  // Seeing a result in the inbox marks it seen.
  const shownResultRunId = effectiveView === 'results' && loaded ? (shownResult?.run.id ?? null) : null;
  const shownResultUnread = shownResult != null && isUnread(shownResult.run);
  useEffect(() => {
    if (shownResultRunId && shownResultUnread) markSeen([shownResultRunId]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownResultRunId, shownResultUnread]);

  // The newest run of the open workflow is "seen" once its result is on the page.
  const pageLatest = runs.find((r) => !isLive(r.status) && (primaryOutput(r) != null || r.status === 'failed')) ?? null;
  const pageLatestId = effectiveView === 'workflows' && mode.kind === 'view' && record ? (pageLatest?.id ?? null) : null;
  const pageLatestUnread = pageLatest != null && isUnread(pageLatest);
  useEffect(() => {
    if (pageLatestId && pageLatestUnread) markSeen([pageLatestId]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageLatestId, pageLatestUnread]);

  const toggle = (
    <div className="wf-view-toggle" role="group" aria-label={t('workspace.workflows.results.viewLabel')}>
      <button
        type="button"
        className={`wf-view-btn${effectiveView === 'workflows' ? ' active' : ''}`}
        aria-pressed={effectiveView === 'workflows'}
        onClick={() => setView('workflows')}
      >
        {t('workspace.workflows.results.tabWorkflows')}
      </button>
      <button
        type="button"
        className={`wf-view-btn${effectiveView === 'results' ? ' active' : ''}`}
        aria-pressed={effectiveView === 'results'}
        onClick={() => {
          setView('results');
          void refreshResults();
        }}
      >
        {unreadCount > 0
          ? t('workspace.workflows.results.tabResultsCount', { count: unreadCount })
          : t('workspace.workflows.results.tabResults')}
      </button>
    </div>
  );

  const resultsHeader = (
    <>
      {toggle}
      {effectiveView === 'results' && unreadCount > 0 ? (
        <button type="button" className="btn ghost wf-mark-all" onClick={markAllSeen}>
          {t('workspace.workflows.results.markAll')}
        </button>
      ) : null}
    </>
  );

  const resultRows = results.map(({ run: r, workflowName }) => {
    const primary = primaryOutput(r);
    return (
      <PageListItem
        key={r.id}
        selected={shownResult?.run.id === r.id}
        onSelect={() => setSelectedResultId(r.id)}
        title={primary ? primary.title : t('workspace.workflows.result.failedTitle', { name: workflowName })}
        status={
          isUnread(r) ? (
            <span className="wf-unread-dot" role="img" aria-label={t('workspace.workflows.results.unread')} />
          ) : undefined
        }
        meta={t('workspace.workflows.result.eyebrow', { name: workflowName, when: fmt.timeAgo(r.finishedAt ?? r.startedAt) })}
      />
    );
  });

  const list = summaries.map((w) => (
    <PageListItem
      key={w.id}
      selected={mode.kind === 'view' && w.id === selectedId}
      onSelect={() => {
        setMode({ kind: 'view' });
        setSelectedId(w.id);
      }}
      title={
        isExample('workflow', w.id) ? (
          <>
            {w.name}
            <ExampleChip />
          </>
        ) : (
          w.name
        )
      }
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

  /// The editor takes the whole page (no workflow list); the open workflow fills the pane.
  let editing = false;
  let viewing = false;
  let detail;
  if (!loaded) {
    detail = <div className="artifact-skeleton" aria-hidden="true" />;
  } else if (effectiveView === 'results') {
    detail = shownResult ? (
      <div className="wf-detail">
        <ResultView
          key={shownResult.run.id}
          run={shownResult.run}
          workflowName={shownResult.workflowName}
          onOpenDocument={onOpenDocument}
          onOpenDeck={onOpenDeck}
          onOpenDraft={onOpenDraft}
          onRunDetails={() => showRunDetails(shownResult.run.workflowId, shownResult.run.id)}
        />
      </div>
    ) : (
      <PageEmpty title={t('workspace.workflows.results.empty')} />
    );
  } else if (mode.kind === 'new' || (summaries.length === 0 && mode.kind !== 'draft')) {
    detail = (
      <StarterPicker
        describe={
          <DescribeBox
            text={describeText}
            drafting={drafting}
            error={draftError}
            onText={setDescribeText}
            onDraft={describeIt}
            onCancel={cancelDraft}
          />
        }
        empty={summaries.length === 0}
        busy={busy}
        existing={summaries}
        onOpenExisting={(id) => {
          setMode({ kind: 'view' });
          setView('workflows');
          setSelectedId(id);
        }}
        onPick={(starter) => void startFrom(starter)}
        onBlank={startBlank}
        onCancel={summaries.length > 0 ? () => setMode({ kind: 'view' }) : undefined}
      />
    );
  } else if (mode.kind === 'draft') {
    editing = true;
    detail = (
      <section className="wfv-edit" aria-label={t('workspace.workflows.edit.title')}>
        <WorkflowEditBar
          name={mode.draft.name}
          onName={(name) => setMode({ ...mode, draft: { ...mode.draft, name } })}
          problems={problems}
          json={mode.json != null}
          onToggleJson={toggleJson}
          onCancel={cancelEdit}
          onSave={() => void saveDraft()}
          busy={busy}
        />
        {editError ? (
          <p className="wf-error wfv-edit-error" role="alert">
            {editError}
          </p>
        ) : null}
        {mode.json == null ? (
          <div className="wfv-edit-body">
            <WorkflowEditor
              draft={mode.draft}
              onChange={(draft) => setMode({ ...mode, draft })}
              problems={problems}
              notes={mode.notes}
            />
          </div>
        ) : (
          <div className="wfv-edit-body wfv-edit-json">
            <label className="wf-field">
              <span>{t('workspace.workflows.edit.definition')}</span>
              <textarea
                className="mem-input wf-json wfv-json"
                spellCheck={false}
                value={mode.json}
                onChange={(e) => setMode({ ...mode, json: e.target.value })}
              />
            </label>
          </div>
        )}
      </section>
    );
  } else if (!record) {
    detail = <div className="artifact-skeleton" aria-hidden="true" />;
  } else {
    viewing = true;
    const workflowInputs = record.definition.inputs ?? [];
    const inputLabels = Object.fromEntries(workflowInputs.map((i) => [i.id, i.label]));
    const nextRunAt = summaries.find((w) => w.id === record.id)?.nextRunAt;
    // The newest run that ended with something to show (or failed).
    const latest = runs.find((r) => !isLive(r.status) && (primaryOutput(r) != null || r.status === 'failed')) ?? null;
    const recent = runs.slice(0, 3);
    const resultRun = wfResults.find((r) => r.id === resultSel) ?? wfResults[0] ?? null;
    const canvasRun = openRun && openRun.run.workflowId === record.id ? openRun : null;
    const waitingStepId = openRun
      ? (reviews.find((r) => r.runId === openRun.run.id)?.stepId ??
        questions.find((q) => q.runId === openRun.run.id)?.stepId ??
        null)
      : null;
    const branchy = record.definition.steps.some((s) => s.type === 'for_each' || s.type === 'condition' || s.type === 'agent');
    const stepsView = stepsPref === 'auto' ? (branchy ? 'canvas' : 'list') : stepsPref;
    const chooseStepsView = (next: 'canvas' | 'list') => {
      setStepsPref(next);
      writeWorkflowView(next);
    };
    const runDuration = (r: WorkflowRun) => {
      const ms = durationMs(r.startedAt, r.finishedAt);
      return ms != null ? fmt.duration(ms) : null;
    };

    const stepsToggle = (
      <div className="wf-view-toggle" role="group" aria-label={t('workspace.workflows.canvas.viewLabel')}>
        <button
          type="button"
          className={`wf-view-btn${stepsView === 'canvas' ? ' active' : ''}`}
          aria-pressed={stepsView === 'canvas'}
          onClick={() => chooseStepsView('canvas')}
        >
          {t('workspace.workflows.canvas.viewCanvas')}
        </button>
        <button
          type="button"
          className={`wf-view-btn${stepsView === 'list' ? ' active' : ''}`}
          aria-pressed={stepsView === 'list'}
          onClick={() => chooseStepsView('list')}
        >
          {t('workspace.workflows.canvas.viewList')}
        </button>
      </div>
    );

    /// The permission reviews and "Ask me" questions this workflow is waiting on (one run's, when given).
    const waiting = (runId?: string) => (
      <>
        {reviews
          .filter((review) => review.workflowId === record.id && (!runId || review.runId === runId))
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
          .filter((question) => question.workflowId === record.id && (!runId || question.runId === runId))
          .map((question) => (
            <QuestionPanel
              key={question.runId}
              question={question}
              expires={formatNextRun(question.expiresAt, fmt.locale)}
              onAnswer={(text) => reply(question, text)}
            />
          ))}
      </>
    );

    const backButton = (
      <button type="button" className="btn ghost wfv-back" onClick={() => setSelectedStep(null)}>
        <span aria-hidden="true">←</span> {t('workspace.workflows.view.back')}
      </button>
    );

    /// The column beside the steps: the start node's values and schedule, a step's details, or the latest run.
    const renderPanel = (id: string | null, details: ReactNode) => {
      if (id === START_ID) {
        return (
          <div className="wfv-panel-body">
            {backButton}
            <h4 className="wfv-h">{t('workspace.workflows.canvas.start')}</h4>
            {workflowInputs.length > 0 ? (
              <section className="wfv-section" aria-label={t('workspace.workflows.view.nextRunValues')}>
                <h5 className="wfv-h wfv-h-sub">{t('workspace.workflows.view.nextRunValues')}</h5>
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
              </section>
            ) : null}
            <ScheduleSection
              workflowId={record.id}
              refreshKey={refreshKey}
              definitionVersion={record.version}
              trigger={record.definition.trigger}
              folder={record.definition.folder}
              onStatus={onStatus}
              onChanged={() => void refreshList()}
            />
          </div>
        );
      }
      if (id) {
        return (
          <div className="wfv-panel-body">
            {backButton}
            {details}
          </div>
        );
      }
      return (
        <div className="wfv-panel-body">
          {waiting()}
          <section className="wfv-section" aria-label={t('workspace.workflows.view.latestRun')}>
            <h4 className="wfv-h">{t('workspace.workflows.view.latestRun')}</h4>
            {latest ? (
              <>
                <p className="wfv-statusline">
                  <span className={runTone(latest)}>
                    <span className="wfv-dot" aria-hidden="true" />
                    {runWord(latest)}
                  </span>
                  <span>{fmt.timeAgo(latest.startedAt)}</span>
                  {runDuration(latest) ? <span>{runDuration(latest)}</span> : null}
                </p>
                <ResultView
                  key={latest.id}
                  run={latest}
                  workflowName={record.name}
                  compact
                  onOpenDocument={onOpenDocument}
                  onOpenDeck={onOpenDeck}
                  onOpenDraft={onOpenDraft}
                  onRunDetails={() => void openRunInTab(latest.id)}
                />
              </>
            ) : (
              <p className="wf-muted">{t('workspace.workflows.runs.none')}</p>
            )}
          </section>
          {recent.length > 0 ? (
            <section className="wfv-section" aria-label={t('workspace.workflows.runs.title')}>
              <h4 className="wfv-h">{t('workspace.workflows.runs.title')}</h4>
              <ul className="wfv-recent">
                {recent.map((r) => (
                  <li key={r.id}>
                    <button type="button" className="wfv-recent-row" onClick={() => void openRunInTab(r.id)}>
                      <span className={runTone(r)}>{runWord(r)}</span>
                      <span>{fmt.timeAgo(r.startedAt)}</span>
                      {runDuration(r) ? <span>{runDuration(r)}</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className="btn ghost wfv-all-runs" onClick={() => setTab('runs')}>
                {t('workspace.workflows.view.allRuns')}
              </button>
            </section>
          ) : null}
        </div>
      );
    };

    detail = (
      <div className="wfv" ref={detailRef}>
        <header className="wfv-head">
          <div className="wfv-title">
            <h3 className="wfv-name">{record.name}</h3>
            {record.description ? <p className="wfv-description">{record.description}</p> : null}
          </div>
          <div className="wfv-actions">
            <button
              type="button"
              className="btn"
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
            <MoreMenu deleteDisabled={busy || running} onDelete={() => void remove()} />
            <button type="button" className="btn primary" onClick={() => void run()} disabled={running || busy}>
              {liveRun?.status === 'paused'
                ? t('workspace.workflows.run.paused')
                : running
                  ? t('workspace.workflows.run.running')
                  : t('workspace.workflows.run.now')}
            </button>
            {running ? (
              <button type="button" className="btn" onClick={() => void stop()} disabled={stopping}>
                {stopping ? t('workspace.workflows.run.stopping') : t('workspace.workflows.run.stop')}
              </button>
            ) : null}
          </div>
        </header>

        <SummaryChips
          definition={record.definition}
          nextRunAt={nextRunAt}
          onOpenStart={() => {
            setTab('steps');
            setSelectedStep(START_ID);
          }}
        />

        <WorkflowTabs tab={tab} onTab={setTab} runCount={runs.length} resultCount={wfResults.length} />

        {tab === 'steps' ? (
          <div role="tabpanel" id={tabPanelId('steps')} aria-labelledby={tabButtonId('steps')} className="wfv-pane wfv-pane-steps">
            {stepsView === 'canvas' ? (
              <WorkflowCanvas
                definition={record.definition}
                labels={inputLabels}
                connectorNames={stepNames}
                run={canvasRun}
                waitingStepId={waitingStepId}
                selectedId={selectedStep}
                onSelect={setSelectedStep}
                toolbar={stepsToggle}
                panel={(node, details) => renderPanel(node?.id ?? null, details)}
              />
            ) : (
              <div className="wfv-listview">
                <div className="wfv-listview-steps">
                  {stepsToggle}
                  <StepList steps={record.definition.steps} labels={inputLabels} connectorNames={stepNames} />
                </div>
                <aside className="wfv-panel" aria-label={t('workspace.workflows.canvas.inspector')}>
                  {renderPanel(selectedStep === START_ID ? START_ID : null, null)}
                </aside>
              </div>
            )}
          </div>
        ) : tab === 'runs' ? (
          <div role="tabpanel" id={tabPanelId('runs')} aria-labelledby={tabButtonId('runs')} className="wfv-pane wfv-pane-split">
            <div className="wfv-side">
              {runs.length === 0 ? (
                <p className="wf-muted">{t('workspace.workflows.runs.none')}</p>
              ) : (
                <ul className="wfv-runlist" aria-label={t('workspace.workflows.runs.title')}>
                  {runs.map((r) => (
                    <li key={r.id}>
                      <button
                        type="button"
                        className="wfv-run-row"
                        aria-current={openRun?.run.id === r.id ? 'true' : undefined}
                        onClick={() => void openRunDetail(r.id)}
                      >
                        <span className="wfv-run-top">
                          <span className={runTone(r)}>{runWord(r)}</span>
                          <span>{fmt.timeAgo(r.startedAt)}</span>
                          {primaryOutput(r) != null && isUnread(r) ? (
                            <span className="wf-unread-dot" role="img" aria-label={t('workspace.workflows.results.unread')} />
                          ) : null}
                        </span>
                        <span className="wfv-run-sub">
                          {[runTriggerLabel(r, t), runDuration(r)].filter(Boolean).join(' · ')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="wfv-main">
              {openRun ? (
                <>
                  {waiting(openRun.run.id)}
                  <RunDetail
                    detail={openRun}
                    steps={record.definition.steps}
                    labels={inputLabels}
                    statusLabel={statusLabel}
                    onOpenDocument={onOpenDocument}
                    onOpenDeck={onOpenDeck}
                    onOpenDraft={onOpenDraft}
                    onRestoreDocument={onRestoreDocument}
                    canRerun={!running && !busy}
                    onRerunFrom={(stepId) => void run(() => rerunWorkflowFrom(openRun.run.id, stepId))}
                  />
                </>
              ) : null}
            </div>
          </div>
        ) : (
          <div role="tabpanel" id={tabPanelId('results')} aria-labelledby={tabButtonId('results')} className="wfv-pane wfv-pane-split">
            {resultRun ? (
              <>
                <div className="wfv-side">
                  <ul className="wfv-runlist" aria-label={t('workspace.workflows.results.tabResults')}>
                    {wfResults.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          className="wfv-run-row"
                          aria-current={resultRun.id === r.id ? 'true' : undefined}
                          onClick={() => setResultSel(r.id)}
                        >
                          <span className="wfv-run-top">
                            <span className="wfv-result-title">{primaryOutput(r)?.title}</span>
                            {isUnread(r) ? (
                              <span className="wf-unread-dot" role="img" aria-label={t('workspace.workflows.results.unread')} />
                            ) : null}
                          </span>
                          <span className="wfv-run-sub">{fmt.timeAgo(r.finishedAt ?? r.startedAt)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="wfv-main">
                  <ResultView
                    key={resultRun.id}
                    run={resultRun}
                    workflowName={record.name}
                    onOpenDocument={onOpenDocument}
                    onOpenDeck={onOpenDeck}
                    onOpenDraft={onOpenDraft}
                    onRunDetails={() => void openRunInTab(resultRun.id)}
                  />
                </div>
              </>
            ) : (
              <p className="wfv-empty">{t('workspace.workflows.view.resultsNone')}</p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <PageFrame
      className={editing ? 'wf-page is-editing' : viewing ? 'wf-page is-viewing' : 'wf-page'}
      title={t('workspace.workflows.page.title')}
      subtitle={t('workspace.workflows.page.subtitle')}
      about={t('workspace.workflows.page.about')}
      actions={summaries.length > 0 && !editing ? newButton : undefined}
      list={summaries.length > 0 && !editing ? (effectiveView === 'results' ? resultRows : list) : undefined}
      listHeader={summaries.length > 0 && !editing ? resultsHeader : undefined}
      listLabel={effectiveView === 'results' ? t('workspace.workflows.results.tabResults') : t('workspace.workflows.page.title')}
    >
      {detail}
    </PageFrame>
  );
}

/// "Describe a workflow": a few words in, an unsaved draft out.
function DescribeBox({
  text,
  drafting,
  error,
  onText,
  onDraft,
  onCancel,
}: {
  text: string;
  drafting: boolean;
  error: string | null;
  onText: (text: string) => void;
  onDraft: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className="wf-describe">
      <label className="wf-field">
        <span className="grp-label">{t('workspace.workflows.describe.title')}</span>
        <textarea
          className="mem-input"
          rows={3}
          value={text}
          disabled={drafting}
          placeholder={t('workspace.workflows.describe.placeholder')}
          onChange={(e) => onText(e.target.value)}
        />
      </label>
      {drafting ? (
        <div className="wf-describe-progress">
          <p className="wf-muted" role="status">
            {t('workspace.workflows.describe.drafting')}
          </p>
          <button type="button" className="btn ghost" onClick={onCancel}>
            {t('common.actions.cancel')}
          </button>
        </div>
      ) : (
        <div className="mem-actions">
          <button type="button" className="btn primary" disabled={text.trim() === ''} onClick={onDraft}>
            {t('workspace.workflows.describe.draft')}
          </button>
        </div>
      )}
      {error ? (
        <p className="wf-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function StarterPicker({
  describe,
  empty,
  busy,
  existing,
  onOpenExisting,
  onPick,
  onBlank,
  onCancel,
}: {
  describe: ReactNode;
  empty: boolean;
  busy: boolean;
  /// The workflows already saved: a starter with the same name asks before making another.
  existing: WorkflowSummary[];
  onOpenExisting: (workflowId: string) => void;
  onPick: (starter: StarterWorkflow) => void;
  onBlank: () => void;
  onCancel?: () => void;
}) {
  const t = useT();
  /// The starter whose name matches a saved workflow, until the user chooses.
  const [duplicate, setDuplicate] = useState<StarterWorkflow | null>(null);
  const pick = (starter: StarterWorkflow) => {
    if (existing.some((w) => w.name === t(starter.nameKey))) setDuplicate(starter);
    else onPick(starter);
  };
  const cards = (
    <ul className="wf-starters">
      {STARTER_WORKFLOWS.map((starter) => {
        const match = duplicate?.id === starter.id ? existing.find((w) => w.name === t(starter.nameKey)) : undefined;
        return (
          <li key={starter.id} className="wf-starter">
            <p className="wf-starter-name">{t(starter.nameKey)}</p>
            <p className="wf-muted">{t(starter.blurbKey)}</p>
            {match ? (
              <div className="wf-starter-exists" role="status">
                <p className="wf-muted">{t('workspace.workflows.starter.exists', { name: match.name })}</p>
                <div className="mem-actions">
                  <button type="button" className="btn" onClick={() => onOpenExisting(match.id)}>
                    {t('workspace.workflows.starter.openExisting')}
                  </button>
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    onClick={() => {
                      setDuplicate(null);
                      onPick(starter);
                    }}
                  >
                    {t('workspace.workflows.starter.makeCopy')}
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn ghost" disabled={busy} onClick={() => pick(starter)}>
                {t('workspace.workflows.starter.use')}
              </button>
            )}
          </li>
        );
      })}
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
        actionClassName="wf-empty-action"
        action={
          <>
            {describe}
            {cards}
          </>
        }
      />
    );
  }
  return (
    <section aria-label={t('workspace.workflows.starter.title')}>
      {describe}
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

function StepList({
  steps,
  labels,
  connectorNames,
  scope = steps,
}: {
  steps: WorkflowStep[];
  labels: InputLabels;
  /// The top-level steps, so a loop can name the step it reads (a nested list passes them on).
  scope?: WorkflowStep[];
  /// Set by a nested list; the top-level list looks the names up.
  connectorNames?: Record<string, string>;
}) {
  const t = useT();
  const looked = useConnectorNames(steps, connectorNames !== undefined);
  const names = connectorNames ?? looked;
  return (
    <ol className="wf-steps">
      {steps.map((step) => (
        <li key={step.id}>
          <span>{describeStep(step, t, labels, names, scope)}</span>
          {step.onError === 'skip' ? <span className="wf-flag">{t('workspace.workflows.step.continuesOnError')}</span> : null}
          {step.type === 'for_each' ? <StepList steps={step.steps} labels={labels} connectorNames={names} scope={scope} /> : null}
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
  steps = [],
  labels = {},
  statusLabel,
  onOpenDocument,
  onOpenDeck,
  onOpenDraft,
  onRestoreDocument,
  canRerun = false,
  onRerunFrom,
}: {
  detail: WorkflowRunDetail;
  /// The workflow's steps and input names, so each row can say what its step does.
  steps?: WorkflowStep[];
  labels?: InputLabels;
  statusLabel: (s: string) => string;
  onOpenDocument?: (conversationId: string, artifactId: string) => void;
  onOpenDeck?: (deckId: string) => void;
  onOpenDraft?: (draftId: string) => void;
  onRestoreDocument?: (kind: 'deck' | 'draft', id: string, snapshotId: string) => Promise<void>;
  canRerun?: boolean;
  /// Run the workflow again from this top-level step, reusing what came before.
  onRerunFrom?: (stepId: string) => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const started = useMemo(() => fmt.timeAgo(detail.run.startedAt), [fmt, detail.run.startedAt]);
  const connectorNames = useConnectorNames(steps);
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
      {runTriggerLabel(detail.run, t) ? <p className="wf-muted wf-run-trigger">{runTriggerLabel(detail.run, t)}</p> : null}
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
            description={(() => {
              const def = findStep(steps, step.stepId);
              return def ? describeStep(def, t, labels, connectorNames, steps) : null;
            })()}
            statusLabel={statusLabel}
            onOpenDocument={onOpenDocument}
            onOpenDeck={onOpenDeck}
            onOpenDraft={onOpenDraft}
            onRestoreDocument={onRestoreDocument}
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
  description = null,
  statusLabel,
  onOpenDocument,
  onOpenDeck,
  onOpenDraft,
  onRestoreDocument,
  onRerun,
  canRerun = false,
}: {
  step: WorkflowRunStep;
  /// What the step does (its line on the workflow page); its id when unknown.
  description?: string | null;
  statusLabel: (s: string) => string;
  onOpenDocument?: (conversationId: string, artifactId: string) => void;
  onOpenDeck?: (deckId: string) => void;
  onOpenDraft?: (draftId: string) => void;
  onRestoreDocument?: (kind: 'deck' | 'draft', id: string, snapshotId: string) => Promise<void>;
  /// Offered on top-level steps: run again from here.
  onRerun?: () => void;
  canRerun?: boolean;
}) {
  const t = useT();
  const fmt = useFormatters();
  const ms = durationMs(step.startedAt, step.finishedAt);
  const label = description ?? step.stepId;
  const name =
    step.iteration != null ? t('workspace.workflows.runDetail.iteration', { step: label, n: step.iteration + 1 }) : label;
  const dataSummary =
    dataStepSummary(step, t, (bytes) => fmt.size(bytes)) ??
    researchStepSummary(step, t) ??
    documentsStepSummary(step, t) ??
    connectorStepSummary(step, t) ??
    exportStepSummary(step, t, (bytes) => fmt.size(bytes)) ??
    memoryStepSummary(step, t);
  // A file read has the same output shape, but only an export is shown in the folder.
  const exported = (step.input as { type?: string } | null)?.type === 'export_file' ? exportedFile(step) : null;
  const report = researchReport(step);
  const edit = documentEditSummary(step, t);
  const open = edit?.target
    ? edit.target.kind === 'deck'
      ? onOpenDeck && (() => onOpenDeck(edit.target!.id))
      : onOpenDraft && (() => onOpenDraft(edit.target!.id))
    : undefined;
  return (
    <li className={step.iteration != null ? 'wf-run-step wf-run-step-nested' : 'wf-run-step'}>
      <details>
        <summary>
          <span className={STATUS_CLASS[step.status] ?? 'wf-status'}>{statusLabel(step.status)}</span>
          <span className="wf-step-name">{name}</span>
          {description ? <span className="wf-muted wf-step-id">{step.stepId}</span> : null}
          {usedModelId(step.output) ? <span className="wf-muted wf-step-model">{usedModelId(step.output)}</span> : null}
          {conditionText(step) ? (
            <span className="wf-muted wf-step-reason">{conditionText(step)}</span>
          ) : null}
          {dataSummary ? <span className="wf-muted wf-step-reason">{dataSummary}</span> : null}
          {edit ? <span className="wf-muted wf-step-reason">{edit.text}</span> : null}
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
      {exported ? (
        <button type="button" className="btn ghost" onClick={() => void revealExportedFile(exported.path).catch(() => undefined)}>
          {t('workspace.workflows.runDetail.showInFolder')}
        </button>
      ) : null}
      {report && onOpenDocument ? (
        <button type="button" className="btn ghost" onClick={() => onOpenDocument(report.conversationId, report.artifactId)}>
          {t('workspace.workflows.runDetail.openReport')}
        </button>
      ) : null}
      {edit?.note ? <p className="wf-muted">{edit.note}</p> : null}
      {open ? (
        <button type="button" className="btn ghost" onClick={open}>
          {t(
            edit?.target?.kind === 'deck'
              ? 'workspace.workflows.runDetail.openDeck'
              : 'workspace.workflows.runDetail.openDraft',
          )}
        </button>
      ) : null}
      {edit?.target && edit.beforeSnapshotId ? (
        <UndoUpdate
          kind={edit.target.kind}
          id={edit.target.id}
          snapshotId={edit.beforeSnapshotId}
          onRestore={onRestoreDocument}
        />
      ) : null}
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
