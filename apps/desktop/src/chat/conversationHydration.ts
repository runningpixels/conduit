import type { Message } from '@conduit/config-schema';
import { getRequestProviderEvents } from '../ipc/client';
import { rebuildAssistantStreamStateFromEvents, type AssistantStreamState } from './streamState';

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streamState?: AssistantStreamState;
  interrupted?: boolean;
  modelId?: string;
  /** Persisted message timestamp when available (hydrated turns). */
  createdAt?: string;
}

const DISPLAY_PART_KINDS = new Set(['text', 'reasoning']);

function joinDisplayContent(message: Message): string {
  return message.parts
    .filter((part) => DISPLAY_PART_KINDS.has(part.kind))
    .map((part) => part.content ?? '')
    .filter(Boolean)
    .join('\n');
}

/** Map a persisted message to a chat-thread turn, or skip non-displayable roles. */
export function messageToDisplayTurn(message: Message): ChatTurn | null {
  if (message.role === 'tool' || message.role === 'system' || message.role === 'developer') {
    return null;
  }

  const content = joinDisplayContent(message);
  if (message.role === 'user' && !content.trim()) {
    return null;
  }

  return {
    id: message.id,
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content,
    interrupted: Boolean(message.interruptedAt),
    createdAt: message.createdAt,
  };
}

/** Hydrate a persisted message for display, replaying provider events for assistant turns. */
export async function hydrateAssistantTurn(message: Message): Promise<ChatTurn | null> {
  const turn = messageToDisplayTurn(message);
  if (!turn) {
    return null;
  }
  if (message.role !== 'assistant' || !message.requestId) {
    return turn;
  }
  try {
    const events = await getRequestProviderEvents(message.conversationId, message.requestId);
    if (events.length > 0) {
      turn.streamState = rebuildAssistantStreamStateFromEvents(message.requestId, events);
    }
  } catch {
    /* fall back to flat content */
  }
  return turn;
}

/** True when a displayed assistant turn belongs to the live stream `requestId`. */
export function assistantTurnMatchesRequest(turn: ChatTurn, requestId: string): boolean {
  if (turn.role !== 'assistant') return false;
  return (
    turn.streamState?.requestId === requestId ||
    turn.id === requestId ||
    turn.id === `assistant-${requestId}`
  );
}

/** Drop hydrated assistants that would double-mount next to `activeStream`. */
export function excludeLiveAssistantTurns(
  turns: ChatTurn[],
  liveRequestId: string | null | undefined,
): ChatTurn[] {
  if (!liveRequestId) return turns;
  return turns.filter((turn) => !assistantTurnMatchesRequest(turn, liveRequestId));
}

/** Replace any existing row for this request instead of appending a second bubble. */
export function upsertAssistantTurn(
  turns: ChatTurn[],
  next: ChatTurn,
  requestId: string,
): ChatTurn[] {
  const without = turns.filter(
    (turn) => turn.id !== next.id && !assistantTurnMatchesRequest(turn, requestId),
  );
  return [...without, next];
}
