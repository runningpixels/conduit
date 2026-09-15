import type { ToolCallState } from './streamState';

/**
 * Whether a model streams document tool calls or delivers them all at once.
 *
 * The adapters can forward tool-call fragments as they arrive, but the
 * upstream decides whether any arrive early: in testing, an OpenRouter-routed
 * model held an 85-second document back and sent it in under a second. There
 * is no catalog field for this, and it can change with the upstream, so it is
 * learned from each completed document write and stored per viewer.
 */
export type DocumentWriteStreaming = 'streams' | 'holds';

const STORAGE_KEY = 'conduit:v10-document-write-streaming';

/** Below this, a quick write is not evidence either way. */
const MIN_EVIDENCE_CHARS = 2000;
/** A document this large that arrived within this window was held back. */
const HELD_WINDOW_MS = 1500;

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function readAll(): Record<string, DocumentWriteStreaming> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed === null || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, DocumentWriteStreaming] => entry[1] === 'streams' || entry[1] === 'holds',
      ),
    );
  } catch {
    return {};
  }
}

export function readDocumentWriteStreaming(provider: string, model: string): DocumentWriteStreaming | undefined {
  return readAll()[modelKey(provider, model)];
}

/**
 * Classify one completed document write. `undefined` when it proves nothing:
 * not a document write, still open, or too small to tell streaming apart from
 * a fast model.
 */
export function classifyDocumentWrite(toolCall: ToolCallState): DocumentWriteStreaming | undefined {
  const scan = toolCall.documentWrite;
  if (!scan || !toolCall.complete || toolCall.startedAt === undefined || toolCall.endedAt === undefined) {
    return undefined;
  }
  // Providers that send a call whole (no fragments at all) leave the scan
  // empty; the parsed arguments still show how big the document was.
  const argumentContent = toolCall.arguments?.[scan.contentField];
  const chars = Math.max(scan.contentChars, typeof argumentContent === 'string' ? argumentContent.length : 0);
  if (chars < MIN_EVIDENCE_CHARS) return undefined;
  return toolCall.endedAt - toolCall.startedAt < HELD_WINDOW_MS ? 'holds' : 'streams';
}

/** Record what a completed document write showed. Re-learned on every write. */
export function recordDocumentWrite(provider: string, model: string, toolCall: ToolCallState): void {
  const behavior = classifyDocumentWrite(toolCall);
  if (!behavior) return;
  try {
    const all = readAll();
    all[modelKey(provider, model)] = behavior;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: the hint simply does not appear.
  }
}

/**
 * Record that a model holds documents back, from something other than a
 * completed write: its stream went silent until the provider gave up while
 * it wrote one (the agent loop retries such a round in parts). Later document
 * turns then ask it for parts from the start.
 */
export function markDocumentWritesHeld(provider: string, model: string): void {
  try {
    const all = readAll();
    all[modelKey(provider, model)] = 'holds';
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: the model is asked for parts only after a timeout.
  }
}
