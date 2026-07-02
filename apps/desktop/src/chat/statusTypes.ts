/**
 * Rich status state for the footer status bar.
 * Replaces the plain `string` status with a typed object that includes
 * visual kind, source locality, and optional detail text.
 */

export type StatusKind = 'idle' | 'active' | 'thinking' | 'warning' | 'error' | 'success';
export type StatusSource = 'chat' | 'artifact' | 'connector' | 'settings';

export interface StatusState {
  /** Short one-line message for the footer (always shown). */
  brief: string;
  /** Optional detailed message (tooltip or expandable). */
  detail?: string;
  /** Visual kind for styling. */
  kind: StatusKind;
  /** Source component for locality. */
  source?: StatusSource;
  /** Timestamp for ordering / dedup. */
  timestamp: number;
}

/** Auto-dismiss timeout by kind (ms). `undefined` = never auto-dismiss. */
export const STATUS_DISMISS_MS: Partial<Record<StatusKind, number>> = {
  success: 4000,
  idle: 3000,
};

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