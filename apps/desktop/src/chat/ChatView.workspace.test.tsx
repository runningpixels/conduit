import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, Conversation, ProviderRequest } from '@conduit/config-schema';
import { ChatView } from './ChatView';

/// The workspace folder a chat's tools use is always visible, the Settings
/// default included, and can be turned off for one chat. A chat with the
/// default folder used to show no chip while its tools globbed the user's
/// Downloads, and picking a folder in any chat silently made it the default.

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
  workspaceToolsEnabled: true,
  workspaceRoot: 'D:\\Desktop\\Chrome Downloads',
  workspaceToolsConsentAcknowledged: true,
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
  getConversation: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
  setConversationWorkspace: vi.fn(),
  getConnectorRuntimeStates: vi.fn().mockResolvedValue([]),
  listConnectorCapabilities: vi.fn().mockResolvedValue([]),
  loadProviderCredentialReference: vi.fn().mockResolvedValue({
    providerId: 'anthropic',
    credentialRef: 'keychain://conduit/anthropic',
    storedInKeychain: true,
  }),
  listProviderDescriptors: vi.fn().mockResolvedValue([]),
  listProviderModels: vi.fn().mockResolvedValue([{ id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' }]),
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
  getConversation,
  getConversationMessages,
  getMessageIdByRequest,
  pickWorkspaceFolder,
  setConversationWorkspace,
  startChatStream,
  updateSettings,
} from '../ipc/client';

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function captureRequest(): () => ProviderRequest | undefined {
  let request: ProviderRequest | undefined;
  vi.mocked(startChatStream).mockImplementation(async (req) => {
    request = req;
    return { requestId: req.requestId };
  });
  return () => request;
}

function renderChat(settings: Partial<AppSettings> = {}) {
  return render(
    <ChatView
      settings={{ ...baseSettings, ...settings }}
      onSelectModel={vi.fn()}
      onStatus={vi.fn()}
      conversationId="conv-1"
      artifacts={[]}
      fileStateMap={{}}
      onPromoteArtifact={vi.fn()}
      onOpenArtifact={vi.fn()}
      onChatTurnComplete={vi.fn()}
    />,
  );
}

async function send(text: string): Promise<ProviderRequest> {
  const sent = captureRequest();
  const composer = screen.getByRole('textbox', { name: /message/i });
  fireEvent.change(composer, { target: { value: text } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  await waitFor(() => expect(sent()).toBeDefined());
  return sent()!;
}

const workspaceTools = (request: ProviderRequest) =>
  request.toolDefinitions.map((tool) => tool.name).filter((name) => name.startsWith('workspace_'));

describe('ChatView workspace folder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConversationMessages).mockResolvedValue([]);
    vi.mocked(getMessageIdByRequest).mockResolvedValue(null);
    vi.mocked(getConversation).mockResolvedValue(conversation());
  });

  it('shows the Settings default folder, marked as the default, when its tools are live', async () => {
    renderChat();
    const row = await screen.findByRole('group', { name: 'Active in this chat' });
    expect(row).toHaveTextContent('Chrome Downloads (default)');
    const request = await send('list the files here');
    expect(workspaceTools(request)).toContain('workspace_glob');
  });

  it('× turns folder access off for this chat: no chip and no workspace tool', async () => {
    vi.mocked(setConversationWorkspace).mockResolvedValue(conversation({ metadata: { workspaceDisabled: true } }));
    renderChat();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop using folder Chrome Downloads in this chat' }));
    await waitFor(() => expect(setConversationWorkspace).toHaveBeenCalledWith('conv-1', null));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Active in this chat' })).toBeNull());
    const request = await send('list the files here');
    expect(workspaceTools(request)).toEqual([]);
    // The default itself is untouched: other chats keep it.
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('a chat whose folder access is off stays off after it is reopened', async () => {
    vi.mocked(getConversation).mockResolvedValue(conversation({ metadata: { workspaceDisabled: true } }));
    renderChat();
    await waitFor(() => expect(getConversation).toHaveBeenCalled());
    const request = await send('list the files here');
    expect(workspaceTools(request)).toEqual([]);
    expect(screen.queryByRole('group', { name: 'Active in this chat' })).toBeNull();
  });

  it('another chat without the switch still uses the default', async () => {
    vi.mocked(getConversation).mockResolvedValue(conversation({ metadata: { other: 1 } }));
    renderChat();
    const request = await send('list the files here');
    expect(workspaceTools(request)).toContain('workspace_read');
  });

  it('picking a folder binds it to this chat only and never changes the Settings default', async () => {
    vi.mocked(pickWorkspaceFolder).mockResolvedValue('D:\\proj');
    vi.mocked(setConversationWorkspace).mockResolvedValue(conversation({ workspaceRoot: 'D:\\proj' }));
    renderChat({ workspaceToolsEnabled: false, workspaceRoot: null });
    fireEvent.click(await screen.findByRole('button', { name: 'Add to this message' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Workspace folder…' }));
    await waitFor(() => expect(setConversationWorkspace).toHaveBeenCalledWith('conv-1', 'D:\\proj'));
    const row = await screen.findByRole('group', { name: 'Active in this chat' });
    expect(row).toHaveTextContent('proj');
    expect(row).not.toHaveTextContent('(default)');
    for (const call of vi.mocked(updateSettings).mock.calls) {
      expect(call[0]).not.toHaveProperty('workspaceRoot');
    }
  });
});
