import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { AppSettings, MessageRole, ProviderRequest } from '@conduit/config-schema';
import {
  cancelChatStream,
  discoverConnector,
  getArtifact,
  getConnectorRuntimeStates,
  getConversationMessages,
  invokeConnectorTool,
  listConnectorCapabilities,
  removeLastTurn,
  startConnector,
  startChatStream,
  updateSettings,
} from '../ipc/client';
import { AssistantMessage } from './AssistantMessage';
import { AssistantArtifactStrip } from './ArtifactRefChip';
import { BotGlyph } from '../icons';
import { ChatMessageContent } from './ChatMessageContent';
import { detectArtifactCandidates, type ArtifactCandidate } from './artifactCandidates';
import { CONDUIT_ARTIFACT_SYSTEM_APPENDIX, looksLikeArtifactCreationRequest } from './artifactPrompt';
import { webSearchDeveloperPromptFor } from './webSearchDeveloperPrompt';
import {
  buildArtifactEditDeveloperPrompt,
  resolveFollowUpArtifactContext,
  type FollowUpArtifactContext,
} from './artifactFollowUpContext';
import type { Artifact, FileState } from '../ipc/contracts';
import {
  applyConnectorRuntimeEvent,
  applyProviderEvent,
  createAssistantStreamState,
  type AssistantStreamState,
} from './streamState';
import { hydrateAssistantTurn, type ChatTurn } from './conversationHydration';
import type { StatusState } from './statusTypes';
import { makeStatus } from './statusTypes';
import { ChatErrorBoundary } from './ChatErrorBoundary';
import { Composer, type ComposerHandle } from './Composer';
import { WebSearchConsentDialog } from '../workspace/settings/WebSearchConsentDialog';
import { SuggestedPrompts } from './SuggestedPrompts';
import { deriveSuggestedPrompts } from './suggestedPromptLogic';
import { getMessageIdByRequest } from '../ipc/client';
import { resolveWebSearchForTurn } from './webSearchIntent';
import type { ConnectorCapability, ConnectorRuntimeEvent } from '../ipc/contracts';
import type { ToolDefinition } from '@conduit/config-schema';
import {
  buildConnectorToolCatalog,
  isConnectorCallable,
  makeInvokeConnectorToolRequest,
  type ConnectorToolBinding,
} from './connectorTools';
import {
  failedDocumentToolCalls,
  hadSuccessfulDocumentToolCalls,
  isDocumentContentTool,
  selectBuiltinDocumentTools,
  type DocumentToolActivity,
} from './agentTools';
import {
  classifyDocumentTurnIntent,
  informationalDeveloperPromptFor,
} from './documentTurnIntent';

export type { ChatTurn } from './conversationHydration';
export type { DocumentToolActivity } from './agentTools';

export interface ChatViewHandle {
  stopStreaming: () => void;
  copyLastAssistantMessage: () => Promise<boolean>;
  isStreaming: () => boolean;
  /// Scroll a message into view (used by FTS5 search navigation).
  scrollToMessage: (messageId: string) => void;
  /// Insert text at the composer cursor position (used by prompts library).
  insertPrompt: (text: string) => void;
}

interface ChatViewProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  onStatus: (message: string | StatusState) => void;
  /// Active conversation id (owned by App; the history rail drives selection).
  /// `null` only briefly during boot before App ensures a conversation exists.
  conversationId: string | null;
  /// M2: the conversation's artifacts, for in-chat reference chips + promote
  /// affordances at the end of each assistant turn.
  artifacts: Artifact[];
  /// M2: per-artifact file-state, for the chip state dots.
  fileStateMap: Record<string, FileState>;
  /// M2: promote a detected fenced-block candidate to an artifact (App owns the
  /// create + setContent + open flow).
  onPromoteArtifact: (messageId: string, candidate: ArtifactCandidate) => void;
  /// M2: open an existing artifact in the DocumentPanel (chip click).
  onOpenArtifact: (artifactId: string) => void;
  /// After a completed assistant turn — refresh/open artifacts created via agent tools.
  onChatTurnComplete?: (streamState: AssistantStreamState) => void;
  /// Fired when a document create/edit tool starts or finishes argument streaming.
  onDocumentToolActivity?: (activity: DocumentToolActivity) => void;
  /// Fired when the user requests to fork the conversation at a message.
  onForkConversation?: (conversationId: string, forkMessageId: string) => void;
  /// Whether this pane is the active workspace tab (`data-active` for CSS). Defaults true for tests.
  paneActive?: boolean;
}

/// Extracts a human-readable message from a Tauri `invoke` rejection.
/// Tauri commands returning `Result<T, String>` reject with the serialized
/// error (a plain string, or an object), not an `Error` instance — so
/// `error instanceof Error` is false and the generic "Stream failed" would
/// otherwise swallow the real reason. Fall back through the common shapes.
export function describeInvokeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; error?: unknown };
    if (typeof value.message === 'string') return value.message;
    if (typeof value.error === 'string') return value.error;
    try {
      return JSON.stringify(error);
    } catch {
      return 'Stream failed';
    }
  }
  return 'Stream failed';
}

export const BASE_SYSTEM_PROMPT = 'You are a helpful assistant in the Conduit desktop shell.';

export function buildProviderRequest(
  settings: AppSettings,
  prompt: string,
  history: ChatTurn[],
  conversationId: string,
  toolDefinitions: ToolDefinition[],
  followUpArtifact?: FollowUpArtifactContext,
  /// Phase 7 / M-WebSearch: per-turn search toggle. Defaults false.
  webSearchOn?: boolean,
): ProviderRequest {
  const now = new Date().toISOString();
  const messages = history
    .filter(
      (turn) =>
        (turn.role === 'user' || turn.role === 'assistant') &&
        turn.content.trim() !== '',
    )
    .map((turn) => ({
      // Use each turn's own globally-unique id (UUID for new user turns, DB
      // primary key for reloaded turns) so re-sent history dedupes WITHIN a
      // conversation via `INSERT OR IGNORE`, but never collides ACROSS
      // conversations. The previous `msg-${index}` scheme reset to `msg-0`
      // for every conversation, so the second conversation's first user turn
      // silently failed the PK insert and its content was lost on reload.
      id: turn.id,
      conversationId,
      role: turn.role as MessageRole,
      parts: [
        {
          id: `${turn.id}-part-0`,
          messageId: turn.id,
          index: 0,
          kind: 'text' as const,
          content: turn.content,
          createdAt: now,
        },
      ],
      createdAt: now,
    }));
  // Creation intent is used only to gate tool visibility, the post-hoc warning,
  // and to suppress edit/informational developer prompts. We deliberately do NOT
  // inject a positive "you must create an artifact" developer prompt here: the
  // system appendix already states the contract, and a false-positive intent
  // match would otherwise pressure the model into creating an artifact on a
  // question turn (the original cause of the spurious "no artifact content"
  // warning).
  const isCreationIntent = looksLikeArtifactCreationRequest(prompt);
  const webSearch = webSearchOn
    ? {
        enabled: true,
        searchContextSize: settings.webSearch.searchContextSize,
        ...(settings.webSearch.allowedDomains.length > 0 ||
        settings.webSearch.blockedDomains.length > 0
          ? {
              filters: {
                ...(settings.webSearch.allowedDomains.length > 0
                  ? { allowedDomains: settings.webSearch.allowedDomains }
                  : {}),
                ...(settings.webSearch.blockedDomains.length > 0
                  ? { blockedDomains: settings.webSearch.blockedDomains }
                  : {}),
              },
            }
          : {}),
        externalWebAccess: settings.webSearch.externalWebAccess,
        returnTokenBudget: settings.webSearch.returnTokenBudget,
        userLocation: settings.webSearch.userLocation,
        includeSources: settings.webSearch.includeSources,
      }
    : undefined;
  const infoDevPrompt =
    !isCreationIntent && !webSearch ? informationalDeveloperPromptFor(prompt) : undefined;
  const editDevPrompt =
    !isCreationIntent && !infoDevPrompt && followUpArtifact
      ? buildArtifactEditDeveloperPrompt(followUpArtifact, prompt)
      : undefined;
  const webSearchDevPrompt = webSearch ? webSearchDeveloperPromptFor() : undefined;
  const developerPrompt =
    [infoDevPrompt, editDevPrompt, webSearchDevPrompt].filter(Boolean).join('\n\n') || undefined;
  const systemPrompt =
    webSearch && !isCreationIntent
      ? BASE_SYSTEM_PROMPT
      : `${BASE_SYSTEM_PROMPT} ${CONDUIT_ARTIFACT_SYSTEM_APPENDIX}`;

  return {
    requestId: crypto.randomUUID(),
    conversationId,
    modelId: settings.activeModel,
    messages,
    systemPrompt,
    developerPrompt,
    toolDefinitions,
    webSearch,
  };
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Derive agent loop phase from stream state and pending calls.
 *  Prefers backend-sent agent phase info when available (from ProviderEvent::AgentPhase
 *  events emitted by run_agent_turn in Rust). Falls back to frontend derivation when
 *  the backend hasn't sent phase info yet (e.g. during the initial provider round). */
function deriveAgentPhase(
  state: AssistantStreamState | null,
  pendingCalls: Set<string>,
): AssistantStreamState['agentPhase'] | undefined {
  if (!state) return undefined;

  // Prefer backend-sent phase info when available.
  if (state.agentPhase) {
    // If the backend says we're in executing_tools but no pending calls remain,
    // the backend is still updating — trust the backend timestamp.
    return state.agentPhase;
  }

  if (!state.streaming && state.finishReason && pendingCalls.size === 0) {
    return undefined; // not in agent loop
  }
  if (pendingCalls.size > 0) {
    return {
      label: `Running ${pendingCalls.size} tool${pendingCalls.size > 1 ? 's' : ''}…`,
      round: 1,
      subPhase: 'executing_tools',
    };
  }
  if (state.streaming && state.blocks.length === 0 && state.toolCalls.length === 0) {
    return {
      label: 'Thinking…',
      round: 1,
      subPhase: 'thinking',
    };
  }
  if (state.streaming && state.toolCalls.length > 0) {
    // Still streaming with tool calls visible — in the "reviewing" sub-phase
    // between tool execution results and next content blocks.
    const anyComplete = state.toolCalls.some((tc) => tc.complete);
    if (anyComplete) {
      return {
        label: 'Reviewing results…',
        round: 1,
        subPhase: 'reviewing',
      };
    }
  }
  return undefined;
}

function formatMsgTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export const ChatView = forwardRef<ChatViewHandle, ChatViewProps>(function ChatView(
  {
    settings,
    onSettingsChange,
    onStatus,
    conversationId,
    artifacts,
    fileStateMap,
    onPromoteArtifact,
    onOpenArtifact,
    onChatTurnComplete,
    onDocumentToolActivity,
    onForkConversation,
    paneActive = true,
  },
  ref,
) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [prompt, setPrompt] = useState('');
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [activeStream, setActiveStream] = useState<AssistantStreamState | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [stuckToBottom, setStuckToBottom] = useState(true);
  const [showJumpPill, setShowJumpPill] = useState(false);
  // Phase 7 / M-WebSearch: per-turn search toggle. Visible only when
  // `settings.webSearchEnabled` is on; defaults to off each time the
  // component mounts. Reset after each send so the user must explicitly
  // opt in per turn.
  const [webSearchOn, setWebSearchOn] = useState(false);
  // Phase 7 / M-WebSearch: consent dialog for first-time chat-bar toggle.
  // If the user has already acknowledged via Settings, this never shows.
  // Session-only dismissal (same UX as diagnostics disclosure M6.5).
  const [showChatConsent, setShowChatConsent] = useState(false);
  const [chatConsentDismissed, setChatConsentDismissed] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const stuckRef = useRef(true);
  const stickPrefRef = useRef<Record<string, boolean>>({});
  const currentConversationIdRef = useRef<string | null>(conversationId);
  const activeRequestRef = useRef<{ requestId: string; conversationId: string } | null>(null);
  // Synchronous source of truth for the active stream's state. The `activeStream`
  // state mirrors it for render, but is updated by React async (and the ref that
  // synced to it via `useEffect` only caught up after paint — so the finally
  // block could read a state missing the last delta). Computing each event from
  // `streamStateRef` keeps the ref and state in lockstep, synchronously.
  const streamStateRef = useRef<AssistantStreamState | null>(null);
  const toolBindingsRef = useRef<Record<string, ConnectorToolBinding>>({});
  const providerToolByCallIdRef = useRef<Record<string, string>>({});
  const pendingRuntimeCallsRef = useRef<Set<string>>(new Set());
  const [agentPhase, setAgentPhase] = useState<AssistantStreamState['agentPhase']>(undefined);

  useEffect(() => {
    currentConversationIdRef.current = conversationId;
    if (activeRequestRef.current?.conversationId === conversationId) {
      setActiveRequestId(activeRequestRef.current.requestId);
      return;
    }
    if (activeRequestRef.current?.conversationId !== conversationId) {
      setActiveRequestId(null);
      setActiveStream(null);
    }
  }, [conversationId]);

  // Load the active conversation's messages whenever the selection changes. A
  // null id (brief, during boot) leaves the thread empty.
  useEffect(() => {
    if (!conversationId) {
      setTurns([]);
      setThreadLoading(false);
      return;
    }
    const pref = stickPrefRef.current[conversationId];
    stuckRef.current = pref !== false;
    setStuckToBottom(stuckRef.current);
    setShowJumpPill(false);

    let cancelled = false;
    setThreadLoading(true);
    void (async () => {
      try {
        const messages = await getConversationMessages(conversationId);
        if (!cancelled) {
          const turns = (
            await Promise.all(messages.map((m) => hydrateAssistantTurn(m)))
          ).filter((t): t is ChatTurn => t !== null);
          setTurns(turns);
        }
      } catch (error) {
        if (!cancelled) onStatus(error instanceof Error ? error.message : 'Failed to load conversation');
      } finally {
        if (!cancelled) setThreadLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, onStatus]);

  const STICK_THRESHOLD_PX = 48;

  function measureStuck(el: HTMLDivElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_THRESHOLD_PX;
  }

  function jumpToBottom() {
    const el = threadRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stuckRef.current = true;
    setStuckToBottom(true);
    setShowJumpPill(false);
    if (conversationId) stickPrefRef.current[conversationId] = true;
  }

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    function onScroll() {
      if (!el) return;
      const stuck = measureStuck(el);
      stuckRef.current = stuck;
      setStuckToBottom(stuck);
      if (conversationId) stickPrefRef.current[conversationId] = stuck;
      if (stuck) setShowJumpPill(false);
    }
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [conversationId]);

  // Auto-scroll only while the user is stuck to the bottom.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    if (stuckRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowJumpPill(false);
    } else if (activeStream || activeRequestId != null) {
      setShowJumpPill(true);
    }
  }, [turns, activeStream, activeRequestId]);

  // Derive agent loop phase from stream state + pending calls.
  useEffect(() => {
    const phase = deriveAgentPhase(activeStream, pendingRuntimeCallsRef.current);
    setAgentPhase(phase);
  }, [activeStream]);

  async function loadConnectorToolDefinitions(): Promise<ToolDefinition[]> {
    try {
      const snapshots = await getConnectorRuntimeStates();
      const callable = snapshots.filter(isConnectorCallable);
      const capabilityEntries = await Promise.all(
        callable.map(async (snapshot) => {
          let caps: ConnectorCapability[] = [];
          try {
            caps = await listConnectorCapabilities(snapshot.connectorVersionId);
            if (caps.length === 0 && snapshot.running) {
              caps = await discoverConnector(snapshot.connectorVersionId);
            }
          } catch {
            caps = [];
          }
          return [snapshot.connectorVersionId, caps] as const;
        }),
      );
      const catalog = buildConnectorToolCatalog(
        snapshots,
        Object.fromEntries(capabilityEntries),
      );
      toolBindingsRef.current = catalog.bindings;
      return catalog.toolDefinitions;
    } catch {
      toolBindingsRef.current = {};
      return [];
    }
  }

  async function loadToolDefinitions(prompt: string): Promise<ToolDefinition[]> {
    const intent = classifyDocumentTurnIntent(prompt);
    const connectorTools = await loadConnectorToolDefinitions();
    const builtinTools = selectBuiltinDocumentTools(intent);
    return [...builtinTools, ...connectorTools];
  }

  function applyRuntimeEventToActiveStream(
    requestId: string,
    targetConversationId: string,
    event: ConnectorRuntimeEvent,
  ) {
    const active = activeRequestRef.current;
    if (
      !active ||
      active.requestId !== requestId ||
      currentConversationIdRef.current !== targetConversationId
    ) {
      return;
    }
    if (event.kind === 'toolCallFinished') {
      pendingRuntimeCallsRef.current.delete(event.tool_call_id);
    }
    const base = streamStateRef.current ?? createAssistantStreamState(requestId);
    const next = applyConnectorRuntimeEvent(base, event);
    streamStateRef.current = next;
    setActiveStream(next);
  }

  function recordRuntimeFailure(
    requestId: string,
    targetConversationId: string,
    toolCallId: string,
    message: string,
  ) {
    pendingRuntimeCallsRef.current.delete(toolCallId);
    applyRuntimeEventToActiveStream(requestId, targetConversationId, {
      kind: 'toolCallFinished',
      tool_call_id: toolCallId,
      status: 'failed',
      size_bytes: 0n,
      mime_hints: [],
      error: message,
    });
  }

  async function handoffConnectorTool(
    requestId: string,
    targetConversationId: string,
    toolCallId: string,
    args: Record<string, unknown>,
  ) {
    const providerToolName = providerToolByCallIdRef.current[toolCallId];
    const binding = providerToolName ? toolBindingsRef.current[providerToolName] : undefined;
    if (!binding) {
      recordRuntimeFailure(
        requestId,
        targetConversationId,
        toolCallId,
        'No connector binding matched this provider tool call.',
      );
      return;
    }

    pendingRuntimeCallsRef.current.add(toolCallId);
    const runtimeRequest = makeInvokeConnectorToolRequest(binding, requestId, toolCallId, args);
    try {
      try {
        await invokeConnectorTool(runtimeRequest, (event) =>
          applyRuntimeEventToActiveStream(requestId, targetConversationId, event),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('not running')) {
          throw error;
        }
        await startConnector(binding.connectorVersionId);
        await invokeConnectorTool(runtimeRequest, (event) =>
          applyRuntimeEventToActiveStream(requestId, targetConversationId, event),
        );
      }
    } catch (error) {
      recordRuntimeFailure(
        requestId,
        targetConversationId,
        toolCallId,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function waitForPendingRuntimeCalls(requestId: string) {
    const deadline = Date.now() + 30000;
    while (activeRequestRef.current?.requestId === requestId && Date.now() < deadline) {
      const hasPending = pendingRuntimeCallsRef.current.size > 0;
      const hasUnresolvedComplete = (() => {
        const state = streamStateRef.current;
        if (!state) return false;
        return state.toolCalls.some((tc) => tc.complete && !tc.status);
      })();
      if (!hasPending && !hasUnresolvedComplete) break;
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
  }

  async function handleSend() {
    const trimmed = prompt.trim();
    if (!trimmed || activeRequestId || !conversationId) return;

    const userTurn: ChatTurn = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
    };
    const history = [...turns, userTurn];
    setTurns(history);
    setPrompt('');
    onStatus(makeStatus('Loading connector tools', 'active', 'chat'));

    const toolDefinitions = await loadToolDefinitions(trimmed);
    const priorHistory = history.slice(0, -1);
    const followUpArtifact = await resolveFollowUpArtifactContext(
      priorHistory,
      trimmed,
      artifacts,
      getArtifact,
    );
    const request = buildProviderRequest(
      settings,
      trimmed,
      history,
      conversationId,
      toolDefinitions,
      followUpArtifact,
      resolveWebSearchForTurn(settings, webSearchOn, trimmed),
    );
    // Reset the per-turn search toggle after building the request so the
    // next turn defaults back to off, per spec §5.2.
    setWebSearchOn(false);
    const initialStream = createAssistantStreamState(request.requestId);
    providerToolByCallIdRef.current = {};
    pendingRuntimeCallsRef.current = new Set();
    activeRequestRef.current = {
      requestId: request.requestId,
      conversationId,
    };
    streamStateRef.current = initialStream;
    setActiveRequestId(request.requestId);
    setActiveStream(initialStream);

    // `start_chat_stream` spawns the provider stream and returns a handle
    // immediately — the invoke promise resolves *before* any provider events
    // arrive (network RTT + time-to-first-token). Awaiting it as if it marked
    // completion used to run the finally block at once: it nulled
    // `activeRequestRef.current` and cleared the live bubble before the first
    // `contentDelta` landed, so every event was dropped by the guard and the
    // turn rendered as a blank "stream complete". Await a promise that only
    // resolves on the terminal `messageComplete`/`error` event instead.
    let terminalError: string | null = null;
    const streamDone = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      startChatStream(
        request,
        (event) => {
        const active = activeRequestRef.current;
        if (
          !active ||
          active.requestId !== request.requestId ||
          currentConversationIdRef.current !== conversationId
        ) {
          return;
        }
        // `streamStateRef` is the synchronous source of truth; `activeStream`
        // mirrors it for render. Computing from the ref (not the state) avoids
        // the render-lag where the finally block would read a state missing the
        // last delta — the useEffect-synced ref only caught up after paint.
        const base = streamStateRef.current ?? createAssistantStreamState(request.requestId);
        const next = applyProviderEvent(base, event);
        streamStateRef.current = next;
        setActiveStream(next);

        if (event.kind === 'toolCallStart') {
          providerToolByCallIdRef.current[event.toolCallId] = event.toolId || event.name;
          if (isDocumentContentTool(event.name)) {
            onDocumentToolActivity?.({ phase: 'start', toolName: event.name });
          }
        } else if (event.kind === 'toolCallComplete') {
          // Phase A: tool execution is now owned by the Rust `AgentLoop` inside
          // `start_chat_stream`. The UI no longer hands off tool calls via IPC.
          // The `toolCallComplete` event is still rendered for the tool card.
          // Track this so `waitForPendingRuntimeCalls` blocks until the matching
          // `toolCallFinished` (with `status`) arrives from the runtime.
          pendingRuntimeCallsRef.current.add(event.toolCallId);
          const toolName =
            providerToolByCallIdRef.current[event.toolCallId] ??
            next.toolCalls.find((tc) => tc.toolCallId === event.toolCallId)?.name;
          if (toolName && isDocumentContentTool(toolName)) {
            const title =
              typeof event.arguments?.title === 'string' ? event.arguments.title : undefined;
            const artifactId =
              typeof event.arguments?.artifact_id === 'string'
                ? event.arguments.artifact_id
                : undefined;
            onDocumentToolActivity?.({
              phase: 'complete',
              toolName,
              titleHint: title,
              artifactId,
            });
          }
        } else if (event.kind === 'messageComplete' || event.kind === 'error') {
          if (event.kind === 'error') terminalError = event.error.message;
          finish();
        }
      },
      (event) => applyRuntimeEventToActiveStream(request.requestId, conversationId, event),
      ).catch((error) => {
        // Pre-stream rejection (bad model/key/connection) — the invoke rejects
        // before any event. Surface it and resolve so the finally block
        // finalizes the turn with the error rather than hanging on `streamDone`.
        terminalError = describeInvokeError(error);
        finish();
      });
    });

    try {
      await streamDone;
      onStatus(makeStatus('Waiting for tool results…', 'active', 'chat'));
      await waitForPendingRuntimeCalls(request.requestId);
      onStatus(makeStatus(terminalError ?? 'Stream complete', terminalError ? 'error' : 'success', 'chat'));
    } catch (error) {
      console.error('[startChatStream] rejected:', error);
      onStatus(makeStatus(describeInvokeError(error), 'error', 'chat'));
    } finally {
      const finalState = streamStateRef.current;
      if (currentConversationIdRef.current === conversationId && finalState) {
        const content = finalState.blocks.map((block) => block.content).join('');
        const errorText = finalState.error ?? (terminalError ?? undefined);
        const hasToolCalls = finalState.toolCalls.length > 0;
        // Don't commit an empty turn with no error. A pre-stream rejection or
        // an empty provider response would otherwise append a blank assistant
        // bubble whose `content: ""` then poisons the next request — normalize
        // rejects empty text parts with "text and reasoning parts require
        // content". Error turns are kept so the failure shows in the rail;
        // `buildProviderRequest` skips empty-content turns when sending.
        // Tool-only turns (no assistant text) are kept so tool cards persist.
        if (content.trim() !== '' || errorText || hasToolCalls) {
          void (async () => {
            let turnId = `assistant-${request.requestId}`;
            try {
              const realId = await getMessageIdByRequest(request.requestId);
              if (realId) turnId = realId;
            } catch {
              /* keep client turn id */
            }

            setTurns((current) => [
              ...current,
              {
                id: turnId,
                role: 'assistant',
                content,
                streamState: { ...finalState, streaming: false, error: errorText },
                interrupted: finalState.interrupted,
                modelId: settings.activeModel,
              },
            ]);

          })();
          if (!errorText && onChatTurnComplete) {
            onChatTurnComplete({ ...finalState, streaming: false, error: errorText });
          }
          // Warn when the user asked for an artifact but none was produced.
          const docToolsSucceeded = hadSuccessfulDocumentToolCalls(finalState);
          if (looksLikeArtifactCreationRequest(trimmed) && !docToolsSucceeded) {
            const failedDocTools = failedDocumentToolCalls(finalState);
            const hasFences = detectArtifactCandidates(content).length > 0;
            if (failedDocTools.length > 0) {
              const detail = failedDocTools
                .map((tc) => tc.error)
                .filter((e): e is string => typeof e === 'string' && e.trim() !== '')
                .join(' ');
              onStatus(
                makeStatus(
                  detail
                    ? `Document tool failed — ${detail}`
                    : 'Document tool failed — retry or ask for a fenced code block (e.g. ```html).',
                  'warning',
                  'chat',
                ),
              );
            } else if (!hasFences) {
              onStatus(
                makeStatus(
                  'No artifact content detected — use write_*_document or include a fenced code block (e.g. ```html).',
                  'warning',
                  'chat',
                ),
              );
            }
          }
        }
      }
      if (activeRequestRef.current?.requestId === request.requestId) {
        activeRequestRef.current = null;
      }
      streamStateRef.current = null;
      if (currentConversationIdRef.current === conversationId) {
        setActiveStream(null);
        setActiveRequestId(null);
      }
      providerToolByCallIdRef.current = {};
      pendingRuntimeCallsRef.current = new Set();
    }
  }

  async function handleCancel() {
    const active = activeRequestRef.current;
    if (!active || active.conversationId !== conversationId) return;
    await cancelChatStream({
      requestId: active.requestId,
      conversationId,
    });
    // Tear down the live stream state. The interrupted banner for the
    // persisted turn comes from the reloaded messages (the backend's cancel
    // path marks the assistant turn `interrupted`), so there's nothing to
    // render live here — clear and reload. The in-flight `handleSend` await
    // (`streamDone`) is left pending; its finally is a no-op once the request
    // id no longer matches, and a new send overwrites `streamStateRef`.
    activeRequestRef.current = null;
    streamStateRef.current = null;
    setActiveStream(null);
    setActiveRequestId(null);
    try {
      const messages = await getConversationMessages(conversationId);
      const turns = (
        await Promise.all(messages.map((m) => hydrateAssistantTurn(m)))
      ).filter((t): t is ChatTurn => t !== null);
      setTurns(turns);
    } catch {
      /* ignore */
    }
    onStatus(makeStatus('Stream cancelled', 'success', 'chat'));
  }

  useImperativeHandle(ref, () => ({
    stopStreaming: () => {
      void handleCancel();
    },
    isStreaming: () => activeRequestRef.current != null,
    copyLastAssistantMessage: async () => {
      const last = [...turns].reverse().find((t) => t.role === 'assistant');
      const text =
        last?.content?.trim() ||
        last?.streamState?.blocks.map((b) => b.content).join('').trim() ||
        activeStream?.blocks.map((b) => b.content).join('').trim() ||
        '';
      if (!text) return false;
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    },
    scrollToMessage: (messageId: string) => {
      // Small delay to let the DOM settle after conversation switch
      setTimeout(() => {
        const el = document.querySelector(`[data-message-id="${messageId}"]`);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('message-highlight');
          setTimeout(() => el.classList.remove('message-highlight'), 2000);
        }
      }, 100);
    },
    insertPrompt: (text: string) => {
      setPrompt((prev) => {
        const ta = document.querySelector('.composer-textarea') as HTMLTextAreaElement | null;
        if (ta && document.activeElement === ta) {
          const start = ta.selectionStart;
          const end = ta.selectionEnd;
          return prev.slice(0, start) + text + prev.slice(end);
        }
        return prev + (prev ? '\n' : '') + text;
      });
      requestAnimationFrame(() => {
        const ta = document.querySelector('.composer-textarea') as HTMLTextAreaElement | null;
        ta?.focus();
      });
    },
  }));

  function handleWebSearchToggle() {
    if (!webSearchOn && !settings.webSearchConsentAcknowledged && !chatConsentDismissed) {
      setShowChatConsent(true);
      return;
    }
    setWebSearchOn((on) => !on);
  }

  function handleSuggestionSelect(text: string) {
    setPrompt(text);
    requestAnimationFrame(() => composerRef.current?.focusPrompt());
  }

  const suggestedPrompts = useMemo(
    () => deriveSuggestedPrompts({ turns, artifacts }),
    [turns, artifacts],
  );

  const showInlineSuggestions =
    turns.length > 0 &&
    !activeStream &&
    activeRequestId == null &&
    !prompt.trim();

  function handleEditUserTurn(content: string) {
    setPrompt(content);
    requestAnimationFrame(() => composerRef.current?.focusPrompt());
  }

  /** P3.1/P3.2 — retry/delete the last assistant turn: remove it locally + in
   *  the DB (`removeLastTurn` deletes the last assistant turn + its event log
   *  + tool rows), then reload the thread. The user keeps their prompt so they
   *  can re-send or edit. */
  async function handleRemoveLastAssistantTurn() {
    if (!conversationId || activeRequestId) return;
    try {
      const count = await removeLastTurn(conversationId);
      const messages = await getConversationMessages(conversationId);
      const nextTurns = (await Promise.all(messages.map((m) => hydrateAssistantTurn(m)))).filter(
        (t): t is ChatTurn => t !== null,
      );
      setTurns(nextTurns);
      onStatus(makeStatus(count > 0 ? 'Removed last response' : 'Nothing to remove', 'success', 'chat'));
    } catch (error) {
      onStatus(
        makeStatus(error instanceof Error ? error.message : 'Failed to remove response', 'error', 'chat'),
      );
    }
  }

  async function handleCopyAssistantTurn(content: string) {
    if (!content.trim()) return;
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      /* clipboard may be unavailable */
    }
  }

  return (
    <>
    <section
      className="tab-pane"
      data-pane="chat"
      data-active={paneActive ? 'true' : 'false'}
      aria-label="Chat session"
    >
      <a className="skip-link" href="#composer-anchor" aria-label="Skip to composer">Skip to composer</a>
      <ChatErrorBoundary>
      <div className="thread scroll" ref={threadRef}>
        <div className="thread-inner">
          {threadLoading && (
            <div className="thread-skeleton" aria-busy="true" aria-label="Loading conversation">
              <div className="skel-msg">
                <div className="skel-av" />
                <div className="skel-lines">
                  <div className="skel-line w-90" />
                  <div className="skel-line w-75" />
                  <div className="skel-line w-40" />
                </div>
              </div>
            </div>
          )}
          {!threadLoading && turns.length === 0 && !activeStream && (
            <div className="welcome">
              <BotGlyph className="brand-mark" aria-hidden="true" />
              <h1>Good day</h1>
              <p className="lede">Ask anything, draft an artifact, or put your connectors to work. Everything stays on this machine — your keys, your files, your data.</p>
              <SuggestedPrompts
                prompts={suggestedPrompts}
                variant="empty"
                onSelect={handleSuggestionSelect}
              />
              <div className="hint-row">
                <span className="hint"><kbd>⌘K</kbd> command palette</span>
                <span className="hint"><kbd>⌘N</kbd> new chat</span>
                <span className="hint"><kbd>⌘J</kbd> toggle panel</span>
                <span className="hint"><kbd>⌘,</kbd> settings</span>
              </div>
            </div>
          )}
          {!threadLoading && turns.map((turn) =>
            turn.role === 'user' ? (
              <div key={turn.id} className="msg enter" data-message-id={turn.id}>
                <div className="av-role you">You</div>
                <div className="msg-body">
                  <div className="msg-from">
                    <b>You</b>
                    {turn.createdAt && (
                      <span className="msg-time">{formatMsgTime(turn.createdAt)}</span>
                    )}
                    <div className="msg-actions">
                      <button
                        type="button"
                        onClick={() => handleEditUserTurn(turn.content)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        onClick={() => onForkConversation?.(conversationId ?? '', turn.id)}
                        title="Fork conversation at this message"
                      >
                        Fork
                      </button>
                    </div>
                  </div>
                  <div className="prose user-prose">
                    <p dangerouslySetInnerHTML={{ __html: escapeHtml(turn.content) }} />
                  </div>
                  {turn.interrupted && <div className="interrupted-banner">Generation was interrupted.</div>}
                </div>
              </div>
            ) : turn.streamState ? (
              <AssistantMessage
                key={turn.id}
                state={turn.streamState}
                modelId={turn.modelId ?? settings.activeModel}
                messageId={turn.id}
                artifacts={artifacts}
                fileStateMap={fileStateMap}
                onPromoteArtifact={onPromoteArtifact}
                onOpenArtifact={onOpenArtifact}
                isLast={turn.id === turns[turns.length - 1]?.id}
                onRetry={() => void handleRemoveLastAssistantTurn()}
                onDelete={() => void handleRemoveLastAssistantTurn()}
              />
            ) : (
              <div key={turn.id} className="msg enter" data-message-id={turn.id}>
                <div className="av-role bot" />
                <div className="msg-body">
                  <div className="msg-from">
                    <b>Assistant</b>
                    <span className="model">{settings.activeModel}</span>
                    {turn.createdAt && (
                      <span className="msg-time">{formatMsgTime(turn.createdAt)}</span>
                    )}
                    <div className="msg-actions">
                      <button
                        type="button"
                        onClick={() => void handleCopyAssistantTurn(turn.content)}
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                  <ChatMessageContent
                    content={turn.content}
                    messageId={turn.id}
                    artifacts={artifacts}
                    onPromoteArtifact={onPromoteArtifact}
                    onOpenArtifact={onOpenArtifact}
                  />
                  {turn.interrupted && <div className="interrupted-banner">Generation was interrupted.</div>}
                  <AssistantArtifactStrip
                    messageId={turn.id}
                    artifacts={artifacts}
                    fileStateMap={fileStateMap}
                    onOpenArtifact={onOpenArtifact}
                  />
                </div>
              </div>
            ),
          )}
          {activeStream && (
            <AssistantMessage
              state={{ ...activeStream, agentPhase: agentPhase ?? activeStream.agentPhase }}
              modelId={settings.activeModel}
            />
          )}
        </div>
      </div>
      </ChatErrorBoundary>

      {showJumpPill && !stuckToBottom && (
        <button
          className="jump-to-bottom"
          type="button"
          onClick={jumpToBottom}
        >
          ↓ New messages
        </button>
      )}

      {showInlineSuggestions && (
        <SuggestedPrompts
          prompts={suggestedPrompts}
          variant="inline"
          onSelect={handleSuggestionSelect}
        />
      )}

      <Composer
        ref={composerRef}
        settings={settings}
        onSettingsChange={onSettingsChange}
        conversationId={conversationId}
        prompt={prompt}
        onPromptChange={setPrompt}
        onSend={() => void handleSend()}
        onStop={() => void handleCancel()}
        streaming={activeRequestId != null}
        webSearchOn={webSearchOn}
        onWebSearchToggle={handleWebSearchToggle}
      />
      <div id="composer-anchor" />
    </section>
      {/* Phase 7 / M-WebSearch: first-use consent dialog for the chat-bar toggle. */}
      <WebSearchConsentDialog
        visible={showChatConsent}
        onAllow={() => {
          setShowChatConsent(false);
          setWebSearchOn(true);
          // Persist the acknowledgement so the dialog never reappears.
          void updateSettings({ webSearchConsentAcknowledged: true });
        }}
        onDeny={() => {
          setShowChatConsent(false);
          // Remember the dismissal for this session only.
          setChatConsentDismissed(true);
        }}
      />
    </>
  );
});