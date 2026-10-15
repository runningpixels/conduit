/// A scheduled run paused to ask for permission: what it wants, and Allow
/// once / Always allow / Don't allow. Shared by the Workflows page and the Inbox.

import { useT } from '../i18n';
import type { WorkflowReview } from '../ipc/contracts';
import { reviewText, type HelperNames } from './permissionText';

export function ReviewCard({
  review,
  expires,
  busy,
  error,
  onAnswer,
  helperNames,
}: {
  review: WorkflowReview;
  /// When the step stops waiting, already formatted.
  expires: string;
  busy: boolean;
  error?: string;
  onAnswer: (decision: 'allowOnce' | 'alwaysAllow' | 'deny') => void;
  /// The workflow's helper names by id, when a permission names a helper.
  helperNames?: HelperNames;
}) {
  const t = useT();
  return (
    <section
      className="wf-offer wf-review"
      role="group"
      aria-label={t('workspace.workflows.review.title')}
      data-run-id={review.runId}
    >
      <b>{t('workspace.workflows.review.title')}</b>
      <p className="wf-review-what">{reviewText(review, t, helperNames)}</p>
      <p className="wf-muted">{t('workspace.workflows.review.expires', { when: expires })}</p>
      <div className="wf-offer-actions">
        <button type="button" className="btn primary" disabled={busy} onClick={() => onAnswer('allowOnce')}>
          {t('workspace.workflows.review.allowOnce')}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => onAnswer('alwaysAllow')}>
          {t('workspace.workflows.review.alwaysAllow')}
        </button>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => onAnswer('deny')}>
          {t('workspace.workflows.review.deny')}
        </button>
      </div>
      {error ? (
        <p className="wf-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
