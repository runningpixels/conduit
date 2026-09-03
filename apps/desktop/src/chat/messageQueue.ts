/**
 * Per-conversation follow-up message queue (t1-2 M1).
 *
 * While an agent turn is in flight the composer stays editable; Enter/Send
 * enqueue here instead of starting a new stream. When the turn ends, the
 * owner drains FIFO into `handleSend`. Steer (M2) peeks/removes a single
 * item without draining the rest.
 */

import type { TurnAttachment } from './composerTypes';

export interface QueuedMessage {
  id: string;
  text: string;
  attachments?: TurnAttachment[];
  enqueuedAt: number;
}

export type ConversationQueues = Record<string, QueuedMessage[]>;

export function createQueuedMessage(
  text: string,
  attachments?: TurnAttachment[],
  id: string = crypto.randomUUID(),
): QueuedMessage {
  return {
    id,
    text: text.trim(),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    enqueuedAt: Date.now(),
  };
}

export function enqueue(
  queues: ConversationQueues,
  conversationId: string,
  item: QueuedMessage,
): ConversationQueues {
  if (!item.text && !(item.attachments && item.attachments.length > 0)) {
    return queues;
  }
  const existing = queues[conversationId] ?? [];
  return { ...queues, [conversationId]: [...existing, item] };
}

export function remove(
  queues: ConversationQueues,
  conversationId: string,
  id: string,
): ConversationQueues {
  const existing = queues[conversationId];
  if (!existing) return queues;
  const next = existing.filter((item) => item.id !== id);
  if (next.length === 0) {
    const { [conversationId]: _, ...rest } = queues;
    return rest;
  }
  return { ...queues, [conversationId]: next };
}

export function peek(queues: ConversationQueues, conversationId: string): QueuedMessage | null {
  const existing = queues[conversationId];
  return existing?.[0] ?? null;
}

/** Remove and return the head item, or null if empty. */
export function shift(
  queues: ConversationQueues,
  conversationId: string,
): { queues: ConversationQueues; item: QueuedMessage | null } {
  const existing = queues[conversationId];
  if (!existing || existing.length === 0) {
    return { queues, item: null };
  }
  const [item, ...rest] = existing;
  if (rest.length === 0) {
    const { [conversationId]: _, ...without } = queues;
    return { queues: without, item };
  }
  return { queues: { ...queues, [conversationId]: rest }, item };
}

/** Take every queued item for a conversation (FIFO order) and clear it. */
export function drain(
  queues: ConversationQueues,
  conversationId: string,
): { queues: ConversationQueues; items: QueuedMessage[] } {
  const items = queues[conversationId] ?? [];
  if (items.length === 0) return { queues, items: [] };
  const { [conversationId]: _, ...rest } = queues;
  return { queues: rest, items: [...items] };
}

export function listFor(
  queues: ConversationQueues,
  conversationId: string | null,
): QueuedMessage[] {
  if (!conversationId) return [];
  return queues[conversationId] ?? [];
}

export function previewText(item: QueuedMessage, max = 48): string {
  const raw = item.text.trim() || (item.attachments?.length ? '(attachment)' : '');
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max - 1)}…`;
}
