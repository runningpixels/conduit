import type {
  ConsentPrompt,
  ConnectorRuntimeEvent,
  PermissionLevel,
  ProviderEvent,
  ProviderUsage,
  ToolCallStatus,
} from '@conduit/config-schema';

export interface ContentBlockState {
  blockId: string;
  blockKind: string;
  content: string;
}

export interface ToolCallState {
  toolCallId: string;
  toolId: string;
  name: string;
  argumentsText: string;
  arguments?: Record<string, unknown>;
  complete: boolean;
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
  usage?: ProviderUsage;
  finishReason?: string;
  error?: string;
  interrupted: boolean;
  streaming: boolean;
}

export function createAssistantStreamState(requestId: string): AssistantStreamState {
  return {
    requestId,
    blocks: [],
    reasoning: [],
    toolCalls: [],
    interrupted: false,
    streaming: true,
  };
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
          { blockId: event.blockId, blockKind: event.blockKind, content: '' },
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
          { blockId: event.blockId, blockKind: 'reasoning', content: event.content },
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
    case 'toolCallComplete':
      return {
        ...state,
        toolCalls: state.toolCalls.map((toolCall) =>
          toolCall.toolCallId === event.toolCallId
            ? { ...toolCall, arguments: event.arguments, complete: true }
            : toolCall,
        ),
      };
    case 'usage':
      return { ...state, usage: event.usage };
    case 'messageComplete':
      return { ...state, finishReason: event.finishReason, streaming: false };
    case 'error':
      return {
        ...state,
        error: event.error.message,
        streaming: false,
      };
    default:
      return state;
  }
}

export function markInterrupted(state: AssistantStreamState): AssistantStreamState {
  return {
    ...state,
    interrupted: true,
    streaming: false,
    finishReason: 'cancelled',
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
