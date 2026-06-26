import { useEffect, useRef, useState } from 'react';
import type { AppSettings, Message, MessageRole, ProviderRequest } from '@conduit/config-schema';
import {
  cancelChatStream,
  discoverConnector,
  getConnectorRuntimeStates,
  getConversationMessages,
  invokeConnectorTool,
  listConnectorCapabilities,
  loadProviderCredentialReference,
  startConnector,
  startChatStream,
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
import type { Artifact, FileState } from '../ipc/contracts';
import {
  applyConnectorRuntimeEvent,
  applyProviderEvent,
  createAssistantStreamState,
  type AssistantStreamState,
} from './streamState';
import { AttachIcon, ModelIcon, SendIcon, StopIcon, LockIcon } from '../icons';
import { COMPOSER_CAPS } from '../mock/workspace';
import type { ConnectorCapability, ConnectorRuntimeEvent } from '../ipc/contracts';
import type { ToolDefinition } from '@conduit/config-schema';
import {
  buildConnectorToolCatalog,
  isConnectorCallable,
  makeInvokeConnectorToolRequest,
  type ConnectorToolBinding,
} from './connectorTools';

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
  onStatus: (message: string) => void;
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
  const devPrompt = artifactDeveloperPromptFor(prompt);
  return {
    requestId: crypto.randomUUID(),
    conversationId,
    modelId: settings.activeModel,
    messages,
    systemPrompt: `${BASE_SYSTEM_PROMPT} ${CONDUIT_ARTIFACT_SYSTEM_APPENDIX}`,
    developerPrompt: devPrompt,
    toolDefinitions,
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

export function ChatView({ settings, onStatus, conversationId, artifacts, fileStateMap, onPromoteArtifact, onAutoPromoteArtifact, onOpenArtifact }: ChatViewProps) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [prompt, setPrompt] = useState('');
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [activeStream, setActiveStream] = useState<AssistantStreamState | null>(null);
  const [keychainOk, setKeychainOk] = useState(false);
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
        if (!cancelled) setTurns(messages.map(messageToTurn));
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

  async function loadToolDefinitions(): Promise<ToolDefinition[]> {
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
    while (
      activeRequestRef.current?.requestId === requestId &&
      pendingRuntimeCallsRef.current.size > 0 &&
      Date.now() < deadline
    ) {
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
    onStatus('Loading connector tools');

    const toolDefinitions = await loadToolDefinitions();
    const request = buildProviderRequest(settings, trimmed, history, conversationId, toolDefinitions);
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
      startChatStream(request, (event) => {
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
        } else if (event.kind === 'messageComplete' || event.kind === 'error') {
          if (event.kind === 'error') terminalError = event.error.message;
          finish();
        }
      }).catch((error) => {
        // Pre-stream rejection (bad model/key/connection) — the invoke rejects
        // before any event. Surface it and resolve so the finally block
        // finalizes the turn with the error rather than hanging on `streamDone`.
        terminalError = describeInvokeError(error);
        finish();
      });
    });

    try {
      await streamDone;
      await waitForPendingRuntimeCalls(request.requestId);
      onStatus(terminalError ?? 'Stream complete');
    } catch (error) {
      console.error('[startChatStream] rejected:', error);
      onStatus(describeInvokeError(error));
    } finally {
      const finalState = streamStateRef.current;
      if (currentConversationIdRef.current === conversationId && finalState) {
        const content = finalState.blocks.map((block) => block.content).join('');
        const errorText = finalState.error ?? (terminalError ?? undefined);
        // Don't commit an empty turn with no error. A pre-stream rejection or
        // an empty provider response would otherwise append a blank assistant
        // bubble whose `content: ""` then poisons the next request — normalize
        // rejects empty text parts with "text and reasoning parts require
        // content". Error turns are kept so the failure shows in the rail;
        // `buildProviderRequest` skips empty-content turns when sending.
        if (content.trim() !== '' || errorText) {
          setTurns((current) => [
            ...current,
            {
              id: `assistant-${request.requestId}`,
              role: 'assistant',
              content,
              streamState: { ...finalState, streaming: false, error: errorText },
              interrupted: finalState.interrupted,
              modelId: settings.activeModel,
            },
          ]);
          // Auto-promote the first detected candidate once per completed stream.
          if (!errorText && content.trim() !== '' && onAutoPromoteArtifact) {
            const candidates = detectArtifactCandidates(content);
            const first = candidates[0];
            if (first) {
              void onAutoPromoteArtifact(`assistant-${request.requestId}`, first);
            }
          }
          // Warn when the user asked for an artifact but none was produced.
          if (looksLikeArtifactCreationRequest(trimmed) && detectArtifactCandidates(content).length === 0) {
            onStatus('No artifact content detected — the assistant must include a fenced code block (e.g. ```html).');
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
      setTurns(messages.map(messageToTurn));
    } catch {
      /* ignore */
    }
    onStatus('Stream cancelled');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  const tokenCount = prompt.trim() ? Math.max(1, Math.round(prompt.trim().length / 4)) : 0;

  return (
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
                    onPromote={onPromoteArtifact}
                    onOpenArtifact={onOpenArtifact}
                  />
                </div>
              </div>
            ),
          )}
          {activeStream && (
            <AssistantMessage state={activeStream} modelId={settings.activeModel} />
          )}
        </div>
      </div>

      <div className="composer-wrap">
        <div className="caps">
          <span className="lbl">Available here</span>
          {COMPOSER_CAPS.map((cap) => (
            <span className="cap" key={cap.id}>
              <i style={cap.state === 'warn' ? { background: 'var(--warn)' } : cap.state === 'none' ? { background: 'var(--text-3)' } : undefined} />
              {cap.label}
            </span>
          ))}
        </div>
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
  );
}