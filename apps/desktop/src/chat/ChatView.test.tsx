import { createRef, type RefObject } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AppSettings, Message, MessagePart } from '@conduit/config-schema';
import type { Artifact } from '../ipc/contracts';
import { ChatView, describeInvokeError, type ChatViewHandle } from './ChatView';

const baseSettings: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'system',
  language: 'system',
  providerEndpoints: {},
  artifactRemoteAllowlist: [],
  artifactStyledPreview: true,
  artifactNetworkEnabled: true,
  updateChannel: 'stable',
  updateCheckEnabled: true,
  updatePolicy: 'manual' as const,
  onboardingCompleted: true,
  webSearchEnabled: false,
  webSearch: {
    mode: 'auto' as const,
    localBackend: 'duckduckgo',
    searchContextSize: 'medium',
    allowedDomains: [],
    blockedDomains: [],
    externalWebAccess: true,
    returnTokenBudget: 'default',
    includeSources: false,
  },
  webSearchConsentAcknowledged: false,
  imageGenerationConsentAcknowledged: false,
  embeddingConsentProviders: [],
  pdfImportNoticeAcknowledged: false,
  agent: {
    maxSteps: 25,
    wallClockBudgetSecs: 300,
  },
  keychainMode: 'os' as const,
  brandingEnabled: false,
  workspaceToolsEnabled: false,
  workspaceRoot: null,
  workspaceToolsConsentAcknowledged: false,
  generationControls: null,
  userInstructions: null,
  contextCompactEnabled: true,
  contextCompactThresholdPercent: 90,
  memoryEnabled: true,
};

vi.mock('../ipc/client', () => ({
  getConversationMessages: vi.fn().mockResolvedValue([]),
  getConversationCompaction: vi.fn().mockResolvedValue(null),
  compactConversation: vi.fn().mockResolvedValue(null),
  getConversation: vi.fn().mockResolvedValue({
    id: 'conv-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }),
  pickWorkspaceFolder: vi.fn(),
  setConversationWorkspace: vi.fn(),
  getConnectorRuntimeStates: vi.fn().mockResolvedValue([]),
  listConnectorCapabilities: vi.fn().mockResolvedValue([]),
  loadProviderCredentialReference: vi.fn().mockResolvedValue({
    providerId: 'anthropic',
    credentialRef: 'keychain://conduit/anthropic',
    storedInKeychain: true,
  }),
  listProviderDescriptors: vi.fn().mockResolvedValue([
    {
      id: 'anthropic',
      displayName: 'Anthropic',
      defaultBaseUrl: null,
      credentialMode: 'required',
      isLocal: false,
      showBaseUrlField: false,
      tier: 0,
      description: null,
    },
  ]),
  listProviderModels: vi.fn().mockResolvedValue([
    { id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' },
  ]),
  updateSettings: vi.fn().mockImplementation(async (settings: AppSettings) => settings),
  saveAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
  getArtifact: vi.fn(),
  startChatStream: vi.fn(),
  cancelChatStream: vi.fn(),
  getMessageIdByRequest: vi.fn(),
  discoverConnector: vi.fn(),
  startConnector: vi.fn(),
  invokeConnectorTool: vi.fn(),
  listSkills: vi.fn().mockResolvedValue([]),
  listConversationSkills: vi.fn().mockResolvedValue([]),
  setConversationSkills: vi.fn().mockResolvedValue([]),
  getSkillPromptBlock: vi.fn().mockResolvedValue(''),
  getMemoryPromptBlock: vi.fn().mockResolvedValue(''),
  listKnowledgeCollections: vi.fn().mockResolvedValue([]),
  listConversationCollections: vi.fn().mockResolvedValue([]),
  listConversationExcludedDocuments: vi.fn().mockResolvedValue([]),
  setConversationDocumentExcluded: vi.fn().mockResolvedValue([]),
  listKnowledgeDocuments: vi.fn().mockResolvedValue([]),
  retrieveKnowledgeContext: vi.fn().mockResolvedValue({
    text: '',
    citations: [],
    refusedTitles: [],
    unavailableCollections: [],
  }),
  saveDroppedAttachment: vi.fn(),
  prepareMessageEdit: vi.fn(),
  removeLastTurn: vi.fn().mockResolvedValue(1),
}));

import {
  getConversationCompaction,
  getConversationMessages,
  getMessageIdByRequest,
  startChatStream,
} from '../ipc/client';

function renderChatView(overrides: {
  artifacts?: Artifact[];
  ref?: RefObject<ChatViewHandle | null>;
} = {}) {
  const onStatus = vi.fn();
  const onSelectModel = vi.fn();
  const onPromoteArtifact = vi.fn();
  const onOpenArtifact = vi.fn();

  render(
    <ChatView
      ref={overrides.ref}
      settings={baseSettings}
      onSelectModel={onSelectModel}
      onStatus={onStatus}
      conversationId="conv-1"
      artifacts={overrides.artifacts ?? []}
      fileStateMap={{}}
      onPromoteArtifact={onPromoteArtifact}
      onOpenArtifact={onOpenArtifact}
    />,
  );

  return { onStatus, onSelectModel };
}

describe('describeInvokeError', () => {
  it('returns message from Error objects', () => {
    expect(describeInvokeError(new Error('stream failed'))).toBe('stream failed');
  });

  it('returns plain string errors directly', () => {
    expect(describeInvokeError('provider unavailable')).toBe('provider unavailable');
    expect(describeInvokeError('')).toBe('');
  });

  it('extracts message from object with message property', () => {
    expect(describeInvokeError({ message: 'rate limited' })).toBe('rate limited');
  });

  it('extracts error from object with error property', () => {
    expect(describeInvokeError({ error: 'connection refused' })).toBe('connection refused');
  });

  it('stringifies unknown objects', () => {
    const result = describeInvokeError({ code: 500, detail: 'timeout' });
    expect(result).toContain('code');
    expect(result).toContain('500');
  });

  it('returns fallback for null', () => {
    expect(describeInvokeError(null)).toBe('Stream failed');
  });

  it('returns fallback for undefined', () => {
    expect(describeInvokeError(undefined)).toBe('Stream failed');
  });

  it('returns fallback for numbers', () => {
    expect(describeInvokeError(42)).toBe('Stream failed');
  });

  it('message property wins over error property', () => {
    expect(describeInvokeError({ message: 'msg', error: 'err' })).toBe('msg');
  });

  it('returns fallback for objects that throw on JSON.stringify', () => {
    const circular: Record<string, unknown> = { a: null };
    circular.a = circular;
    expect(describeInvokeError(circular)).toBe('Stream failed');
  });
});

describe('ChatView suggested prompts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConversationMessages).mockResolvedValue([]);
    vi.mocked(getConversationCompaction).mockResolvedValue(null);
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        const lines = this.value ? this.value.split('\n').length : 1;
        return lines * 24;
      },
    });
  });

  // The empty thread is a greeting and the composer (§10). The starter cards,
  // the shortcut hint row and the duplicated model line were all removed, so
  // the only suggestion surface left is the contextual follow-up row below.
  it('shows only the greeting in an empty chat', async () => {
    renderChatView();
    expect(
      await screen.findByRole('heading', { name: /What are we working on\?/i }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Suggested follow-ups' })).not.toBeInTheDocument();
  });

  it('shows contextual follow-ups for a non-empty conversation', async () => {
    vi.mocked(getConversationMessages).mockResolvedValue([
      {
        id: 'u1',
        conversationId: 'conv-1',
        role: 'user',
        parts: [
          {
            id: 'u1-p0',
            messageId: 'u1',
            index: 0,
            kind: 'text',
            content: 'hello',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'a1',
        conversationId: 'conv-1',
        role: 'assistant',
        parts: [
          {
            id: 'a1-p0',
            messageId: 'a1',
            index: 0,
            kind: 'text',
            content: 'Hi there!',
            createdAt: '2026-01-01T00:00:01Z',
          },
        ],
        createdAt: '2026-01-01T00:00:01Z',
      },
    ]);

    renderChatView();
    expect(await screen.findByLabelText('Suggested follow-ups')).toBeInTheDocument();
    expect(screen.queryByLabelText('Suggested prompts')).toBeNull();
  });

  it('hides inline suggestions while the user is typing', async () => {
    vi.mocked(getConversationMessages).mockResolvedValue([
      {
        id: 'u1',
        conversationId: 'conv-1',
        role: 'user',
        parts: [
          {
            id: 'u1-p0',
            messageId: 'u1',
            index: 0,
            kind: 'text',
            content: 'hello',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'a1',
        conversationId: 'conv-1',
        role: 'assistant',
        parts: [
          {
            id: 'a1-p0',
            messageId: 'a1',
            index: 0,
            kind: 'text',
            content: 'Hi there!',
            createdAt: '2026-01-01T00:00:01Z',
          },
        ],
        createdAt: '2026-01-01T00:00:01Z',
      },
    ]);

    renderChatView();
    expect(await screen.findByLabelText('Suggested follow-ups')).toBeInTheDocument();

    const textarea = screen.getByLabelText('Message the active provider');
    fireEvent.change(textarea, { target: { value: 'typing…' } });

    await waitFor(() => {
      expect(screen.queryByLabelText('Suggested follow-ups')).toBeNull();
    });
  });

  it('shows artifact-oriented follow-ups when a document artifact exists', async () => {
    vi.mocked(getConversationMessages).mockResolvedValue([
      {
        id: 'u1',
        conversationId: 'conv-1',
        role: 'user',
        parts: [
          {
            id: 'u1-p0',
            messageId: 'u1',
            index: 0,
            kind: 'text',
            content: 'create html',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'a1',
        conversationId: 'conv-1',
        role: 'assistant',
        parts: [
          {
            id: 'a1-p0',
            messageId: 'a1',
            index: 0,
            kind: 'text',
            content: 'Done.',
            createdAt: '2026-01-01T00:00:01Z',
          },
        ],
        createdAt: '2026-01-01T00:00:01Z',
      },
    ]);

    const artifact: Artifact = {
      id: 'art-1',
      conversationId: 'conv-1',
      kind: 'html',
      title: 'API Overview',
      createdAt: '2026-01-01T00:00:00Z',
    };

    renderChatView({ artifacts: [artifact] });
    expect(await screen.findByLabelText('Suggested follow-ups')).toBeInTheDocument();
    // The chip is named by its short caption — the full instruction would not
    // fit on one line — and carries the prompt it sends as its description.
    const chip = screen.getByRole('button', { name: 'Tighten the wording' });
    expect(chip).toHaveAttribute(
      'title',
      'Improve "API Overview" — tighten the wording and fix any gaps.',
    );
  });

  it('preserves line breaks in multi-line user messages', async () => {
    const multiLine = 'line one\nline two\nline three';
    vi.mocked(getConversationMessages).mockResolvedValue([
      {
        id: 'u1',
        conversationId: 'conv-1',
        role: 'user',
        parts: [
          {
            id: 'u1-p0',
            messageId: 'u1',
            index: 0,
            kind: 'text',
            content: multiLine,
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);

    renderChatView();
    const paragraph = await screen.findByText((_, el) => {
      return el?.tagName === 'P' && el.textContent === multiLine;
    });
    expect(paragraph.textContent).toBe(multiLine);
    expect(paragraph.closest('.bubble')).not.toBeNull();
  });
});

/**
 * `start_chat_stream` is fire-and-forget: the invoke resolves as soon as the
 * stream is spawned, and a real provider's events arrive afterwards. Every
 * other test here delivers events synchronously inside the mock, which is how
 * the 2026-06-25 "stream completes blank" bug hid — teardown ran on the invoke
 * resolving and dropped the late events. This delivers them late.
 * (docs/postmortems/2026-06-25-chat-stream-completes-blank.md, Prevention.)
 */
describe('ChatView latent stream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConversationMessages).mockResolvedValue([]);
    vi.mocked(getMessageIdByRequest).mockResolvedValue(null);
  });

  it('keeps events that arrive after startChatStream has resolved', async () => {
    const onChatTurnComplete = vi.fn();
    let invokeResolved = false;

    vi.mocked(startChatStream).mockImplementation(async (request, onEvent) => {
      const { requestId } = request;
      setTimeout(() => {
        // The invoke must already be settled, or this proves nothing.
        expect(invokeResolved).toBe(true);
        onEvent({ kind: 'messageStart', requestId, index: 0 });
        onEvent({ kind: 'contentBlockStart', requestId, blockId: 'block-0', index: 1, blockKind: 'text' });
        onEvent({ kind: 'contentDelta', requestId, blockId: 'block-0', index: 2, content: 'Test received.' });
        onEvent({ kind: 'contentDelta', requestId, blockId: 'block-0', index: 3, content: ' How can I help?' });
        onEvent({ kind: 'messageComplete', requestId, index: 4, finishReason: 'stop' });
      }, 30);
      queueMicrotask(() => {
        invokeResolved = true;
      });
      return { requestId };
    });

    render(
      <ChatView
        settings={baseSettings}
        onSelectModel={vi.fn()}
        onStatus={vi.fn()}
        conversationId="conv-1"
        artifacts={[]}
        fileStateMap={{}}
        onPromoteArtifact={vi.fn()}
        onOpenArtifact={vi.fn()}
        onChatTurnComplete={onChatTurnComplete}
      />,
    );

    const textarea = await screen.findByLabelText('Message the active provider');
    fireEvent.change(textarea, { target: { value: 'Test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(onChatTurnComplete).toHaveBeenCalled());
    const state = onChatTurnComplete.mock.calls[0][0];
    expect(state.blocks.map((b: { content: string }) => b.content).join('')).toBe(
      'Test received. How can I help?',
    );
    expect(state.error ?? null).toBeNull();
  });
});

/**
 * Every delta used to re-render the whole live turn, so a provider sending
 * faster than that render could keep the UI permanently behind. Deltas now
 * render at most once per frame; anything structural still renders at once.
 */
describe('ChatView stream render batching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConversationMessages).mockResolvedValue([]);
    vi.mocked(getMessageIdByRequest).mockResolvedValue(null);
  });

  it('renders a burst of deltas in one frame, and the end of the turn at once', async () => {
    let emit: ((e: never) => void) | undefined;
    let requestId = '';
    vi.mocked(startChatStream).mockImplementation(async (request, onEvent) => {
      requestId = request.requestId;
      emit = onEvent as (e: never) => void;
      return { requestId };
    });
    const onChatTurnComplete = vi.fn();
    render(
      <ChatView
        settings={baseSettings}
        onSelectModel={vi.fn()}
        onStatus={vi.fn()}
        conversationId="conv-1"
        artifacts={[]}
        fileStateMap={{}}
        onPromoteArtifact={vi.fn()}
        onOpenArtifact={vi.fn()}
        onChatTurnComplete={onChatTurnComplete}
      />,
    );
    const textarea = await screen.findByLabelText('Message the active provider');
    fireEvent.change(textarea, { target: { value: 'Test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(emit).toBeDefined());
    const send = (e: object) => act(() => emit!(e as never));
    send({ kind: 'messageStart', requestId, index: 0 });
    send({ kind: 'contentBlockStart', requestId, blockId: 'b0', index: 1, blockKind: 'text' });

    // Hold frames so the test decides when one fires.
    const frames: FrameRequestCallback[] = [];
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    try {
      for (let i = 0; i < 40; i += 1) {
        send({ kind: 'contentDelta', requestId, blockId: 'b0', index: 2 + i, content: `w${i} ` });
      }
      expect(raf).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/w39/)).toBeNull();

      act(() => frames.splice(0).forEach((cb) => cb(performance.now())));
      expect(screen.getByText(/w0 .*w39/)).toBeInTheDocument();

      // A delta waiting on the next frame still lands with the terminal event.
      send({ kind: 'contentDelta', requestId, blockId: 'b0', index: 50, content: 'last' });
      send({ kind: 'messageComplete', requestId, index: 51, finishReason: 'stop' });
    } finally {
      raf.mockRestore();
    }
    await waitFor(() => expect(onChatTurnComplete).toHaveBeenCalled());
    const state = onChatTurnComplete.mock.calls[0][0];
    expect(state.blocks.map((b: { content: string }) => b.content).join('')).toMatch(/w39 last$/);
  });
});

/**
 * A message sent from a new chat while the previous chat's turn was still
 * finishing got queued under the new chat — and the drain that runs when a turn
 * ends only looked at the finishing turn's conversation, so it stayed queued
 * forever. Found while driving the live app.
 */
describe('ChatView queue across conversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConversationMessages).mockResolvedValue([]);
    vi.mocked(getMessageIdByRequest).mockResolvedValue(null);
  });

  it('sends a message queued in a new chat once the previous chat’s turn ends', async () => {
    const streams: Array<{ requestId: string; conversationId: string; onEvent: (e: never) => void }> = [];
    vi.mocked(startChatStream).mockImplementation(async (request, onEvent) => {
      streams.push({ requestId: request.requestId, conversationId: request.conversationId, onEvent: onEvent as never });
      return { requestId: request.requestId };
    });

    const props = {
      settings: baseSettings,
      onSelectModel: vi.fn(),
      onStatus: vi.fn(),
      artifacts: [],
      fileStateMap: {},
      onPromoteArtifact: vi.fn(),
      onOpenArtifact: vi.fn(),
    };
    const { rerender } = render(<ChatView {...props} conversationId="conv-1" />);

    const first = await screen.findByLabelText('Message the active provider');
    fireEvent.change(first, { target: { value: 'Make a document' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(streams).toHaveLength(1));

    // Switch chats while that turn is still open, and send there.
    rerender(<ChatView {...props} conversationId="conv-2" />);
    const second = await screen.findByLabelText('Message the active provider');
    fireEvent.change(second, { target: { value: 'Hello from the new chat' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(streams).toHaveLength(1);

    const { requestId, onEvent } = streams[0];
    (onEvent as (e: unknown) => void)({ kind: 'messageComplete', requestId, index: 0, finishReason: 'stop' });

    await waitFor(() => expect(streams).toHaveLength(2));
    expect(streams[1].conversationId).toBe('conv-2');
  });
});

/**
 * A turn that dies mid-flight used to strand the workspace: `onChatTurnComplete`
 * was gated on `!errorText`, and it is the only path that resolves the pending
 * artifact state — so the document panel kept shimmering "Generating…" forever.
 */
describe('ChatView failed turn cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConversationMessages).mockResolvedValue([]);
    vi.mocked(getMessageIdByRequest).mockResolvedValue(null);
  });

  async function sendAndFail() {
    const onChatTurnComplete = vi.fn();
    const onDocumentToolActivity = vi.fn();

    vi.mocked(startChatStream).mockImplementation(async (request, onEvent) => {
      onEvent({
        kind: 'toolCallStart',
        requestId: request.requestId,
        toolCallId: 'call-1',
        index: 0,
        toolId: 'write_html_document',
        name: 'write_html_document',
      });
      onEvent({
        kind: 'error',
        requestId: request.requestId,
        error: {
          message: 'Agent turn exceeded wall-clock budget (300s) waiting on the provider.',
          retryable: false,
        },
      });
      return { requestId: request.requestId };
    });

    render(
      <ChatView
        settings={baseSettings}
        onSelectModel={vi.fn()}
        onStatus={vi.fn()}
        conversationId="conv-1"
        artifacts={[]}
        fileStateMap={{}}
        onPromoteArtifact={vi.fn()}
        onOpenArtifact={vi.fn()}
        onChatTurnComplete={onChatTurnComplete}
        onDocumentToolActivity={onDocumentToolActivity}
      />,
    );

    const textarea = await screen.findByLabelText('Message the active provider');
    fireEvent.change(textarea, { target: { value: 'make me an html artifact' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    await waitFor(() => expect(onChatTurnComplete).toHaveBeenCalled());
    return { onChatTurnComplete, onDocumentToolActivity };
  }

  it('notifies the workspace even when the turn ends in an error', async () => {
    const { onChatTurnComplete, onDocumentToolActivity } = await sendAndFail();

    expect(onDocumentToolActivity).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'start', toolName: 'write_html_document' }),
    );
    const state = onChatTurnComplete.mock.calls[0][0];
    expect(state.streaming).toBe(false);
    expect(state.error).toMatch(/wall-clock budget/);
  });

  it('hands over a turn with no tool call still claiming to run', async () => {
    const { onChatTurnComplete } = await sendAndFail();

    const state = onChatTurnComplete.mock.calls[0][0];
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0].status).toBe('failed');
    expect(state.toolCalls[0].endedAt).toBeTypeOf('number');
  });
});

describe('ChatView M1: native window drop routes through the composer (D13)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConversationMessages).mockResolvedValue([]);
    vi.mocked(getConversationCompaction).mockResolvedValue(null);
  });

  it('handleComposerDrop attaches the dropped path the way an HTML5 drop would', async () => {
    const { saveDroppedAttachment } = await import('../ipc/client');
    vi.mocked(saveDroppedAttachment).mockResolvedValue({
      id: 'att-drop-1',
      conversationId: 'conv-1',
      path: 'ab/cd',
      mimeType: 'text/plain',
      sizeBytes: 3,
      retentionState: 'active',
      createdAt: '2026-01-01T00:00:00Z',
      origin: 'dropped.txt',
    });
    const ref = createRef<ChatViewHandle>();
    renderChatView({ ref });
    await screen.findByLabelText('Message the active provider');

    act(() => ref.current?.handleComposerDrop(['C:\\notes\\dropped.txt']));

    expect(await screen.findByText('dropped.txt')).toBeInTheDocument();
    expect(saveDroppedAttachment).toHaveBeenCalledWith('conv-1', 'C:\\notes\\dropped.txt');
  });
});

describe('ChatView M2: document exclusion toggle (D1/D2)', () => {
  const collection = {
    id: 'c1',
    name: 'Greenhouse',
    providerId: 'openrouter',
    embeddingModel: 'openai/text-embedding-3-small',
    embeddingDimensions: 1536,
    documentCount: 2,
    createdAt: '2026-09-20T00:00:00Z',
    updatedAt: '2026-09-20T00:00:00Z',
  };
  function knowledgeDoc(id: string, title: string) {
    return {
      id,
      collectionId: 'c1',
      source: `/greenhouse/${title}`,
      title,
      mimeType: 'text/plain',
      byteSize: 10,
      chunkCount: 1,
      importedAt: '2026-09-20T00:00:00Z',
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(getConversationMessages).mockResolvedValue([]);
    vi.mocked(getConversationCompaction).mockResolvedValue(null);
    const {
      listKnowledgeCollections,
      listConversationCollections,
      listConversationExcludedDocuments,
      listKnowledgeDocuments,
    } = await import('../ipc/client');
    vi.mocked(listKnowledgeCollections).mockResolvedValue([collection]);
    vi.mocked(listConversationCollections).mockResolvedValue(['c1']);
    vi.mocked(listConversationExcludedDocuments).mockResolvedValue([]);
    vi.mocked(listKnowledgeDocuments).mockResolvedValue([
      knowledgeDoc('d1', 'notes.md'),
      knowledgeDoc('d2', 'stale.md'),
    ]);
  });

  async function openDocumentsList() {
    fireEvent.click(await screen.findByRole('button', { name: 'Add to this message' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Documents…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show documents in Greenhouse' }));
  }

  it('unchecking a document excludes it, with an optimistic update reconciled to the canonical result', async () => {
    const { setConversationDocumentExcluded } = await import('../ipc/client');
    vi.mocked(setConversationDocumentExcluded).mockResolvedValue(['d2']);
    renderChatView();
    await screen.findByLabelText('Message the active provider');

    await openDocumentsList();
    const stale = await screen.findByRole('checkbox', { name: 'stale.md' });
    expect(stale).toBeChecked();

    fireEvent.click(stale);
    // Optimistic: unchecked immediately, before the write resolves.
    expect(screen.getByRole('checkbox', { name: 'stale.md' })).not.toBeChecked();
    await waitFor(() => expect(setConversationDocumentExcluded).toHaveBeenCalledWith('conv-1', 'd2', true));
    expect(screen.getByRole('checkbox', { name: 'stale.md' })).not.toBeChecked();
  });

  it('rolls back the optimistic state and reports a status when the write fails', async () => {
    const { setConversationDocumentExcluded } = await import('../ipc/client');
    vi.mocked(setConversationDocumentExcluded).mockRejectedValue(new Error('offline'));
    const { onStatus } = renderChatView();
    await screen.findByLabelText('Message the active provider');

    await openDocumentsList();
    const stale = await screen.findByRole('checkbox', { name: 'stale.md' });
    fireEvent.click(stale);

    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'stale.md' })).toBeChecked());
    expect(onStatus).toHaveBeenCalled();
  });
});

describe('ChatView M3: edit-and-resend keeps knowledge references (D9)', () => {
  function knowledgeRefPart(): MessagePart {
    return {
      id: 'u1-kref-doc-1',
      messageId: 'u1',
      index: 1,
      kind: 'knowledgeReference',
      metadata: {
        documentId: 'doc-1',
        title: 'greenhouse.md',
        collectionId: 'c1',
        collectionName: 'Research',
      },
      createdAt: '2026-01-01T00:00:00Z',
    };
  }

  function originalMessages(): Message[] {
    return [
      {
        id: 'u1',
        conversationId: 'conv-1',
        role: 'user',
        parts: [
          {
            id: 'u1-part-0',
            messageId: 'u1',
            index: 0,
            kind: 'text',
            content: 'what does it say?',
            createdAt: '2026-01-01T00:00:00Z',
          },
          knowledgeRefPart(),
        ],
        createdAt: '2026-01-01T00:00:00Z',
      },
    ];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConversationCompaction).mockResolvedValue(null);
    vi.mocked(getMessageIdByRequest).mockResolvedValue(null);
  });

  it('editing and resending a referenced turn keeps its knowledgeReference part on the new request', async () => {
    const { prepareMessageEdit } = await import('../ipc/client');
    vi.mocked(prepareMessageEdit).mockResolvedValue({
      mode: 'in_place',
      conversation: { id: 'conv-1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    });
    // First call is the initial hydrate; the second is commitMessageEdit's
    // reload after `prepareMessageEdit` truncates the conversation at the
    // edited message (an "in place" edit leaves nothing after it to reload).
    vi.mocked(getConversationMessages).mockResolvedValueOnce(originalMessages()).mockResolvedValueOnce([]);

    let capturedRequest: Parameters<typeof startChatStream>[0] | undefined;
    vi.mocked(startChatStream).mockImplementation(async (request, onEvent) => {
      capturedRequest = request;
      onEvent({ kind: 'messageComplete', requestId: request.requestId, index: 0, finishReason: 'stop' });
      return { requestId: request.requestId };
    });

    renderChatView();

    // The original turn renders with its reference chip.
    await screen.findByText('what does it say?');
    expect(await screen.findByText('greenhouse.md · Research')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editBox = screen.getByLabelText('Edit message');
    fireEvent.change(editBox, { target: { value: 'what does it say, exactly?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(startChatStream).toHaveBeenCalled());
    const resentUser = capturedRequest!.messages.find((m) => m.role === 'user')!;
    const kref = resentUser.parts.find((p) => p.kind === ('knowledgeReference' as unknown as MessagePart['kind']));
    expect(kref).toMatchObject({
      metadata: { documentId: 'doc-1', title: 'greenhouse.md', collectionId: 'c1', collectionName: 'Research' },
    });
  });
});

describe('ChatView: Retry re-sends the last question', () => {
  function messages(): Message[] {
    return [
      {
        id: 'u1',
        conversationId: 'conv-1',
        role: 'user',
        parts: [
          { id: 'u1-part-0', messageId: 'u1', index: 0, kind: 'text', content: 'what does it say?', createdAt: '2026-01-01T00:00:00Z' },
          {
            id: 'u1-kref-doc-1',
            messageId: 'u1',
            index: 1,
            kind: 'knowledgeReference',
            metadata: { documentId: 'doc-1', title: 'greenhouse.md', collectionId: 'c1', collectionName: 'Research' },
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'a1',
        conversationId: 'conv-1',
        role: 'assistant',
        parts: [{ id: 'a1-part-0', messageId: 'a1', index: 0, kind: 'text', content: 'The first answer.', createdAt: '2026-01-01T00:00:01Z' }],
        createdAt: '2026-01-01T00:00:01Z',
      },
    ];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConversationCompaction).mockResolvedValue(null);
    vi.mocked(getMessageIdByRequest).mockResolvedValue(null);
  });

  it('offers Retry on the last reply only', async () => {
    const two: Message[] = [
      ...messages(),
      {
        id: 'u2', conversationId: 'conv-1', role: 'user', createdAt: '2026-01-01T00:00:02Z',
        parts: [{ id: 'u2-part-0', messageId: 'u2', index: 0, kind: 'text', content: 'and then?', createdAt: '2026-01-01T00:00:02Z' }],
      },
      {
        id: 'a2', conversationId: 'conv-1', role: 'assistant', createdAt: '2026-01-01T00:00:03Z',
        parts: [{ id: 'a2-part-0', messageId: 'a2', index: 0, kind: 'text', content: 'The second answer.', createdAt: '2026-01-01T00:00:03Z' }],
      },
    ];
    vi.mocked(getConversationMessages).mockResolvedValueOnce(two);
    renderChatView();
    await screen.findByText('The second answer.');
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  });

  it('replaces the reply by re-sending the question with its references, not by only deleting it', async () => {
    const { prepareMessageEdit, removeLastTurn } = await import('../ipc/client');
    vi.mocked(prepareMessageEdit).mockResolvedValue({
      mode: 'in_place',
      conversation: { id: 'conv-1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    });
    vi.mocked(getConversationMessages).mockResolvedValueOnce(messages()).mockResolvedValueOnce([]);
    let captured: Parameters<typeof startChatStream>[0] | undefined;
    vi.mocked(startChatStream).mockImplementation(async (request, onEvent) => {
      captured = request;
      onEvent({ kind: 'messageComplete', requestId: request.requestId, index: 0, finishReason: 'stop' });
      return { requestId: request.requestId };
    });

    renderChatView();
    await screen.findByText('The first answer.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(startChatStream).toHaveBeenCalled());
    expect(prepareMessageEdit).toHaveBeenCalledWith('conv-1', 'u1');
    expect(removeLastTurn).not.toHaveBeenCalled();
    const resent = captured!.messages.filter((m) => m.role === 'user').at(-1)!;
    expect(resent.parts.find((p) => p.kind === 'text')?.content).toBe('what does it say?');
    expect(resent.parts.find((p) => p.kind === 'knowledgeReference')).toMatchObject({
      metadata: { documentId: 'doc-1' },
    });
  });
});
