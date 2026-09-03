/**
 * t1-3 context compaction helpers — apply a journaled summary when building
 * the next provider request and when collapsing the thread UI.
 */

import type { ConversationCompaction } from '../ipc/client';
import type { ChatTurn } from './conversationHydration';

/** Label so the model treats the blob as prior context, not a user utterance. */
export const COMPACTION_SUMMARY_LABEL =
  'Earlier conversation summary (for context; not a user message):';

export function formatCompactionDeveloperPrompt(summaryText: string): string {
  return `${COMPACTION_SUMMARY_LABEL}\n\n${summaryText.trim()}`;
}

/**
 * Drop turns before `keptFromMessageId`. Returns `{ kept, compacted }` where
 * `compacted` are the hidden originals (still in memory/DB for "show original").
 */
export function splitTurnsAtCompaction(
  turns: ChatTurn[],
  compaction: ConversationCompaction | null | undefined,
): { kept: ChatTurn[]; compacted: ChatTurn[] } {
  if (!compaction?.keptFromMessageId) {
    return { kept: turns, compacted: [] };
  }
  const idx = turns.findIndex((t) => t.id === compaction.keptFromMessageId);
  if (idx < 0) {
    return { kept: turns, compacted: [] };
  }
  return {
    compacted: turns.slice(0, idx),
    kept: turns.slice(idx),
  };
}

/** History for the provider: only kept turns (caller injects the summary). */
export function historyForProviderRequest(
  turns: ChatTurn[],
  compaction: ConversationCompaction | null | undefined,
): ChatTurn[] {
  return splitTurnsAtCompaction(turns, compaction).kept;
}
