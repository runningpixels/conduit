/// What the shell says when one of a chat's helpers ends: a toast with Open,
/// and a desktop notification when the window is elsewhere.

import { makeStatus, WORKFLOW_RUN_TOAST_MS, type StatusState } from '../chat/statusTypes';
import type { Translate } from '../i18n';
import type { AgentCallChange } from '../ipc/contracts';

/// The longest task a toast quotes.
const TASK_CHARS = 80;

export interface AgentCallNoticeDeps {
  t: Translate;
  /// The user is looking at this helper's view right now.
  watching: boolean;
  /// The app window has focus.
  focused: boolean;
  pushToast: (toast: StatusState) => void;
  openAgentView: (conversationId: string, callId: string) => void;
  notify: (title: string, body: string) => void;
}

/// Tell the user a chat helper finished or failed, unless they are watching
/// it. Workflow helpers are covered by their run's own toast, and one the user
/// stopped needs no news. True when something was said.
export function announceAgentCall(change: AgentCallChange, deps: AgentCallNoticeDeps): boolean {
  const conversationId = change.conversationId;
  if (change.kind !== 'helper' || !conversationId || change.runId) return false;
  if (change.status !== 'done' && change.status !== 'failed') return false;
  if (deps.watching) return false;
  const { t } = deps;
  const name = change.name || change.agentId;
  const task =
    change.task.length > TASK_CHARS ? `${change.task.slice(0, TASK_CHARS - 1).trimEnd()}…` : change.task;
  const done = change.status === 'done';
  const brief = done ? t('chat.agentView.toastFinished', { name, task }) : t('chat.agentView.toastFailed', { name, task });
  deps.pushToast({
    ...makeStatus(brief, done ? 'success' : 'warning', 'chat', change.error ?? undefined),
    dismissMs: WORKFLOW_RUN_TOAST_MS,
    action: { label: t('chat.agentView.open'), run: () => deps.openAgentView(conversationId, change.id) },
  });
  if (!deps.focused) deps.notify(name, brief);
  return true;
}
