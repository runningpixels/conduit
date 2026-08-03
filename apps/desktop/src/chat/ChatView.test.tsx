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
};

vi.mock('../ipc/client', () => ({
  getConversationMessages: vi.fn().mockResolvedValue([]),
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

import { getConversationMessages } from '../ipc/client';

function renderChatView(overrides: {
  artifacts?: Artifact[];
} = {}) {
  const onStatus = vi.fn();
  const onSettingsChange = vi.fn();
  const onPromoteArtifact = vi.fn();
  const onOpenArtifact = vi.fn();

  render(
    <ChatView
      settings={baseSettings}
      onSettingsChange={onSettingsChange}
      onStatus={onStatus}
      conversationId="conv-1"
      artifacts={overrides.artifacts ?? []}
      fileStateMap={{}}
      onPromoteArtifact={onPromoteArtifact}
      onOpenArtifact={onOpenArtifact}
    />,
  );

  return { onStatus, onSettingsChange };
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
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        const lines = this.value ? this.value.split('\n').length : 1;
        return lines * 24;
      },
    });
  });

  it('shows starter prompts in an empty chat', async () => {
    renderChatView();
    expect(await screen.findByLabelText('Suggested prompts')).toBeInTheDocument();
    expect(screen.getByText('Draft a triage note summarizing our open GitHub issues.')).toBeInTheDocument();
  });

  it('fills the composer when a starter prompt is clicked', async () => {
    renderChatView();
    const promptButton = await screen.findByRole('button', {
      name: /Draft a triage note summarizing our open GitHub issues/i,
    });
    fireEvent.click(promptButton);

    const textarea = screen.getByLabelText('Message the active provider') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Draft a triage note summarizing our open GitHub issues.');
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
    expect(
      screen.getByRole('button', { name: /Improve "API Overview"/i }),
    ).toBeInTheDocument();
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
