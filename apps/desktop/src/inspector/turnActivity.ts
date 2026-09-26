import type { ChatTurn } from '../chat/conversationHydration';
import type { AssistantStreamState, SearchSource, ToolCallState } from '../chat/streamState';
import { toolCallAwaitsRuntimeFinish } from '../chat/streamState';
import { isWebSearchToolCall } from '../chat/SearchCallBlock';
import { DOCUMENT_TOOL_NAMES, summarizeDocumentToolCall } from '../chat/agentTools';
import { splitToolDisplayName } from '../chat/connectorTools';
import { hostOf } from '../chat/citationUtils';

/**
 * What an assistant turn did, as a flat list of steps — the data behind the
 * transcript's compact "2 steps · 1 site" line and the inspector's Activity
 * timeline. Pure: no translation happens here. `label` carries the language-
 * neutral detail a reader recognises (a document title, a search query, a
 * path); the views add the translated words around it.
 */

export type ActivityStepKind = 'tool' | 'search' | 'document' | 'image' | 'askUser' | 'error';
export type ActivityStepStatus = 'running' | 'done' | 'failed' | 'waiting' | 'denied';

export interface ActivityStep {
  id: string;
  kind: ActivityStepKind;
  /** Raw tool name (`write_html_document`, `github__create_issue`). Empty for error steps. */
  name: string;
  /** Human detail: document title, search query, path/url argument, error text. May be empty. */
  label: string;
  status: ActivityStepStatus;
  durationMs?: number;
  startedAt?: number;
  /** Connector part of a connector tool name (`github` for `github__create_issue`). */
  connector?: string;
  /** Document steps: `create` | `edit` | `read` | `document` (an id — translate it). */
  documentAction?: string;
  /** Document steps: how much content the call carries (live while it streams). */
  size?: { chars: number; lines: number };
  /** Search steps: sources this query returned. */
  sourceCount?: number;
  /** Failure reason for a failed tool call. */
  error?: string;
  /** The tool call this step came from (absent for error steps). */
  toolCallId?: string;
}

export interface TurnSummary {
  /** Steps the turn took (errors excluded — they are shown inline). */
  steps: number;
  /** Distinct hosts the turn reached: web-search sources, URL citations, fetched URLs. */
  sites: number;
  /** Steps that failed. */
  failed: number;
  /** The turn is still streaming. */
  running: boolean;
  /** An approval or an ask_user form is waiting on the reader. */
  needsYou: boolean;
}

const EMPTY_SUMMARY: TurnSummary = { steps: 0, sites: 0, failed: 0, running: false, needsYou: false };

function pickString(raw: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!raw) return undefined;
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** Title + url of one provider search source (the shape is provider-defined). */
export function searchSourceEntry(source: SearchSource): { title?: string; url?: string } {
  return {
    title: pickString(source.raw, ['title', 'name']),
    url: pickString(source.raw, ['url', 'link']),
  };
}

/** True for a URL the external-link flow can open (Rust re-validates). */
export function isHttpUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host.length > 0;
  } catch {
    return false;
  }
}

function stepStatus(tc: ToolCallState, state: AssistantStreamState): ActivityStepStatus {
  if (tc.consent === 'pending') return 'waiting';
  if (tc.consent === 'denied') return 'denied';
  if (state.askUser && state.askUser.toolCallId === tc.toolCallId) return 'waiting';
  if (tc.status === 'failed' || tc.status === 'cancelled') return 'failed';
  if (tc.status === 'completed') return 'done';
  if (tc.status === 'running' || tc.status === 'pending' || tc.status === 'approved') {
    return state.streaming ? 'running' : 'failed';
  }
  if (!state.streaming) return tc.complete ? 'done' : 'failed';
  if (!tc.complete) return 'running';
  return toolCallAwaitsRuntimeFinish(tc, state.searchBackend) ? 'running' : 'done';
}

/** The argument a reader recognises a generic call by — as ToolCallBlock's sub-rows pick it. */
function genericLabel(tc: ToolCallState): string {
  const args = tc.arguments ?? {};
  const picked = pickString(args, ['file_path', 'path', 'filename', 'url', 'query', 'title', 'prompt', 'name']);
  if (picked) return picked.split('\n', 1)[0];
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim()) return value.trim().split('\n', 1)[0].slice(0, 200);
  }
  return '';
}

function stepFor(tc: ToolCallState, state: AssistantStreamState): ActivityStep {
  const status = stepStatus(tc, state);
  // A reloaded turn carries one timestamp for both ends: 0 means unknown,
  // not instant, so it shows no duration rather than "0ms".
  const durationMs =
    tc.startedAt != null && tc.endedAt != null && tc.endedAt > tc.startedAt
      ? tc.endedAt - tc.startedAt
      : undefined;
  const base = {
    id: tc.toolCallId,
    name: tc.name,
    status,
    toolCallId: tc.toolCallId,
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(tc.startedAt !== undefined ? { startedAt: tc.startedAt } : {}),
    ...(status === 'failed' && tc.error ? { error: tc.error } : {}),
  };

  if (isWebSearchToolCall(tc)) {
    return {
      ...base,
      kind: 'search',
      label: pickString(tc.arguments, ['query']) ?? '',
      sourceCount: tc.sources?.length ?? 0,
    };
  }
  if (DOCUMENT_TOOL_NAMES.has(tc.name)) {
    const doc = summarizeDocumentToolCall(tc);
    return {
      ...base,
      kind: 'document',
      label: doc?.title || doc?.filename || pickString(tc.arguments, ['artifact_id']) || '',
      documentAction: doc?.action ?? 'document',
      ...(doc && doc.charCount > 0 ? { size: { chars: doc.charCount, lines: doc.lineCount } } : {}),
    };
  }
  if (tc.name === 'generate_image') {
    return { ...base, kind: 'image', label: pickString(tc.arguments, ['prompt']) ?? '' };
  }
  if (tc.name === 'ask_user') {
    const title =
      state.askUser?.toolCallId === tc.toolCallId ? state.askUser.title : pickString(tc.arguments, ['title']);
    return { ...base, kind: 'askUser', label: title ?? '' };
  }
  const split = splitToolDisplayName(tc.name);
  return {
    ...base,
    kind: 'tool',
    label: genericLabel(tc),
    ...(split.tool !== split.connector ? { connector: split.connector } : {}),
  };
}

/** Every step of one assistant turn, in the order the calls started. */
export function deriveActivitySteps(state: AssistantStreamState | undefined): ActivityStep[] {
  if (!state) return [];
  const steps = state.toolCalls.map((tc) => stepFor(tc, state));
  // An ask_user form whose tool call never reached the list (stale edge case)
  // still needs the reader.
  if (state.askUser && !state.toolCalls.some((tc) => tc.toolCallId === state.askUser?.toolCallId)) {
    steps.push({
      id: state.askUser.toolCallId,
      kind: 'askUser',
      name: 'ask_user',
      label: state.askUser.title,
      status: 'waiting',
      toolCallId: state.askUser.toolCallId,
    });
  }
  if (state.searchUnavailable) {
    steps.push({
      id: `${state.requestId}-search-unavailable`,
      kind: 'error',
      name: 'web_search',
      label: state.searchUnavailable.message,
      status: 'failed',
    });
  }
  if (state.error) {
    steps.push({ id: `${state.requestId}-error`, kind: 'error', name: '', label: state.error, status: 'failed' });
  }
  return steps;
}

/** `deriveActivitySteps` for a chat turn; user turns and turns without a stream state have none. */
export function turnActivity(turn: ChatTurn): ActivityStep[] {
  if (turn.role !== 'assistant') return [];
  return deriveActivitySteps(turn.streamState);
}

/** Distinct hosts the turn reached, in first-seen order. */
export function turnSites(state: AssistantStreamState | undefined): string[] {
  if (!state) return [];
  const hosts = new Set<string>();
  const add = (url: string | undefined) => {
    if (isHttpUrl(url)) hosts.add(hostOf(url));
  };
  for (const tc of state.toolCalls) {
    for (const src of tc.sources ?? []) add(searchSourceEntry(src).url);
    if (tc.name === 'web_fetch') add(pickString(tc.arguments, ['url']));
  }
  for (const src of state.searchSources) add(searchSourceEntry(src).url);
  for (const block of state.blocks) for (const c of block.citations) add(c.url);
  return [...hosts];
}

export function summarizeStreamState(state: AssistantStreamState | undefined): TurnSummary {
  if (!state) return EMPTY_SUMMARY;
  const steps = deriveActivitySteps(state).filter((s) => s.kind !== 'error');
  return {
    steps: steps.length,
    sites: turnSites(state).length,
    failed: steps.filter((s) => s.status === 'failed').length,
    running: state.streaming,
    needsYou: steps.some((s) => s.status === 'waiting'),
  };
}

export function turnSummary(turn: ChatTurn): TurnSummary {
  if (turn.role !== 'assistant') return EMPTY_SUMMARY;
  return summarizeStreamState(turn.streamState);
}

/** True when `turn` is the one `id` names — a persisted id or the live request id. */
export function turnMatchesId(turn: ChatTurn, id: string): boolean {
  return (
    turn.id === id ||
    turn.streamState?.requestId === id ||
    turn.id === `assistant-${id}`
  );
}
