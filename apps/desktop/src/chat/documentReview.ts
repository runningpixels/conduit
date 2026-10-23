/// "Have it reviewed": the Reviewer reads a chat document against the request
/// that produced it (agents::review), then the chat makes one revision. This
/// finds that request and writes the revision message, which the thread shows
/// as a short app note (see chat/appPrompt.ts).

import type { Artifact, DocumentReview } from '../ipc/contracts';
import type { Translate } from '../i18n';
import { appPrompt, appPromptLabel } from './appPrompt';
import type { ChatTurn } from './conversationHydration';

/** Something the user typed, not a note the app sent for them. */
function typed(turn: ChatTurn): boolean {
  return turn.role === 'user' && appPromptLabel(turn.content) === null && turn.content.trim() !== '';
}

/**
 * The user's words that produced `artifact`: the last thing they typed before
 * the reply that made it, or, when that reply isn't in the thread, the last
 * thing they typed. Empty when they typed nothing.
 */
export function requestForDocument(turns: readonly ChatTurn[], artifact: Pick<Artifact, 'sourceMessageId'>): string {
  const made = artifact.sourceMessageId ? turns.findIndex((turn) => turn.id === artifact.sourceMessageId) : -1;
  const before = made === -1 ? turns : turns.slice(0, made);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    if (typed(before[i])) return before[i].content.trim();
  }
  return '';
}

/**
 * The chat message that has the document revised: the issues, a reminder that
 * everything the request asked still holds (a revision that fixes the facts
 * must not break a length limit), and the request itself.
 */
export function revisionMessage(t: Translate, review: DocumentReview, title: string, request: string): string {
  const issues = review.issues
    .map((issue, i) => {
      const change = issue.change.trim();
      return change ? `${i + 1}. ${issue.problem.trim()} — ${change}` : `${i + 1}. ${issue.problem.trim()}`;
    })
    .join('\n');
  // The issues first: the note opens to show this text (chat/AppNote.tsx).
  const parts = [
    t('chat.review.prompt.found', { name: review.reviewer, title }),
    issues,
    t('chat.review.prompt.fix'),
  ];
  if (request.trim()) parts.push(t('chat.review.prompt.request', { request: request.trim() }));
  return appPrompt(
    t('chat.review.note', { name: review.reviewer, count: review.issues.length, title }),
    parts.join('\n\n'),
  );
}
