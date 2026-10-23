/// The agent view's model: which helper of which turn is open, found again on
/// every render from the turn's state so it stays live, plus the small facts
/// the view and the hand-off lines show.

import type { AssistantStreamState, HandoffState, ToolCallState } from './streamState';

/// An open agent view: a turn (the live one, or a saved turn by id), and the
/// path of hand-off tool call ids to the helper, outermost first.
export interface AgentViewTarget {
  turnKey: 'live' | string;
  /// The turn's request id, so the view survives the live turn being saved.
  requestId: string;
  path: string[];
}

/// One level of an open path: the lead's tool call and its hand-off.
export interface AgentLevel {
  toolCallId: string;
  handoff: HandoffState;
}

/// The hand-offs along `path`, or null when any step no longer resolves.
export function resolveAgentPath(state: AssistantStreamState, path: readonly string[]): AgentLevel[] | null {
  if (path.length === 0) return null;
  const levels: AgentLevel[] = [];
  let current = state;
  for (const id of path) {
    const handoff = current.toolCalls.find((tc) => tc.toolCallId === id)?.handoff;
    if (!handoff) return null;
    levels.push({ toolCallId: id, handoff });
    current = handoff.inner;
  }
  return levels;
}

/// The path to the hand-off recorded as agent call `callId`, at any depth.
export function findHandoffPath(state: AssistantStreamState, callId: string): string[] | null {
  if (!callId) return null;
  for (const tc of state.toolCalls) {
    if (!tc.handoff) continue;
    if (tc.handoff.callId === callId) return [tc.toolCallId];
    const inner = findHandoffPath(tc.handoff.inner, callId);
    if (inner) return [tc.toolCallId, ...inner];
  }
  return null;
}

/// Hand-offs of this turn (not nested ones) still running.
export function runningHandoffs(state: AssistantStreamState): number {
  return state.toolCalls.filter((tc) => tc.handoff?.status === 'running').length;
}

/// A tool call waiting on the user's approval.
export function awaitsApproval(tc: ToolCallState): boolean {
  return Boolean(tc.sideEffecting && tc.consent === 'pending');
}

/// Whether anything inside this hand-off (nested helpers too) waits on an approval.
export function handoffNeedsApproval(handoff: HandoffState): boolean {
  return handoff.inner.toolCalls.some(
    (tc) => awaitsApproval(tc) || (tc.handoff ? handoffNeedsApproval(tc.handoff) : false),
  );
}

export interface HelperApproval {
  /// The path to the helper that asked.
  path: string[];
  name: string;
  task: string;
  /// The tool call that waits.
  toolCallId: string;
}

/// Every approval waiting inside a turn's hand-offs, with the path to the
/// helper that asked (its own tool calls, not those of helpers it asked).
export function pendingHelperApprovals(
  state: AssistantStreamState,
  prefix: readonly string[] = [],
): HelperApproval[] {
  const out: HelperApproval[] = [];
  for (const tc of state.toolCalls) {
    if (!tc.handoff) continue;
    const path = [...prefix, tc.toolCallId];
    for (const inner of tc.handoff.inner.toolCalls) {
      if (awaitsApproval(inner)) {
        out.push({ path, name: tc.handoff.name, task: tc.handoff.task, toolCallId: inner.toolCallId });
      }
    }
    out.push(...pendingHelperApprovals(tc.handoff.inner, path));
  }
  return out;
}

/// Whether the helper wrote any text of its own (a reloaded one has only its answer).
export function streamedText(state: AssistantStreamState): boolean {
  return state.blocks.some(
    (b) => b.content.length > 0 && b.blockKind !== 'thinking' && b.blockKind !== 'reasoning',
  );
}

/// A task cut to one short line, for the breadcrumb.
export function shortTask(task: string, max = 32): string {
  const line = task.trim().split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Anything open over the chat that Escape belongs to before the agent view. */
export const OVERLAY_SELECTOR =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [aria-modal="true"], dialog[open]';
