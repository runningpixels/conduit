import { useEffect, useRef, useState } from 'react';
import type { AppSettings, Message, MessageRole, ProviderRequest } from '@conduit/config-schema';
import {
  cancelChatStream,
  getConversationMessages,
  loadProviderCredentialReference,
  startChatStream,
} from '../ipc/client';
import { AssistantMessage } from './AssistantMessage';
import {
  applyProviderEvent,
  createAssistantStreamState,
  markInterrupted,
  type AssistantStreamState,
} from './streamState';
import { AttachIcon, ModelIcon, SendIcon, StopIcon, LockIcon } from '../icons';
import { COMPOSER_CAPS } from '../mock/workspace';

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

function buildProviderRequest(
  settings: AppSettings,
  prompt: string,
  history: ChatTurn[],
  conversationId: string,
): ProviderRequest {
  const now = new Date().toISOString();
  const messages = history
    .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
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
  return {
    requestId: crypto.randomUUID(),
    conversationId,
    modelId: settings.activeModel,
    messages,
    systemPrompt: 'You are a helpful assistant in the Conduit desktop shell.',
    toolDefinitions: [],
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

export function ChatView({ settings, onStatus, conversationId }: ChatViewProps) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [prompt, setPrompt] = useState('');
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [activeStream, setActiveStream] = useState<AssistantStreamState | null>(null);
  const [keychainOk, setKeychainOk] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const currentConversationIdRef = useRef<string | null>(conversationId);
  const activeRequestRef = useRef<{ requestId: string; conversationId: string } | null>(null);

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
    onStatus('Streaming provider response');

    const request = buildProviderRequest(settings, trimmed, history, conversationId);
    const initialStream = createAssistantStreamState(request.requestId);
    activeRequestRef.current = {
      requestId: request.requestId,
      conversationId,
    };
    setActiveRequestId(request.requestId);
    setActiveStream(initialStream);

    try {
      await startChatStream(request, (event) => {
        const active = activeRequestRef.current;
        if (
          !active ||
          active.requestId !== request.requestId ||
          currentConversationIdRef.current !== conversationId
        ) {
          return;
        }
        setActiveStream((current) => {
          const base = current ?? createAssistantStreamState(request.requestId);
          return applyProviderEvent(base, event);
        });
      });
      onStatus('Stream complete');
    } catch (error) {
      onStatus(error instanceof Error ? error.message : 'Stream failed');
    } finally {
      try {
        const messages = await getConversationMessages(conversationId);
        if (currentConversationIdRef.current === conversationId) {
          setTurns(messages.map(messageToTurn));
        }
      } catch {
        /* keep existing turns if reload fails */
      }
      if (activeRequestRef.current?.requestId === request.requestId) {
        activeRequestRef.current = null;
      }
      if (currentConversationIdRef.current === conversationId) {
        setActiveStream(null);
        setActiveRequestId(null);
      }
    }
  }

  async function handleCancel() {
    const active = activeRequestRef.current;
    if (!active || active.conversationId !== conversationId) return;
    await cancelChatStream({
      requestId: active.requestId,
      conversationId,
    });
    setActiveStream((current) => (current ? markInterrupted(current) : current));
    try {
      const messages = await getConversationMessages(conversationId);
      setTurns(messages.map(messageToTurn));
    } catch {
      /* ignore */
    }
    activeRequestRef.current = null;
    setActiveStream(null);
    setActiveRequestId(null);
    onStatus('Stream cancelled');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
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
              <AssistantMessage key={turn.id} state={turn.streamState} modelId={turn.modelId ?? settings.activeModel} />
            ) : (
              <div key={turn.id} className="msg enter">
                <div className="av-role bot" />
                <div className="msg-body">
                  <div className="msg-from"><b>Assistant</b><span className="model">{settings.activeModel}</span></div>
                  <div className="prose">
                    <p dangerouslySetInnerHTML={{ __html: escapeHtml(turn.content) }} />
                  </div>
                  {turn.interrupted && <div className="interrupted-banner">Generation was interrupted.</div>}
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