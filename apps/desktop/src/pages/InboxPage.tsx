/// The Inbox: everything your workflows are waiting on, across all of them.
///
/// Outside actions to check, "Ask me" questions and permission requests, oldest
/// first, each with the workflow it came from and a way to open it. Answering
/// happens here; the cards are the ones the Workflows page shows.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import {
  answerWorkflowQuestion,
  answerWorkflowReview,
  listWorkflowActions,
  listWorkflowQuestions,
  listWorkflowReviews,
} from '../ipc/client';
import type { WorkflowAction, WorkflowQuestion, WorkflowReview, WorkflowReviewDecision } from '../ipc/contracts';
import { PageEmpty, PageFrame } from '../shell/PageFrame';
import { ActionCard } from '../workflows/ActionCard';
import { ReviewCard } from '../workflows/ReviewCard';
import { formatNextRun } from '../workflows/ScheduleSection';
import {
  useWorkflowActionEvents,
  useWorkflowQuestionEvents,
  useWorkflowReviewEvents,
} from '../workflows/workflowRunEvents';
import { QuestionPanel, waitKey } from './WorkflowsPage';

type Item =
  | { kind: 'action'; wait: WorkflowAction }
  | { kind: 'question'; wait: WorkflowQuestion }
  | { kind: 'review'; wait: WorkflowReview };

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

/// Replace the wait with the same key, or add it.
function upsert<T extends { runId: string; stepId: string }>(list: T[], wait: T): T[] {
  return [...list.filter((w) => waitKey(w) !== waitKey(wait)), wait];
}

/// Read one list, ignoring a failure so the others still show.
function read<T>(list: () => Promise<T[]>, set: (next: T[]) => void): Promise<void> {
  return Promise.resolve()
    .then(list)
    .then((next) => set(Array.isArray(next) ? next : []), () => {});
}

export function InboxPage({
  onStatus,
  onOpenWorkflow,
  refreshKey,
}: {
  onStatus: (message: string) => void;
  /// Open a workflow with this run's waiting panel in view.
  onOpenWorkflow: (workflowId: string, runId: string) => void;
  /// Changes when a run starts, waits or ends elsewhere; the page re-reads.
  refreshKey?: number;
}) {
  const t = useT();
  const fmt = useFormatters();
  const [actions, setActions] = useState<WorkflowAction[]>([]);
  const [questions, setQuestions] = useState<WorkflowQuestion[]>([]);
  const [reviews, setReviews] = useState<WorkflowReview[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [reviewErrors, setReviewErrors] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    await Promise.all([
      read(() => listWorkflowActions(), setActions),
      read(() => listWorkflowQuestions(), setQuestions),
      read(() => listWorkflowReviews(), setReviews),
    ]);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void reload();
    window.addEventListener('focus', reload);
    return () => window.removeEventListener('focus', reload);
    // `refreshKey`: a run ended or started while the Inbox is open.
  }, [reload, refreshKey]);

  useWorkflowActionEvents((action) => setActions((current) => upsert(current, action)));
  useWorkflowQuestionEvents((question) => setQuestions((current) => upsert(current, question)));
  useWorkflowReviewEvents((review) => setReviews((current) => upsert(current, review)));

  const items = useMemo<Item[]>(() => {
    const all: Item[] = [
      ...actions.map((wait) => ({ kind: 'action' as const, wait })),
      ...questions.map((wait) => ({ kind: 'question' as const, wait })),
      ...reviews.map((wait) => ({ kind: 'review' as const, wait })),
    ];
    return all.sort((a, b) => Date.parse(a.wait.requestedAt) - Date.parse(b.wait.requestedAt));
  }, [actions, questions, reviews]);

  function actionAnswered(action: WorkflowAction, taken: boolean) {
    if (!taken) onStatus(t('workspace.workflows.review.gone'));
    setActions((current) => current.filter((a) => waitKey(a) !== waitKey(action)));
    void reload();
  }

  async function answerReview(review: WorkflowReview, decision: WorkflowReviewDecision) {
    const key = waitKey(review);
    setBusy((current) => new Set(current).add(key));
    setReviewErrors(({ [key]: _cleared, ...rest }) => rest);
    try {
      const taken = await answerWorkflowReview(review.runId, decision, review.stepId);
      if (!taken) onStatus(t('workspace.workflows.review.gone'));
      setReviews((current) => current.filter((r) => waitKey(r) !== key));
      void reload();
    } catch (e) {
      setReviewErrors((current) => ({
        ...current,
        [key]: t('workspace.workflows.status.actionFailed', { error: errorText(e) }),
      }));
    } finally {
      setBusy((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  /// Resolves to why the answer was refused, or `null` once it was taken.
  async function reply(question: WorkflowQuestion, text: string): Promise<string | null> {
    try {
      const taken = await answerWorkflowQuestion(question.runId, text, question.stepId);
      if (!taken) onStatus(t('workspace.workflows.review.gone'));
    } catch (e) {
      return t('workspace.workflows.question.failed', { error: errorText(e) });
    }
    setQuestions((current) => current.filter((q) => waitKey(q) !== waitKey(question)));
    void reload();
    return null;
  }

  return (
    <PageFrame title={t('shell.inbox.title')} subtitle={t('shell.inbox.subtitle')} className="inbox-page">
      {items.length === 0 ? (
        loaded ? (
          <PageEmpty title={t('shell.inbox.empty.title')} body={t('shell.inbox.empty.body')} />
        ) : null
      ) : (
        <ul className="inbox-list" aria-label={t('shell.inbox.listLabel')}>
          {items.map((item) => {
            const { wait } = item;
            const name = wait.workflowName || t('workspace.workflows.notify.unnamed');
            const expires = formatNextRun(wait.expiresAt, fmt.locale);
            return (
              <li key={`${item.kind}:${waitKey(wait)}`} className="inbox-item">
                <div className="inbox-item-head">
                  <p className="inbox-item-workflow">{name}</p>
                  <button
                    type="button"
                    className="btn ghost"
                    aria-label={t('shell.inbox.openNamed', { name })}
                    onClick={() => onOpenWorkflow(wait.workflowId, wait.runId)}
                  >
                    {t('shell.inbox.open')}
                  </button>
                </div>
                {item.kind === 'action' ? (
                  <ActionCard action={item.wait} onAnswered={actionAnswered} />
                ) : item.kind === 'question' ? (
                  <QuestionPanel question={item.wait} expires={expires} onAnswer={(text) => reply(item.wait, text)} />
                ) : (
                  <ReviewCard
                    review={item.wait}
                    expires={expires}
                    busy={busy.has(waitKey(item.wait))}
                    error={reviewErrors[waitKey(item.wait)]}
                    onAnswer={(decision) => void answerReview(item.wait, decision)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </PageFrame>
  );
}
