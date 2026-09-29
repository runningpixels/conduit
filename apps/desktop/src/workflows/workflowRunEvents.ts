/// Scheduled workflow runs, as the renderer hears about them.
///
/// The Rust scheduler (`workflows::scheduler`) emits `workflow-run-finished`
/// when a scheduled run ends. The app turns that into a desktop notification in
/// the user's language (Rust shows it: `notify_workflow_run`) and refreshes the
/// Workflows page. Manual runs don't notify: the user is already watching.

import { useEffect, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Translate } from '../i18n';
import type { WorkflowReview, WorkflowRunFinished } from '../ipc/contracts';
import { reviewText } from './permissionText';

export const RUN_FINISHED_EVENT = 'workflow-run-finished';
/// Emitted with a `WorkflowReview` when a scheduled run pauses to ask.
export const RUN_PAUSED_EVENT = 'workflow-run-paused';

/// The notification for a run that paused to ask.
export function notificationForReview(review: WorkflowReview, t: Translate): { title: string; body: string } {
  const name = review.workflowName || t('workspace.workflows.notify.unnamed');
  return { title: t('workspace.workflows.notify.waitingTitle', { name }), body: reviewText(review, t) };
}

/// Call `onPaused` whenever a scheduled run pauses to ask.
export function useWorkflowReviewEvents(onPaused: (review: WorkflowReview) => void) {
  const handler = useRef(onPaused);
  handler.current = onPaused;
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void listen<WorkflowReview>(RUN_PAUSED_EVENT, (e) => handler.current(e.payload)).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
}

/// The notification for a finished run, or `null` when there is nothing to say
/// (a slot skipped because the workflow was still running, or a run the user
/// stopped).
export function notificationFor(event: WorkflowRunFinished, t: Translate): { title: string; body: string } | null {
  if (event.status === 'skipped' || event.status === 'stopped') return null;
  const name = event.workflowName || t('workspace.workflows.notify.unnamed');
  const title = event.trigger === 'catch_up' ? t('workspace.workflows.notify.caughtUpTitle', { name }) : name;
  if (event.status === 'failed') {
    return { title, body: t('workspace.workflows.notify.failed', { error: event.error ?? '' }) };
  }
  const saved = event.documents[0];
  return {
    title,
    body: saved
      ? t('workspace.workflows.notify.saved', { title: saved.title })
      : t('workspace.workflows.notify.completed'),
  };
}

/// Call `onFinished` for every scheduled run that ends while the app is open.
export function useWorkflowRunEvents(onFinished: (event: WorkflowRunFinished) => void) {
  const handler = useRef(onFinished);
  handler.current = onFinished;
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void listen<WorkflowRunFinished>(RUN_FINISHED_EVENT, (e) => handler.current(e.payload)).then((unlisten) => {
      if (cancelled) unlisten();
      else stop = unlisten;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
}
