import type {
  ConsentPrompt,
  ConnectorRuntimeEvent,
  ContentAnnotation,
  PermissionLevel,
  ProviderEvent,
  ProviderUsage,
  ToolCallStatus,
} from '@conduit/config-schema';

export interface ContentBlockState {
  blockId: string;
  blockKind: string;
  content: string;
  /// Phase 7 / M-WebSearch: URL citations bound to this block. The provider
  /// emits one Citation event per annotation, with `startIndex` / `endIndex`
  /// into the block's final text. The renderer inserts inline `[n]` markers
  /// at the exact byte ranges the provider specified.
  citations: CitationAnnotation[];
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
  /** The redacted consent prompt payload (connector name, tool name, expected
   *  effect, redacted args summary, tenant `consentCopy`). Untrusted display
   *  data — rendered, never executed. */
  consentPrompt?: ConsentPrompt;
  /** Terminal status from `ConnectorRuntimeEvent::toolCallFinished`. */
  status?: ToolCallStatus;
  /** Error message on a failed/cancelled call. */
  error?: string;
}

export interface AssistantStreamState {
  requestId: string;
  blocks: ContentBlockState[];
  reasoning: ContentBlockState[];
  toolCalls: ToolCallState[];
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
  interrupted: boolean;
  streaming: boolean;
  /** Agent loop phase indicator. undefined = not in agent loop. */
  agentPhase?: {
    /** Current phase label shown to user. */
    label: string;
    /** Round number (1-based). */
    round: number;
    /** Total rounds or undefined if unknown. */
    totalRounds?: number;
    /** Sub-phase for more granular feedback. */
    subPhase: 'connecting' | 'thinking' | 'executing_tools' | 'reviewing' | 'finalizing';
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
    searchSources: [],
    searchBackend: searchBackend ?? null,
    interrupted: false,
    streaming: true,
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
): ToolCallState[] {
  return calls.map((tc) =>
    tc.endedAt === undefined && !SETTLED_STATUSES.includes(tc.status as ToolCallStatus)
      ? { ...tc, status: status as ToolCallStatus, endedAt: Date.now(), error: tc.error ?? reason }
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

export function applyProviderEvent(
  state: AssistantStreamState,
  event: ProviderEvent,
): AssistantStreamState {
  switch (event.kind) {
    case 'messageStart':
      return { ...state, streaming: true };
    case 'contentBlockStart':
      return {
        ...state,
        blocks: [
          ...state.blocks,
          { blockId: event.blockId, blockKind: event.blockKind, content: '', citations: [] },
        ],
      };
    case 'contentDelta':
      return {
        ...state,
        blocks: state.blocks.map((block) =>
          block.blockId === event.blockId
            ? { ...block, content: block.content + event.content }
            : block,
        ),
      };
    case 'reasoningDelta': {
      const existing = state.reasoning.find((block) => block.blockId === event.blockId);
      if (existing) {
        return {
          ...state,
          reasoning: state.reasoning.map((block) =>
            block.blockId === event.blockId
              ? { ...block, content: block.content + event.content }
              : block,
          ),
        };
      }
      return {
        ...state,
        reasoning: [
          ...state.reasoning,
          { blockId: event.blockId, blockKind: 'reasoning', content: event.content, citations: [] },
        ],
      };
    }
    case 'toolCallStart': {
      // Phase 4: the provider stream no longer guesses side-effectfulness from
      // the tool name. `sideEffecting`/`consent` arrive later via
      // `ConnectorRuntimeEvent::consentRequested` (see applyConnectorRuntimeEvent).
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
            startedAt: Date.now(),
          },
        ],
      };
    }
    case 'toolCallDelta':
      return {
        ...state,
        toolCalls: state.toolCalls.map((toolCall) =>
          toolCall.toolCallId === event.toolCallId
            ? { ...toolCall, argumentsText: toolCall.argumentsText + event.content }
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
                endedAt: Date.now(),
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
        streaming: false,
        agentPhase: undefined,
        toolCalls: settleUnfinishedToolCalls(
          state.toolCalls,
          'failed',
          'The turn ended before this tool finished.',
        ),
      };
    case 'searchSources': {
      const incoming = event.sources.map((raw) => ({ raw }));
      const attachIdx = lastCompletedWebSearchIndex(state.toolCalls);
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
      const target = state.blocks.find((block) => block.blockId === event.blockId);
      if (!target) {
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
        };
      }
      if (citationAlreadyPresent(target.citations, next)) {
        return state;
      }
      const blocks = state.blocks.map((block, blockIndex, all) => {
        if (block.blockId !== event.blockId) return block;
        const citationsBefore = all
          .slice(0, blockIndex)
          .reduce((acc, b) => acc + b.citations.length, 0);
        const idx: CitationAnnotation = {
          ...next,
          index: citationsBefore + block.citations.length + 1,
        };
        return { ...block, citations: [...block.citations, idx] };
      });
      return { ...state, blocks };
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
          subPhase: event.subPhase as 'thinking' | 'connecting' | 'executing_tools' | 'reviewing' | 'finalizing',
        },
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
        toolCalls: state.toolCalls.map((tc) =>
          tc.toolCallId === event.toolCallId
            ? {
                ...tc,
                status: event.isError ? 'failed' as ToolCallStatus : 'completed' as ToolCallStatus,
                error: event.error ?? tc.error,
                endedAt: Date.now(),
              }
            : tc,
        ),
      };
    default:
      return state;
  }
}

/** Replay provider events into a finalized assistant stream state (reload path). */
export function rebuildAssistantStreamStateFromEvents(
  requestId: string,
  events: ProviderEvent[],
): AssistantStreamState {
  let state = createAssistantStreamState(requestId);
  for (const event of events) {
    state = applyProviderEvent(state, event);
  }
  // The replayed turn is definitionally over. Terminal events emitted by the
  // agent loop (rather than a provider round) are not persisted, so a turn that
  // died mid-execution replays with calls that never finished — settle them
  // here or the reloaded conversation shows `running…` cards forever.
  return {
    ...state,
    streaming: false,
    toolCalls: settleUnfinishedToolCalls(
      state.toolCalls,
      'failed',
      'The turn ended before this tool finished.',
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
    toolCalls: settleUnfinishedToolCalls(
      state.toolCalls,
      'cancelled',
      'Stopped before this tool finished.',
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
  switch (event.kind) {
    case 'consentRequested': {
      const prompt = event.prompt;
      return {
        ...state,
        toolCalls: state.toolCalls.map((tc) =>
          tc.toolCallId === prompt.toolCallId
            ? {
                ...tc,
                sideEffecting: true,
                consent: 'pending',
                consentPrompt: prompt,
              }
            : tc,
        ),
      };
    }
    case 'toolCallFinished': {
      const denied = event.status === 'cancelled';
      return {
        ...state,
        toolCalls: state.toolCalls.map((tc) =>
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
        ),
      };
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
