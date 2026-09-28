import type { Message } from '@conduit/config-schema';
import { getRequestProviderEvents } from '../ipc/client';
import { type KnowledgeRef, type TurnAttachment } from './composerTypes';
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
  /** Image attachment refs for this user turn (retry/fork/edit must keep these). */
  attachments?: TurnAttachment[];
  /** `#`-picked document references for this user turn (t1-8 M3, D8/D9). */
  knowledgeRefs?: KnowledgeRef[];
}

const DISPLAY_PART_KINDS = new Set(['text', 'reasoning']);
const ATTACHMENT_PART_KINDS = new Set(['attachmentReference', 'image']);
// A Set<string> comparison (`.has(part.kind)`), not `part.kind === 'knowledgeReference'`:
// the generated `MessagePartKind` union may not carry this literal yet (the Rust
// side adds it in parallel — see docs/plans/documents-control.md D8), and a direct
// `===` against a literal outside the union is a TS2367 compile error where a
// `Set<string>.has` is not.
const KNOWLEDGE_REF_PART_KINDS = new Set(['knowledgeReference']);

function joinDisplayContent(message: Message): string {
  return message.parts
    .filter((part) => DISPLAY_PART_KINDS.has(part.kind))
    .map((part) => part.content ?? '')
    .filter(Boolean)
    .join('\n');
}

function attachmentsFromMessage(message: Message): TurnAttachment[] {
  const out: TurnAttachment[] = [];
  for (const part of message.parts) {
    if (!ATTACHMENT_PART_KINDS.has(part.kind)) continue;
    const id = part.attachmentId?.trim();
    if (!id) continue;
    out.push({
      id,
      mimeType: (part.mimeType ?? 'application/octet-stream').toLowerCase(),
    });
  }
  return out;
}

/** `knowledgeReference` parts hydrated back (D8): survives reload, retry,
 *  edit-and-resend and fork because all of those read the turn's parts. The
 *  title/collection name are read from the part's own metadata, copied there
 *  at pick time, so a reference to a since-deleted document still reads right. */
function knowledgeRefsFromMessage(message: Message): KnowledgeRef[] {
  const out: KnowledgeRef[] = [];
  for (const part of message.parts) {
    if (!KNOWLEDGE_REF_PART_KINDS.has(part.kind)) continue;
    const metadata = (part.metadata ?? {}) as Record<string, unknown>;
    const documentId = typeof metadata.documentId === 'string' ? metadata.documentId.trim() : '';
    if (!documentId) continue;
    out.push({
      documentId,
      title: typeof metadata.title === 'string' ? metadata.title : '',
      collectionId: typeof metadata.collectionId === 'string' ? metadata.collectionId : '',
      collectionName: typeof metadata.collectionName === 'string' ? metadata.collectionName : '',
    });
  }
  return out;
}

/** Map a persisted message to a chat-thread turn, or skip non-displayable roles. */
export function messageToDisplayTurn(message: Message): ChatTurn | null {
  if (message.role === 'tool' || message.role === 'system' || message.role === 'developer') {
    return null;
  }

  const content = joinDisplayContent(message);
  const attachments =
    message.role === 'user' ? attachmentsFromMessage(message) : undefined;
  const knowledgeRefs =
    message.role === 'user' ? knowledgeRefsFromMessage(message) : undefined;
  if (message.role === 'user' && !content.trim() && !(attachments && attachments.length > 0)) {
    return null;
  }

  return {
    id: message.id,
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content,
    interrupted: Boolean(message.interruptedAt),
    createdAt: message.createdAt,
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(knowledgeRefs && knowledgeRefs.length > 0 ? { knowledgeRefs } : {}),
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
