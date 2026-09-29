/// What a workflow's permissions and questions say, in the user's language.
///
/// The permissions come from Rust (`workflows::permissions`): what a
/// workflow may do when it runs on its own, and what a paused run asks for.

import type { Translate } from '../i18n';
import type { WorkflowPermissionView, WorkflowReview } from '../ipc/contracts';

/// One line of "When it runs on its own, it will be allowed to: …".
export function permissionText(p: WorkflowPermissionView, t: Translate): string {
  switch (p.kind) {
    case 'host':
      return t('workspace.workflows.permissions.host', { host: p.host });
    case 'anyHost':
      return t('workspace.workflows.permissions.anyHost', { step: p.stepId });
    case 'webSearch':
      return t('workspace.workflows.permissions.webSearch', { backend: p.label ?? p.backend });
    case 'model':
      return p.local
        ? t('workspace.workflows.permissions.modelLocal', { provider: p.label ?? p.provider })
        : t('workspace.workflows.permissions.modelCloud', { provider: p.label ?? p.provider });
    case 'saveDocuments':
      return t('workspace.workflows.permissions.saveDocuments');
  }
}

/// What a paused run wants, as one sentence ("It wants to read pages on bbc.com.").
export function reviewText(review: WorkflowReview, t: Translate): string {
  const p = review.permission;
  switch (p.kind) {
    case 'host':
      return t('workspace.workflows.review.host', { host: p.host });
    case 'anyHost':
      return t('workspace.workflows.review.anyHost', { url: review.url ?? '', step: p.stepId });
    case 'webSearch':
      return t('workspace.workflows.review.webSearch', { backend: p.label ?? p.backend });
    case 'model':
      return p.local
        ? t('workspace.workflows.review.modelLocal', { provider: p.label ?? p.provider })
        : t('workspace.workflows.review.modelCloud', { provider: p.label ?? p.provider });
    case 'saveDocuments':
      return t('workspace.workflows.review.saveDocuments');
  }
}
