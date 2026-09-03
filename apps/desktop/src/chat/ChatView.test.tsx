import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AppSettings } from '@conduit/config-schema';
import type { Artifact } from '../ipc/contracts';
import { ChatView, describeInvokeError } from './ChatView';

const baseSettings: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'system',
  providerEndpoints: {},
  artifactRemoteAllowlist: [],
  artifactStyledPreview: true,
  updateChannel: 'stable',
  updateCheckEnabled: true,
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
}));

import {
  getConversationCompaction,
  getConversationMessages,
  getMessageIdByRequest,
  startChatStream,
} from '../ipc/client';

function renderChatView(overrides: {
  artifacts?: Artifact[];
} = {}) {
  const onStatus = vi.fn();
  const onSelectModel = vi.fn();
  const onPromoteArtifact = vi.fn();
  const onOpenArtifact = vi.fn();

  render(
    <ChatView
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
