/**
 * Rich status state for panel-head activity and toast notifications.
 * Progress (active/thinking) stays in the panel head; errors, warnings,
 * and successes route to ToastStack.
 */

export type StatusKind = 'idle' | 'active' | 'thinking' | 'warning' | 'error' | 'success';
export type StatusSource = 'chat' | 'artifact' | 'connector' | 'settings';

export interface StatusState {
  /** Short one-line message (always shown). */
  brief: string;
  /** Optional detailed message (tooltip or expandable). */
  detail?: string;
  /** Visual kind for styling. */
  kind: StatusKind;
  /** Source component for locality. */
  source?: StatusSource;
  /** Timestamp for ordering / dedup. */
  timestamp: number;
  /** One follow-up a toast can offer (a link to a settings page, say). A toast
   *  that carries one stays until dismissed: an action that vanishes after six
   *  seconds is one most people never get to press. */
  action?: StatusAction;
  /** Auto-dismiss after this many ms whatever the kind (overrides
   *  `TOAST_DISMISS_MS`). A workflow run's toast uses it: the run list keeps the detail. */
  dismissMs?: number;
}

export interface StatusAction {
  label: string;
  run: () => void;
}

/** Auto-dismiss timeout for panel-head status by kind (ms). */
export const STATUS_DISMISS_MS: Partial<Record<StatusKind, number>> = {
  idle: 3000,
};

/** Toast auto-dismiss: warnings 6s, success 4s; errors stay until dismissed. */
export const TOAST_DISMISS_MS: Partial<Record<StatusKind, number>> = {
  warning: 6000,
  success: 4000,
};

/** Workflow run toasts (finished / failed) leave after 10s, errors included. */
export const WORKFLOW_RUN_TOAST_MS = 10_000;

/** How long a toast stays before it dismisses itself, or null to stay. A toast
 *  that offers an action never leaves on its own. */
export function toastDismissMs(toast: StatusState): number | null {
  if (toast.action) return null;
  return toast.dismissMs ?? TOAST_DISMISS_MS[toast.kind] ?? null;
}

/** A workflow run's outcome as a self-dismissing toast. */
export function workflowRunStatus(brief: string, kind: StatusKind, detail?: string): StatusState {
  return { ...makeStatus(brief, kind, undefined, detail), dismissMs: WORKFLOW_RUN_TOAST_MS };
}

/** Kinds that surface exclusively in ToastStack (not the panel-head pill). */
export const TOAST_STATUS_KINDS: ReadonlySet<StatusKind> = new Set([
  'error',
  'warning',
  'success',
]);

/** Create a StatusState from a brief message and inferred kind. */
export function makeStatus(
  brief: string,
  kind: StatusKind = 'active',
  source?: StatusSource,
  detail?: string,
): StatusState {
  return { brief, kind, source, detail, timestamp: Date.now() };
}

/** Infer a StatusKind from a brief message string. */
export function inferKind(brief: string): StatusKind {
  const lower = brief.toLowerCase();
  if (lower.includes('fail') || lower.includes('error') || lower.includes('could not')) return 'error';
  if (lower.includes('warn') || lower.includes('unavailable')) return 'warning';
  if (lower.includes('complete') || lower.includes('saved') || lower.includes('exported') || lower.includes('updated') || lower.includes('promoted') || lower.includes('cancelled')) return 'success';
  if (lower.includes('connect') || lower.includes('loading') || lower.includes('running')) return 'active';
  if (lower.includes('think')) return 'thinking';
  return 'idle';
}

/** Wrapper for the common pattern of setting a rich status from a string.
 *  Use this as a drop-in replacement for `onStatus(string)` callers that
 *  haven't been manually upgraded to pass a StatusState. */
export function fromString(message: string): StatusState {
  return makeStatus(message, inferKind(message));
}
