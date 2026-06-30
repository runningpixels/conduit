import { useEffect, useRef, useState } from 'react';
import type { AppSettings, Message, MessageRole, ProviderRequest } from '@conduit/config-schema';
import {
  cancelChatStream,
  discoverConnector,
  getArtifact,
  getConnectorRuntimeStates,
  getConversationMessages,
  getRequestProviderEvents,
  invokeConnectorTool,
  listConnectorCapabilities,
  loadProviderCredentialReference,
  startConnector,
  startChatStream,
  updateSettings,
} from '../ipc/client';
import { AssistantMessage } from './AssistantMessage';
import { AssistantArtifactStrip } from './ArtifactRefChip';
import { ChatMessageContent } from './ChatMessageContent';
import { detectArtifactCandidates, type ArtifactCandidate } from './artifactCandidates';
import {
  CONDUIT_ARTIFACT_SYSTEM_APPENDIX,
  artifactDeveloperPromptFor,
  looksLikeArtifactCreationRequest,
} from './artifactPrompt';
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
  rebuildAssistantStreamStateFromEvents,
  type AssistantStreamState,
} from './streamState';
import type { StatusState } from './statusTypes';
import { makeStatus } from './statusTypes';
import { AttachIcon, ModelIcon, SendIcon, StopIcon, LockIcon } from '../icons';
import { WebSearchConsentDialog } from '../workspace/settings/WebSearchConsentDialog';
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
  hadSuccessfulDocumentToolCalls,
  selectBuiltinDocumentTools,
} from './agentTools';
import {
  classifyDocumentTurnIntent,
  informationalDeveloperPromptFor,
} from './documentTurnIntent';

interface ChatTurn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  streamState?: AssistantStreamState;
  interrupted?: boolean;
  modelId?: string;
}

interface ChatViewProps {
  settings: AppSettings;
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
  /// Auto-promote the first candidate when a stream completes (App dedupes).
  onAutoPromoteArtifact?: (messageId: string, candidate: ArtifactCandidate) => void;
  /// M2: open an existing artifact in the DocumentPanel (chip click).
  onOpenArtifact: (artifactId: string) => void;
  /// After a completed assistant turn — refresh/open artifacts created via agent tools.
  onChatTurnComplete?: (streamState: AssistantStreamState) => void;
}

function messageToTurn(message: Message): ChatTurn {
  const content = message.parts
    .map((part) => part.content ?? '')
    .filter(Boolean)
    .join('\n');
  return {
    id: message.id,
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content,
    interrupted: Boolean(message.interruptedAt),
  };
}

async function hydrateAssistantTurn(message: Message): Promise<ChatTurn> {
  const turn = messageToTurn(message);
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

/// Extracts a human-readable message from a Tauri `invoke` rejection.
/// Tauri commands returning `Result<T, String>` reject with the serialized
/// error (a plain string, or an object), not an `Error` instance — so
/// `error instanceof Error` is false and the generic "Stream failed" would
/// otherwise swallow the real reason. Fall back through the common shapes.
function describeInvokeError(error: unknown): string {
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
    .map((turn, index) => ({
      id: `msg-${index}`,
      conversationId,
      role: turn.role as MessageRole,
      parts: [
        {
          id: `part-${index}`,
          messageId: `msg-${index}`,
          index: 0,
          kind: 'text' as const,
          content: turn.content,
          createdAt: now,
        },
      ],
      createdAt: now,
    }));
  const creationDevPrompt = artifactDeveloperPromptFor(prompt);
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
    !creationDevPrompt && !webSearch ? informationalDeveloperPromptFor(prompt) : undefined;
  const editDevPrompt =
    !creationDevPrompt && !infoDevPrompt && followUpArtifact
      ? buildArtifactEditDeveloperPrompt(followUpArtifact, prompt)
      : undefined;
  const webSearchDevPrompt = webSearch ? webSearchDeveloperPromptFor() : undefined;
  const developerPrompt =
    [creationDevPrompt, infoDevPrompt, editDevPrompt, webSearchDevPrompt].filter(Boolean).join('\n\n') ||
    undefined;
  const systemPrompt =
    webSearch && !creationDevPrompt
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
 *  Frontend-only derivation — no backend changes needed.
 *  Used to show phase labels and the phase badge in the assistant message. */
function deriveAgentPhase(
  state: AssistantStreamState | null,
  pendingCalls: Set<string>,
): AssistantStreamState['agentPhase'] | undefined {
  if (!state) return undefined;
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

export function ChatView({ settings, onStatus, conversationId, artifacts, fileStateMap, onPromoteArtifact, onAutoPromoteArtifact, onOpenArtifact, onChatTurnComplete }: ChatViewProps) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [prompt, setPrompt] = useState('');
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [activeStream, setActiveStream] = useState<AssistantStreamState | null>(null);
  const [keychainOk, setKeychainOk] = useState(false);
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
  const [suppressedPromoteKeys, setSuppressedPromoteKeys] = useState<Record<string, Set<string>>>({});
  const threadRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
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
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const messages = await getConversationMessages(conversationId);
        if (!cancelled) {
          const turns = await Promise.all(messages.map((m) => hydrateAssistantTurn(m)));
          setTurns(turns);
        }
      } catch (error) {
        if (!cancelled) onStatus(error instanceof Error ? error.message : 'Failed to load conversation');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, onStatus]);

  // M2: the keychain is the source of truth, keyed by provider. Probe it per
  // active provider rather than reading a (removed) global credential ref.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const summary = await loadProviderCredentialReference(settings.activeProvider);
        if (!cancelled) setKeychainOk(summary.storedInKeychain);
      } catch {
        if (!cancelled) setKeychainOk(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [settings.activeProvider]);

  // Autosize the composer textarea.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  }, [prompt]);

  // Keep the thread scrolled to the latest content while streaming.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, activeStream]);

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
        } else if (event.kind === 'toolCallComplete') {
          // Phase A: tool execution is now owned by the Rust `AgentLoop` inside
          // `start_chat_stream`. The UI no longer hands off tool calls via IPC.
          // The `toolCallComplete` event is still rendered for the tool card.
          // Track this so `waitForPendingRuntimeCalls` blocks until the matching
          // `toolCallFinished` (with `status`) arrives from the runtime.
          pendingRuntimeCallsRef.current.add(event.toolCallId);
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

            const candidates = detectArtifactCandidates(content);
            const htmlCandidate = candidates.find((c) => c.kind === 'html');
            if (htmlCandidate) {
              setSuppressedPromoteKeys((current) => {
                const next = { ...current };
                const keys = new Set(current[turnId] ?? []);
                keys.add(htmlCandidate.key);
                next[turnId] = keys;
                return next;
              });
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

            if (!errorText && content.trim() !== '' && htmlCandidate && onAutoPromoteArtifact) {
              await onAutoPromoteArtifact(turnId, htmlCandidate);
            }
          })();
          if (!errorText && onChatTurnComplete) {
            onChatTurnComplete({ ...finalState, streaming: false, error: errorText });
          }
          // Warn when the user asked for an artifact but none was produced.
          const docToolsSucceeded = hadSuccessfulDocumentToolCalls(finalState);
          if (
            looksLikeArtifactCreationRequest(trimmed) &&
            detectArtifactCandidates(content).length === 0 &&
            !docToolsSucceeded
          ) {
            onStatus(makeStatus('No artifact content detected — the assistant must include a fenced code block (e.g. ```html).', 'warning', 'chat'));
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
      const turns = await Promise.all(messages.map((m) => hydrateAssistantTurn(m)));
      setTurns(turns);
    } catch {
      /* ignore */
    }
    onStatus(makeStatus('Stream cancelled', 'success', 'chat'));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  const tokenCount = prompt.trim() ? Math.max(1, Math.round(prompt.trim().length / 4)) : 0;

  return (
    <>
    <section className="tab-pane" data-pane="chat" aria-label="Chat session">
      <div className="thread scroll" ref={threadRef}>
        <div className="thread-inner">
          {turns.length === 0 && !activeStream && (
            <div className="msg enter">
              <div className="av-role you">You</div>
              <div className="msg-body">
                <div className="msg-from"><b>Start a conversation</b></div>
                <div className="prose">
                  <p>Reply, ask for an edit, or create a new artifact. Calls go straight to your provider with your key.</p>
                </div>
              </div>
            </div>
          )}
          {turns.map((turn) =>
            turn.role === 'user' ? (
              <div key={turn.id} className="msg enter">
                <div className="av-role you">You</div>
                <div className="msg-body">
                  <div className="msg-from"><b>You</b></div>
                  <div className="prose">
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
                suppressedCandidateKeys={suppressedPromoteKeys[turn.id]}
              />
            ) : (
              <div key={turn.id} className="msg enter">
                <div className="av-role bot" />
                <div className="msg-body">
                  <div className="msg-from"><b>Assistant</b><span className="model">{settings.activeModel}</span></div>
                  <ChatMessageContent content={turn.content} />
                  {turn.interrupted && <div className="interrupted-banner">Generation was interrupted.</div>}
                  {/* M2: promote candidates + reference chips for this turn. The
                      plain (DB-loaded) turn carries the real message id, so
                      chips linked via `sourceMessageId` match across sessions. */}
                  <AssistantArtifactStrip
                    messageId={turn.id}
                    artifacts={artifacts}
                    fileStateMap={fileStateMap}
                    content={turn.content}
                    suppressedCandidateKeys={suppressedPromoteKeys[turn.id]}
                    onPromote={onPromoteArtifact}
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

      <div className="composer-wrap">
        {settings.webSearchEnabled && !settings.localOnly && (
          <div className="caps caps-websearch">
            <span className="cap" data-state={webSearchOn ? 'ok' : 'warn'}>
              <i style={webSearchOn ? undefined : { background: 'var(--warn)' }} />
              web search {webSearchOn ? 'on' : 'off'}
            </span>
          </div>
        )}
        <div className="composer">
          <textarea
            ref={taRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Reply, ask for an edit, or create a new artifact"
            rows={1}
            aria-label="Message the active provider"
          />
          <div className="composer-bar">
            <button className="tool-btn" type="button" aria-label="Attach file" title="Attach file">
              <AttachIcon />
            </button>
            <button className="tool-btn" type="button" title="Model picker">
              <ModelIcon />
              {settings.activeModel}
            </button>
            {settings.webSearchEnabled && !settings.localOnly && !activeRequestId && (
              <button
                className={`tool-btn${webSearchOn ? ' search-active' : ''}`}
                type="button"
                aria-label={webSearchOn ? 'Web search on — click to disable' : 'Web search off — click to enable'}
                title={webSearchOn ? 'Web search on' : 'Web search off'}
                aria-pressed={webSearchOn}
                onClick={() => {
                if (!webSearchOn && !settings.webSearchConsentAcknowledged && !chatConsentDismissed) {
                  // First-time flip-on from chat bar: show consent dialog.
                  setShowChatConsent(true);
                } else {
                  setWebSearchOn((on) => !on);
                }
              }}
              >
                <span aria-hidden style={{ fontSize: '14px' }}>⌕</span>
              </button>
            )}
            {activeRequestId ? (
              <button
                className="send stop"
                type="button"
                aria-label="Stop generating"
                title="Stop generating"
                onClick={() => void handleCancel()}
              >
                <StopIcon />
              </button>
            ) : (
              <button
                className="send"
                type="button"
                aria-label="Send message"
                title="Send message"
                onClick={() => void handleSend()}
                disabled={!prompt.trim()}
              >
                <SendIcon />
              </button>
            )}
          </div>
        </div>
        <div className="composer-foot">
          <span className="meta">
            <b>{tokenCount}</b> tokens - ~3.1k context
          </span>
          <span className="right">
            <LockIcon />
            {keychainOk ? 'key stored in OS keychain' : 'no key stored'}
          </span>
        </div>
      </div>
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
}