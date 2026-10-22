import type {
  ConsentPrompt,
  ConnectorRuntimeEvent,
  ContentAnnotation,
  PermissionLevel,
  ProviderEvent,
  ProviderUsage,
  ToolCallStatus,
} from '@conduit/config-schema';
import {
  advanceDocumentWriteScan,
  startDocumentWriteScan,
  type DocumentWriteScan,
} from './documentWriteScan';

export interface ContentBlockState {
  blockId: string;
  blockKind: string;
  content: string;
  /// Phase 7 / M-WebSearch: URL citations bound to this block. The provider
  /// emits one Citation event per annotation, with `startIndex` / `endIndex`
  /// into the block's final text. The renderer inserts inline `[n]` markers
  /// at the exact byte ranges the provider specified.
  citations: CitationAnnotation[];
  /// Reasoning blocks only: when the first and latest deltas arrived, so the
  /// block can say how long the model actually thought. A block rebuilt from
  /// the database carries the times its deltas were saved.
  startedAt?: number;
  lastDeltaAt?: number;
}

export interface CitationAnnotation {
  /// 1-based footnote number, assigned in provider-emission order. Inline
  /// `[n]` markers reference this; a footnote list at the end of the message
  /// lists each title + url.
  index: number;
  url: string;
  title: string;
  startIndex: number;
  endIndex: number;
}

export interface SearchSource {
  /// Pass-through shape from the provider's `web_search_call.action.sources`
  /// array. Provider-agnostic; the renderer shapes for display.
  raw: Record<string, unknown>;
}

export interface ToolCallState {
  toolCallId: string;
  toolId: string;
  name: string;
  argumentsText: string;
  arguments?: Record<string, unknown>;
  complete: boolean;
  /** P3.5 — wall-clock timestamps for the duration pill. */
  startedAt?: number;
  endedAt?: number;
  /** When the most recent argument fragment arrived — the stall signal. */
  lastDeltaAt?: number;
  /** Document content tools only: title + size read from the streaming
   *  arguments, so the UI can show what is being written before it is done. */
  documentWrite?: DocumentWriteScan;
  /// Sources from `SearchSources` events scoped to this web_search call.
  sources?: SearchSource[];
  /** Real consent tier from the MCP runtime (Phase 4). Absent means
   *  "unspecified" — the runtime defaults to read-only and never silently
   *  treats a tool as side-effectful. The v4 name-regex heuristic is gone. */
  permissionLevel?: PermissionLevel;
  /** True when the runtime requested consent (side-effectful or sensitive).
   *  Drives the `.consent` approval gate. */
  sideEffecting?: boolean;
  /** Consent state for the `.consent` approval gate. `pending` is set by a
   *  `ConnectorRuntimeEvent::consentRequested`; `approved`/`denied` by the
   *  user's decision (which the runtime confirms via `toolCallFinished`). */
  consent?: 'pending' | 'approved' | 'denied';
  /** The redacted consent prompt payload (connector name, tool name,
   *  permission level + tool description the renderer composes the expected
   *  effect from, redacted args summary, tenant `consentCopy`). Untrusted
   *  display data — rendered, never executed. */
  consentPrompt?: ConsentPrompt;
  /** Terminal status from `ConnectorRuntimeEvent::toolCallFinished`. */
  status?: ToolCallStatus;
  /** Error message on a failed/cancelled call. */
  error?: string;
  /** Set on an `ask_<agent>` call once the agent starts: the helper's own turn. */
  handoff?: HandoffState;
}

/** One piece of work the assistant handed to a library agent, with that agent's
 *  own turn (its text, tool calls and nested hand-offs) in `inner`. */
export interface HandoffState {
  agentId: string;
  name: string;
  task: string;
  model: string;
  status: 'running' | 'done' | 'failed' | 'stopped';
  tokens: number;
  /** The token split behind `tokens`: live while running, final once finished. */
  usage: HandoffUsage;
  /** The `agent_calls` row id, for Stop and Redirect; empty when none was recorded. */
  callId: string;
  /** The helper's own request id. */
  helperRequestId: string;
  error?: string;
  /** What it answered, from the finish event: a reloaded turn has no streamed text. */
  answer?: string;
  startedAt: number;
  endedAt?: number;
  inner: AssistantStreamState;
}

/** A helper's tokens by kind, as the backend reports them. */
export interface HandoffUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const NO_HANDOFF_USAGE: HandoffUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

/** Tokens from an event or log; a missing or partial split (old logs) reads as zeros. */
function handoffUsageOf(raw: unknown): HandoffUsage {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const n = (v: unknown) =>
    typeof v === 'bigint' ? Number(v) : typeof v === 'number' && Number.isFinite(v) ? v : 0;
  return {
    inputTokens: n(r.inputTokens),
    outputTokens: n(r.outputTokens),
    cacheReadTokens: n(r.cacheReadTokens),
    cacheWriteTokens: n(r.cacheWriteTokens),
  };
}

type HandoffEvent = Extract<
  ProviderEvent,
  { kind: 'handoffStarted' | 'handoff' | 'handoffFinished' | 'handoffUsage' }
>;

/** Chronological turn timeline for UI (kept alongside detail arrays). */
export type TurnSegment =
  | { kind: 'reasoning'; blockId: string }
  | { kind: 'text'; blockId: string }
  | { kind: 'tool'; toolCallId: string }
  | { kind: 'askUser'; toolCallId: string };

export interface AssistantStreamState {
  requestId: string;
  blocks: ContentBlockState[];
  reasoning: ContentBlockState[];
  toolCalls: ToolCallState[];
  /** Ordered render timeline. Empty only for stale in-memory fixtures; new streams always append. */
  segments: TurnSegment[];
  /// Phase 7 / M-WebSearch: sources surfaced by the provider when the user
  /// opted in via `include_sources`. One list per `SearchSources` event.
  searchSources: SearchSource[];
  /// Hosted XOR local for this turn. Local `web_search` needs a runtime finish;
  /// hosted does not. Absent means legacy / unknown (treat web_search as hosted).
  searchBackend?: 'hosted' | 'local' | null;
  /// Phase 7 / M-WebSearch: per-call web-search usage, surfaced alongside
  /// the regular usage summary.
  searchCost?: number;
  /// Phase 7 / M-WebSearch: emitted by the adapter when the hosted-search
  /// tool was stripped or refused (e.g. the endpoint doesn't host it).
  /// The UI renders an explicit "not supported" state instead of silently
  /// losing the user's intent.
  searchUnavailable?: { code: string; message: string };
  usage?: ProviderUsage;
  finishReason?: string;
  error?: string;
  /** `providerCode` of the error that ended the turn, e.g. `turn_time_limit_building`. */
  errorCode?: string;
  interrupted: boolean;
  streaming: boolean;
  /** When the last event that shows the turn is alive arrived (keepalive
   *  pings excluded). The live tail says "still working" once this is old. */
  lastEventAt?: number;
  /** Agent loop phase indicator. undefined = not in agent loop. */
  agentPhase?: {
    /** Current phase label shown to user. */
    label: string;
    /** Round number (1-based). */
    round: number;
    /** Total rounds or undefined if unknown. */
    totalRounds?: number;
    /** Sub-phase for more granular feedback. */
    subPhase:
      | 'connecting'
      | 'thinking'
      | 'writing_document'
      | 'executing_tools'
      | 'reviewing'
      | 'finalizing'
      | 'steering';
    /** Secondary progress shown after the label ("214 lines · 18 KB"). */
    detail?: string;
  };
  /** Pending mid-turn ask_user form (t1-2). */
  askUser?: {
    toolCallId: string;
    title: string;
    fields: Array<{
      id: string;
      prompt: string;
      type: string;
      options?: string[] | null;
    }>;
  };
}

export function createAssistantStreamState(
  requestId: string,
  searchBackend?: 'hosted' | 'local' | null,
): AssistantStreamState {
  return {
    requestId,
    blocks: [],
    reasoning: [],
    toolCalls: [],
    segments: [],
    searchSources: [],
    searchBackend: searchBackend ?? null,
    interrupted: false,
    streaming: true,
    // The request itself is the first sign of life; silence is measured from it.
    lastEventAt: Date.now(),
  };
}

/**
 * The live state for a reply the backend is still running that this window
 * lost track of (a reload): empty but for the question it waits on, if any.
 * Nothing more streams into it, so the caller polls for the turn's end.
 */
export function createReattachedStreamState(
  requestId: string,
  pendingAskUser: {
    toolCallId: string;
    title: string;
    fields: NonNullable<AssistantStreamState['askUser']>['fields'];
  } | null,
): AssistantStreamState {
  const base = createAssistantStreamState(requestId);
  if (!pendingAskUser) return base;
  return {
    ...base,
    askUser: {
      toolCallId: pendingAskUser.toolCallId,
      title: pendingAskUser.title,
      fields: pendingAskUser.fields,
    },
    segments: [{ kind: 'askUser', toolCallId: pendingAskUser.toolCallId }],
  };
}

function isWebSearchToolCall(tc: ToolCallState): boolean {
  return tc.toolId === 'web_search' || tc.name === 'web_search';
}

/**
 * True when a completed provider tool call still needs a runtime
 * `toolCallFinished` / `toolExecutionFinished` before the turn can finalize.
 *
 * Provider-hosted `web_search` is finished by the provider itself — no local
 * runtime event ever arrives — so it must not hold `waitForPendingRuntimeCalls`.
 * Local DuckDuckGo `web_search` is a normal function tool and must wait.
 */
export function toolCallAwaitsRuntimeFinish(
  tc: ToolCallState,
  searchBackend?: 'hosted' | 'local' | null,
): boolean {
  if (!tc.complete || tc.status) return false;
  if (isWebSearchToolCall(tc) && searchBackend !== 'local') return false;
  return true;
}

/** Index of the most recently completed web_search call (for scoping SearchSources). */
function lastCompletedWebSearchIndex(toolCalls: ToolCallState[]): number {
  for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
    if (isWebSearchToolCall(toolCalls[i]) && toolCalls[i].complete) return i;
  }
  return -1;
}

/** Statuses that mean the runtime already reported a terminal outcome. */
const SETTLED_STATUSES: ToolCallStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * Settle tool calls the turn abandoned. A call that got a `toolCallStart` (or
 * a `toolExecutionStarted`) but never a matching finish keeps `endedAt`
 * undefined, which `ToolCallBlock` renders as `running…` forever — the turn is
 * over but the card still claims to be working. Every terminal path runs this
 * so a dead turn leaves nothing pretending to be alive.
 *
 * Calls that already reported a terminal status (or that carry an `endedAt`,
 * which includes provider-hosted `web_search` calls resolved by
 * `toolCallComplete`) are left untouched.
 */
function settleUnfinishedToolCalls(
  calls: ToolCallState[],
  status: 'failed' | 'cancelled',
  reason: string,
  now = Date.now(),
): ToolCallState[] {
  return calls.map((tc) =>
    tc.endedAt === undefined && !SETTLED_STATUSES.includes(tc.status as ToolCallStatus)
      ? { ...tc, status: status as ToolCallStatus, endedAt: now, error: tc.error ?? reason }
      : tc,
  );
}

function citationAlreadyPresent(
  citations: CitationAnnotation[],
  next: Omit<CitationAnnotation, 'index'>,
): boolean {
  return citations.some(
    (c) =>
      c.url === next.url &&
      c.startIndex === next.startIndex &&
      c.endIndex === next.endIndex,
  );
}

/** Last block with this id — later agent-loop rounds reuse `block-0`. */
function lastIndexWithBlockId(blocks: ContentBlockState[], blockId: string): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].blockId === blockId) return i;
  }
  return -1;
}

function updateLastMatchingBlock(
  blocks: ContentBlockState[],
  blockId: string,
  update: (block: ContentBlockState) => ContentBlockState,
): ContentBlockState[] {
  const index = lastIndexWithBlockId(blocks, blockId);
  if (index < 0) return blocks;
  return blocks.map((block, i) => (i === index ? update(block) : block));
}

function countSegments(
  segments: TurnSegment[],
  kind: TurnSegment['kind'],
  id: string,
): number {
  return segments.filter((s) => {
    if (s.kind !== kind) return false;
    if (s.kind === 'tool' || s.kind === 'askUser') return s.toolCallId === id;
    return s.blockId === id;
  }).length;
}

/** Anthropic (and fold.rs) use `thinking`; some adapters use `reasoning`. */
function isReasoningBlockKind(blockKind: string): boolean {
  return blockKind === 'thinking' || blockKind === 'reasoning';
}

/**
 * Ensure a text segment exists for each blocks[] entry with this id (agent rounds
 * reuse ids). Called only after a non-empty contentDelta so empty
 * contentBlockStart / blank deltas cannot push a text segment ahead of reasoning
 * or tools.
 */
function withTextSegmentIfNeeded(
  state: AssistantStreamState,
  blockId: string,
): TurnSegment[] {
  const blockCount = state.blocks.filter((b) => b.blockId === blockId).length;
  const segCount = countSegments(state.segments, 'text', blockId);
  if (blockCount > segCount) {
    return [...state.segments, { kind: 'text', blockId }];
  }
  return state.segments;
}

function withReasoningSegmentIfNeeded(
  segments: TurnSegment[],
  blockId: string,
): TurnSegment[] {
  if (segments.some((s) => s.kind === 'reasoning' && s.blockId === blockId)) {
    return segments;
  }
  return [...segments, { kind: 'reasoning', blockId }];
}

/**
 * Drop text timeline stubs that still have empty content so a late-arriving
 * reasoning/tool segment is not trapped under a phantom prose slot that will
 * later fill in and visually push thoughts/tools to the bottom.
 */
function withoutEmptyTextSegments(state: AssistantStreamState): TurnSegment[] {
  const emptyIds = new Set(
    state.blocks.filter((b) => b.content.length === 0).map((b) => b.blockId),
  );
  if (emptyIds.size === 0) return state.segments;
  // Only drop a text segment when EVERY blocks[] entry with that id is still
  // empty (agent rounds reuse ids; a prior non-empty round must keep its slot).
  const nonEmptyIds = new Set(
    state.blocks.filter((b) => b.content.length > 0).map((b) => b.blockId),
  );
  return state.segments.filter((s) => {
    if (s.kind !== 'text') return true;
    if (nonEmptyIds.has(s.blockId)) return true;
    return !emptyIds.has(s.blockId);
  });
}

export function applyProviderEvent(
  state: AssistantStreamState,
  event: ProviderEvent,
): AssistantStreamState {
  const next = reduceProviderEvent(state, event);
  // A ping proves the connection is open, not that the model is producing
  // anything — exactly the silence "still working" exists to admit.
  if (event.kind === 'ping' || !next.streaming) return next;
  return { ...next, lastEventAt: Date.now() };
}

/** `now` is when the event happened: the clock for a live event, the time it
 *  was saved for one replayed from the log. */
function reduceProviderEvent(
  state: AssistantStreamState,
  event: ProviderEvent,
  now = Date.now(),
): AssistantStreamState {
  if (
    event.kind === 'handoffStarted' ||
    event.kind === 'handoff' ||
    event.kind === 'handoffFinished' ||
    event.kind === 'handoffUsage'
  ) {
    return reduceHandoffEvent(state, event, now);
  }
  switch (event.kind) {
    case 'messageStart':
      return { ...state, streaming: true };
    case 'contentBlockStart': {
      // Match backend fold.rs: thinking/reasoning block starts belong in
      // reasoning[], not as premature text segments.
      if (isReasoningBlockKind(event.blockKind)) {
        const existing = state.reasoning.find((block) => block.blockId === event.blockId);
        if (existing) {
          return state;
        }
        return {
          ...state,
          reasoning: [
            ...state.reasoning,
            {
              blockId: event.blockId,
              blockKind: event.blockKind,
              content: '',
              citations: [],
            },
          ],
          segments: withReasoningSegmentIfNeeded(
            withoutEmptyTextSegments(state),
            event.blockId,
          ),
        };
      }
      const blocks = [
        ...state.blocks,
        { blockId: event.blockId, blockKind: event.blockKind, content: '', citations: [] },
      ];
      return {
        ...state,
        blocks,
        // Text segment deferred until the first non-empty contentDelta.
      };
    }
    case 'contentDelta': {
      if (event.content.length === 0) {
        return state;
      }
      const blocks = updateLastMatchingBlock(state.blocks, event.blockId, (block) => ({
        ...block,
        content: block.content + event.content,
      }));
      const next = { ...state, blocks };
      return {
        ...next,
        segments: withTextSegmentIfNeeded(next, event.blockId),
      };
    }
    case 'reasoningDelta': {
      const existing = state.reasoning.find((block) => block.blockId === event.blockId);
      if (existing) {
        return {
          ...state,
          reasoning: state.reasoning.map((block) =>
            block.blockId === event.blockId
              ? { ...block, content: block.content + event.content, lastDeltaAt: now }
              : block,
          ),
          segments: withReasoningSegmentIfNeeded(state.segments, event.blockId),
        };
      }
      return {
        ...state,
        reasoning: [
          ...state.reasoning,
          {
            blockId: event.blockId,
            blockKind: 'reasoning',
            content: event.content,
            citations: [],
            startedAt: now,
            lastDeltaAt: now,
          },
        ],
        segments: withReasoningSegmentIfNeeded(
          withoutEmptyTextSegments(state),
          event.blockId,
        ),
      };
    }
    case 'toolCallStart': {
      // Phase 4: the provider stream no longer guesses side-effectfulness from
      // the tool name. `sideEffecting`/`consent` arrive later via
      // `ConnectorRuntimeEvent::consentRequested` (see applyConnectorRuntimeEvent).
      // A hand-off that started first already made a placeholder for this call.
      if (state.toolCalls.some((tc) => tc.toolCallId === event.toolCallId)) {
        return {
          ...state,
          toolCalls: state.toolCalls.map((tc) =>
            tc.toolCallId === event.toolCallId
              ? { ...tc, toolId: event.toolId, name: event.name, startedAt: tc.startedAt ?? now }
              : tc,
          ),
        };
      }
      return {
        ...state,
        toolCalls: [
          ...state.toolCalls,
          {
            toolCallId: event.toolCallId,
            toolId: event.toolId,
            name: event.name,
            argumentsText: '',
            complete: false,
            startedAt: now,
            documentWrite: startDocumentWriteScan(event.name),
          },
        ],
        // Keep tools in event order; strip empty text stubs so a tool that
        // fires during thinking is not trapped under a later-filled answer.
        segments: [
          ...withoutEmptyTextSegments(state),
          { kind: 'tool', toolCallId: event.toolCallId },
        ],
      };
    }
    case 'toolCallDelta':
      return {
        ...state,
        toolCalls: state.toolCalls.map((toolCall) =>
          toolCall.toolCallId === event.toolCallId
            ? {
                ...toolCall,
                argumentsText: toolCall.argumentsText + event.content,
                lastDeltaAt: now,
                ...(toolCall.documentWrite
                  ? { documentWrite: advanceDocumentWriteScan(toolCall.documentWrite, event.content) }
                  : {}),
              }
            : toolCall,
        ),
      };
    case 'toolCallComplete': {
      const completed = state.toolCalls.find((tc) => tc.toolCallId === event.toolCallId);
      let embeddedSources: SearchSource[] | undefined;
      if (
        completed &&
        isWebSearchToolCall(completed) &&
        Array.isArray(event.arguments?.sources)
      ) {
        embeddedSources = (event.arguments.sources as unknown[]).map((raw) => ({
          raw: (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>,
        }));
      }
      // Hosted web_search is already done on the provider side. Mark it
      // completed here so the chat view does not wait 30s for a runtime finish
      // that never comes (and so settle-on-error leaves it alone).
      // Local DuckDuckGo web_search awaits the normal runtime finish.
      const hostedSearchDone =
        !!completed &&
        isWebSearchToolCall(completed) &&
        state.searchBackend !== 'local';
      return {
        ...state,
        toolCalls: state.toolCalls.map((toolCall) =>
          toolCall.toolCallId === event.toolCallId
            ? {
                ...toolCall,
                arguments: event.arguments,
                complete: true,
                ...(hostedSearchDone ? { status: 'completed' as ToolCallStatus } : {}),
                ...(embeddedSources
                  ? { sources: [...(toolCall.sources ?? []), ...embeddedSources] }
                  : {}),
                endedAt: now,
              }
            : toolCall,
        ),
      };
    }
    case 'usage':
      return { ...state, usage: event.usage };
    // Both terminal events clear the phase. It described what the turn was
    // doing; once the turn is over it describes nothing, and leaving it set
    // means any future reader of `agentPhase` shows a finished turn as still
    // "Continuing…". Today that is invisible only because every consumer also
    // gates on `streaming` — a coincidence, not a design.
    case 'messageComplete':
      return {
        ...state,
        finishReason: event.finishReason,
        streaming: false,
        agentPhase: undefined,
      };
    case 'error':
      return {
        ...state,
        error: event.error.message,
        errorCode: event.error.providerCode,
        streaming: false,
        agentPhase: undefined,
        toolCalls: settleHandoffs(
          settleUnfinishedToolCalls(
            state.toolCalls,
            'failed',
            'The turn ended before this tool finished.',
            now,
          ),
          'failed',
          now,
        ),
      };
    case 'searchSources': {
      const incoming = event.sources.map((raw) => ({ raw }));
      // Local web_search names its call; a provider's hosted search does not,
      // and attaches to the latest finished search.
      const byId = event.toolCallId
        ? state.toolCalls.findIndex((tc) => tc.toolCallId === event.toolCallId)
        : -1;
      const attachIdx = byId >= 0 ? byId : lastCompletedWebSearchIndex(state.toolCalls);
      const toolCalls =
        attachIdx >= 0
          ? state.toolCalls.map((tc, i) =>
              i === attachIdx
                ? { ...tc, sources: [...(tc.sources ?? []), ...incoming] }
                : tc,
            )
          : state.toolCalls;
      return {
        ...state,
        toolCalls,
        searchSources: [...state.searchSources, ...incoming],
      };
    }
    case 'citation': {
      // Phase 7 / M-WebSearch: append a URL citation to the block it
      // belongs to. The 1-based `index` is the citation's footnote number,
      // assigned in provider-emission order so the renderer can insert
      // inline `[n]` markers deterministically.
      const annotation = event.annotation;
      if (annotation.kind !== 'urlCitation') {
        return state;
      }
      const next: CitationAnnotation = {
        index: 0,
        url: annotation.url,
        title: annotation.title,
        startIndex: annotation.startIndex,
        endIndex: annotation.endIndex,
      };
      const targetIndex = lastIndexWithBlockId(state.blocks, event.blockId);
      if (targetIndex < 0) {
        const citationsBefore = state.blocks.reduce((acc, b) => acc + b.citations.length, 0);
        return {
          ...state,
          blocks: [
            ...state.blocks,
            {
              blockId: event.blockId,
              blockKind: 'text',
              content: '',
              citations: [{ ...next, index: citationsBefore + 1 }],
            },
          ],
          segments: [...state.segments, { kind: 'text', blockId: event.blockId }],
        };
      }
      const target = state.blocks[targetIndex];
      if (citationAlreadyPresent(target.citations, next)) {
        return state;
      }
      const citationsBefore = state.blocks
        .slice(0, targetIndex)
        .reduce((acc, b) => acc + b.citations.length, 0);
      const idx: CitationAnnotation = {
        ...next,
        index: citationsBefore + target.citations.length + 1,
      };
      return {
        ...state,
        blocks: updateLastMatchingBlock(state.blocks, event.blockId, (block) => ({
          ...block,
          citations: [...block.citations, idx],
        })),
      };
    }
    case 'searchCost':
      // Phase 7 / M-WebSearch: per-response tool-call count. Surface as a
      // scalar on the stream state; the UsageSummary picks it up.
      return { ...state, searchCost: (state.searchCost ?? 0) + event.toolCalls };
    case 'searchUnavailable':
      return {
        ...state,
        searchUnavailable: { code: event.code, message: event.message },
      };
    case 'agentPhase':
      return {
        ...state,
        agentPhase: {
          label: event.label,
          round: event.round,
          totalRounds: event.totalRounds > 0 ? event.totalRounds : undefined,
          subPhase: event.subPhase as
            | 'thinking'
            | 'connecting'
            | 'executing_tools'
            | 'reviewing'
            | 'finalizing'
            | 'steering',
        },
      };
    case 'askUserRequested':
      return {
        ...state,
        askUser: {
          toolCallId: event.toolCallId,
          title: event.title,
          fields: event.fields.map((f) => ({
            id: f.id,
            prompt: f.prompt,
            type: f.type,
            options: f.options ?? null,
          })),
        },
        segments: state.segments.some(
          (s) => s.kind === 'askUser' && s.toolCallId === event.toolCallId,
        )
          ? state.segments
          : [...state.segments, { kind: 'askUser', toolCallId: event.toolCallId }],
      };
    case 'toolExecutionStarted': {
      // Mark the matching tool call as executing (not yet complete).
      return {
        ...state,
        toolCalls: state.toolCalls.map((tc) =>
          tc.toolCallId === event.toolCallId
            ? { ...tc, status: 'running' as ToolCallStatus }
            : tc,
        ),
      };
    }
    case 'toolExecutionFinished':
      return {
        ...state,
        askUser:
          state.askUser?.toolCallId === event.toolCallId ? undefined : state.askUser,
        toolCalls: state.toolCalls.map((tc) =>
          tc.toolCallId === event.toolCallId
            ? {
                ...tc,
                status: event.isError ? 'failed' as ToolCallStatus : 'completed' as ToolCallStatus,
                error: event.error ?? tc.error,
                endedAt: now,
              }
            : tc,
        ),
      };
    default:
      return state;
  }
}

function reduceHandoffEvent(
  state: AssistantStreamState,
  event: HandoffEvent,
  now: number,
): AssistantStreamState {
  const id = event.toolCallId;
  let base = state;
  if (!base.toolCalls.some((tc) => tc.toolCallId === id)) {
    // The hand-off can be announced before the lead's tool call is.
    const agentTool = event.kind === 'handoffStarted' ? `ask_${event.agentId}` : 'ask_agent';
    base = {
      ...base,
      toolCalls: [
        ...base.toolCalls,
        {
          toolCallId: id,
          toolId: agentTool,
          name: agentTool,
          argumentsText: '',
          complete: false,
          startedAt: now,
        },
      ],
      segments: [...withoutEmptyTextSegments(base), { kind: 'tool', toolCallId: id }],
    };
  }
  const update = (fn: (handoff: HandoffState | undefined) => HandoffState | undefined) => ({
    ...base,
    toolCalls: base.toolCalls.map((tc) =>
      tc.toolCallId === id ? { ...tc, handoff: fn(tc.handoff) } : tc,
    ),
  });
  switch (event.kind) {
    case 'handoffStarted':
      return update(() => ({
        agentId: event.agentId,
        name: event.name,
        task: event.task,
        model: event.model,
        status: 'running',
        tokens: 0,
        usage: NO_HANDOFF_USAGE,
        callId: event.callId ?? '',
        helperRequestId: event.helperRequestId ?? '',
        startedAt: now,
        inner: createAssistantStreamState(state.requestId, null),
      }));
    case 'handoffUsage':
      // Live totals after each of the helper's rounds; a late one never reopens a finished helper.
      return update((handoff) =>
        handoff && handoff.status === 'running'
          ? { ...handoff, tokens: event.tokens, usage: handoffUsageOf(event.usage) }
          : handoff,
      );
    case 'handoff':
      return update((handoff) =>
        handoff
          ? { ...handoff, inner: reduceProviderEvent(handoff.inner, event.event, now) }
          : handoff,
      );
    case 'handoffFinished':
      return update((handoff) =>
        handoff
          ? {
              ...handoff,
              status:
                event.status === 'done' || event.status === 'failed' || event.status === 'stopped'
                  ? event.status
                  : 'failed',
              tokens: event.tokens,
              usage: event.usage ? handoffUsageOf(event.usage) : handoff.usage,
              error: event.error ?? undefined,
              answer: event.answer ?? undefined,
              endedAt: now,
              inner: { ...handoff.inner, streaming: false },
            }
          : handoff,
      );
  }
}

/** Close hand-offs a dead turn left running, and everything running inside them. */
function settleHandoffs(
  calls: ToolCallState[],
  status: 'failed' | 'stopped',
  now = Date.now(),
): ToolCallState[] {
  return calls.map((tc) => {
    const handoff = tc.handoff;
    if (!handoff) return tc;
    const innerCalls = settleHandoffs(
      settleUnfinishedToolCalls(
        handoff.inner.toolCalls,
        status === 'stopped' ? 'cancelled' : 'failed',
        status === 'stopped' ? 'Stopped before this tool finished.' : 'The turn ended before this tool finished.',
        now,
      ),
      status,
      now,
    );
    return {
      ...tc,
      handoff: {
        ...handoff,
        status: handoff.status === 'running' ? status : handoff.status,
        endedAt: handoff.endedAt ?? now,
        inner: { ...handoff.inner, streaming: false, toolCalls: innerCalls },
      },
    };
  });
}

/** Run `fn` over this state's tool calls and, recursively, those inside hand-offs. */
function mapToolCallsDeep(
  state: AssistantStreamState,
  fn: (tc: ToolCallState) => ToolCallState,
): AssistantStreamState {
  return {
    ...state,
    toolCalls: state.toolCalls.map((tc) => {
      const mapped = fn(tc);
      return mapped.handoff
        ? { ...mapped, handoff: { ...mapped.handoff, inner: mapToolCallsDeep(mapped.handoff.inner, fn) } }
        : mapped;
    }),
  };
}

/** The name of the last tool call of this turn that has not finished, if any. */
export function currentTool(state: AssistantStreamState): string | null {
  for (let i = state.toolCalls.length - 1; i >= 0; i -= 1) {
    const tc = state.toolCalls[i];
    if (tc.handoff) continue;
    if (tc.endedAt === undefined && !SETTLED_STATUSES.includes(tc.status as ToolCallStatus)) return tc.name;
  }
  return null;
}

/** Every tool call in the turn, including those inside hand-offs. */
export function allToolCalls(state: AssistantStreamState): ToolCallState[] {
  return state.toolCalls.flatMap((tc) => [tc, ...(tc.handoff ? allToolCalls(tc.handoff.inner) : [])]);
}

/** A saved turn as `get_request_event_log` returns it: each event with the
 *  time it was saved, and when each finished tool call finished. */
export interface RequestEventLog {
  events: { event: ProviderEvent; at: string }[];
  toolFinishedAt: Record<string, string>;
}

/** Replay provider events into a finalized assistant stream state (reload path). */
export function rebuildAssistantStreamStateFromEvents(
  requestId: string,
  events: ProviderEvent[],
): AssistantStreamState {
  return replayEvents(requestId, events.map((event) => ({ event })), {});
}

/**
 * Replay a saved turn with its own times. Replaying on the clock times the
 * replay — every tool read "1ms" and every think "1s" after a restart — so
 * each event runs at the time it was saved, and each tool call ends when its
 * row says it finished (the execution events that end it live are not saved).
 */
export function rebuildAssistantStreamStateFromLog(
  requestId: string,
  log: RequestEventLog,
): AssistantStreamState {
  const finishedAt: Record<string, number> = {};
  for (const [id, iso] of Object.entries(log.toolFinishedAt ?? {})) {
    const ms = Date.parse(iso);
    if (Number.isFinite(ms)) finishedAt[id] = ms;
  }
  return replayEvents(
    requestId,
    log.events.map(({ event, at }) => ({ event, at: Date.parse(at) })),
    finishedAt,
  );
}

function replayEvents(
  requestId: string,
  events: { event: ProviderEvent; at?: number }[],
  toolFinishedAt: Record<string, number>,
): AssistantStreamState {
  let state = createAssistantStreamState(requestId);
  let clock: number | undefined;
  for (const { event, at } of events) {
    // Unparseable or missing times hold the last known one, so a gap reads as
    // no time rather than as the time since the turn ran.
    if (at !== undefined && Number.isFinite(at)) clock = at;
    state = reduceProviderEvent(state, event, clock);
  }
  const toolCalls = state.toolCalls.map((tc) => {
    const end = toolFinishedAt[tc.toolCallId];
    return end !== undefined && tc.startedAt !== undefined && end >= Math.max(tc.startedAt, tc.endedAt ?? 0)
      ? { ...tc, endedAt: end }
      : tc;
  });
  // The replayed turn is definitionally over. Terminal events emitted by the
  // agent loop (rather than a provider round) are not persisted, so a turn that
  // died mid-execution replays with calls that never finished — settle them
  // here or the reloaded conversation shows `running…` cards forever.
  return {
    ...state,
    streaming: false,
    toolCalls: settleHandoffs(
      settleUnfinishedToolCalls(
        toolCalls,
        'failed',
        'The turn ended before this tool finished.',
        clock,
      ),
      'stopped',
      clock,
    ),
  };
}

export function markInterrupted(state: AssistantStreamState): AssistantStreamState {
  return {
    ...state,
    interrupted: true,
    streaming: false,
    finishReason: 'cancelled',
    agentPhase: undefined,
    toolCalls: settleHandoffs(
      settleUnfinishedToolCalls(
        state.toolCalls,
        'cancelled',
        'Stopped before this tool finished.',
      ),
      'stopped',
    ),
  };
}

/// Apply a `ConnectorRuntimeEvent` to the assistant stream state. The MCP
/// runtime emits these on a separate per-call channel; the chat view routes
/// them here so a tool call's consent gate + terminal status are driven by the
/// real runtime, not a name regex.
///
/// `consentRequested` flips the matching tool call to `pending` + side-effecting
/// and stores the redacted prompt for the `.consent` gate. `toolCallFinished`
/// records the terminal status + error and resolves consent (a `cancelled`
/// status means the user denied or the request was dropped).
export function applyConnectorRuntimeEvent(
  state: AssistantStreamState,
  event: ConnectorRuntimeEvent,
): AssistantStreamState {
  const next = reduceConnectorRuntimeEvent(state, event);
  if (next === state || !next.streaming) return next;
  return { ...next, lastEventAt: Date.now() };
}

function reduceConnectorRuntimeEvent(
  state: AssistantStreamState,
  event: ConnectorRuntimeEvent,
): AssistantStreamState {
  switch (event.kind) {
    case 'consentRequested': {
      const prompt = event.prompt;
      return mapToolCallsDeep(state, (tc) =>
        tc.toolCallId === prompt.toolCallId
          ? {
              ...tc,
              sideEffecting: true,
              consent: 'pending',
              consentPrompt: prompt,
            }
          : tc,
      );
    }
    case 'toolCallFinished': {
      const denied = event.status === 'cancelled';
      return mapToolCallsDeep(state, (tc) =>
        tc.toolCallId === event.tool_call_id
          ? {
              ...tc,
              complete: true,
              status: event.status,
              error: event.error,
              endedAt: Date.now(),
              consent:
                tc.consent === 'pending'
                  ? denied
                    ? 'denied'
                    : 'approved'
                  : tc.consent,
            }
          : tc,
      );
    }
    case 'connectorStarted':
    case 'connectorHealthChanged':
    case 'connectorRevoked':
      // Connector-level lifecycle events don't mutate per-tool state here; the
      // connectors rail subscribes to them separately.
      return state;
    default:
      return state;
  }
}
