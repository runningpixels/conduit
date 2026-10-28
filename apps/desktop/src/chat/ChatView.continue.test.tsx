import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, Message, ProviderEvent, ProviderRequest } from '@conduit/config-schema';
import { ChatView } from './ChatView';

/// Continue on a reply the output limit cut off: the same reply is written
/// further. No message is added, the live text lands in the same turn, and a
/// reload shows one reply.

const baseSettings: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'system',
  language: 'system',
  providerEndpoints: {},
  modelPriceOverrides: [],
  artifactRemoteAllowlist: [],
  artifactStyledPreview: true,
  artifactNetworkEnabled: true,
  closeToTray: false,
  closeToTrayOffered: false,
  updateChannel: 'stable',
  updateCheckEnabled: true,
  updatePolicy: 'manual' as const,
  onboardingCompleted: true,
  examplesSeeded: false,
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
  accent: {},
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
  getRequestEventLog: vi.fn(),
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
  attachmentDelivery: vi.fn().mockResolvedValue({ kind: 'text' }),
  prepareMessageEdit: vi.fn(),
  removeLastTurn: vi.fn().mockResolvedValue(1),
  startResearch: vi.fn(),
  getResearchRun: vi.fn(),
  approveResearchBrief: vi.fn(),
  stopResearch: vi.fn(),
  cancelResearch: vi.fn(),
  openExternalUrl: vi.fn(),
  getDraftResearchMaterial: vi.fn().mockResolvedValue([]),
}));

import {
  getConversationMessages,
  getMessageIdByRequest,
  getRequestEventLog,
  startChatStream,
} from '../ipc/client';

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  extra: Partial<Message> = {},
): Message {
  return {
    id,
    conversationId: 'conv-1',
    role,
    parts: [{ id: `${id}-p`, messageId: id, index: 0, kind: 'text', content: text, createdAt: '2026-10-01T00:00:00Z' }],
    createdAt: '2026-10-01T00:00:00Z',
    ...extra,
  } as Message;
}

const at = '2026-10-01T00:00:01.000Z';
const cutOffLog: ProviderEvent[] = [
  { kind: 'messageStart', requestId: 'req-1', index: 0 },
  { kind: 'contentBlockStart', requestId: 'req-1', blockId: 'block-0', index: 0, blockKind: 'text' },
  { kind: 'contentDelta', requestId: 'req-1', blockId: 'block-0', index: 0, content: 'The report covers' },
  { kind: 'messageComplete', requestId: 'req-1', index: 1, finishReason: 'length' },
];
// What the backend sends while continuing: the continuation's text goes on in
// the cut-off block (it never starts that block again).
const continuation: ProviderEvent[] = [
  { kind: 'replyContinued', requestId: 'req-1' },
  { kind: 'messageStart', requestId: 'req-1', index: 0 },
  { kind: 'contentDelta', requestId: 'req-1', blockId: 'block-0', index: 0, content: ' three regions.' },
  { kind: 'messageComplete', requestId: 'req-1', index: 1, finishReason: 'stop' },
];

function chat() {
  return (
    <ChatView
      settings={baseSettings}
      onSelectModel={vi.fn()}
      onStatus={vi.fn()}
      conversationId="conv-1"
      artifacts={[]}
      fileStateMap={{}}
      onPromoteArtifact={vi.fn()}
      onOpenArtifact={vi.fn()}
    />
  );
}

describe('ChatView: continue a cut-off reply', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConversationMessages).mockResolvedValue([
      message('m1', 'user', 'Write the report'),
      message('m2', 'assistant', 'The report covers', { requestId: 'req-1', finishReason: 'length' } as Partial<Message>),
    ]);
    vi.mocked(getRequestEventLog).mockResolvedValue({
      events: cutOffLog.map((event) => ({ event, at })),
      toolFinishedAt: {},
    });
    vi.mocked(getMessageIdByRequest).mockResolvedValue('m2');
  });

  it('writes the same reply further, with no new message', async () => {
    let sent: ProviderRequest | undefined;
    vi.mocked(startChatStream).mockImplementation(async (request, onEvent) => {
      sent = request;
      for (const event of continuation) onEvent(event);
      return { requestId: request.requestId };
    });
    render(chat());
    fireEvent.click(await screen.findByRole('button', { name: 'Continue this reply' }));

    await waitFor(() => expect(screen.getByText('The report covers three regions.')).toBeInTheDocument());
    expect(sent?.continueMessageId).toBe('m2');
    expect(sent?.requestId).toBe('req-1');
    // The history ends with the reply; no user message was added.
    expect(sent?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(document.querySelectorAll('.turn.assistant')).toHaveLength(1);
    expect(screen.getAllByText('Write the report')).toHaveLength(1);
    // It finished this time: no cut-off note, no Continue.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Continue this reply' })).toBeNull(),
    );
    expect(screen.queryByText(/reached the output limit/)).toBeNull();
  });

  it('shows one reply after a reload', async () => {
    vi.mocked(getConversationMessages).mockResolvedValue([
      message('m1', 'user', 'Write the report'),
      message('m2', 'assistant', 'The report covers three regions.', { requestId: 'req-1', finishReason: 'stop' } as Partial<Message>),
    ]);
    vi.mocked(getRequestEventLog).mockResolvedValue({
      events: [...cutOffLog, ...continuation].map((event) => ({ event, at })),
      toolFinishedAt: {},
    });
    render(chat());
    expect(await screen.findByText('The report covers three regions.')).toBeInTheDocument();
    expect(document.querySelectorAll('.turn.assistant')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Continue this reply' })).toBeNull();
  });

  it('leaves the reply as it was when the continuation is refused', async () => {
    vi.mocked(startChatStream).mockRejectedValue(new Error('Only the last reply in a chat can be continued.'));
    render(chat());
    fireEvent.click(await screen.findByRole('button', { name: 'Continue this reply' }));
    await waitFor(() => expect(startChatStream).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Continue this reply' })).toBeInTheDocument();
    expect(screen.getByText(/reached the output limit/)).toBeInTheDocument();
    expect(screen.getByText('The report covers')).toBeInTheDocument();
  });
});
