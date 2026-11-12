import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, ProviderRequest } from '@conduit/config-schema';
import { ChatView } from './ChatView';

/// A chat with "Use the browser" ticked declares the browser tools (from Rust's
/// `browser_tool_definitions`), with clicking and typing only when that is ticked
/// too; never with Computer off or in local-only mode.

const baseSettings: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: false,
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
  webSearchEnabled: true,
  webSearch: {
    mode: 'local' as const,
    localBackend: 'exa',
    searchContextSize: 'medium',
    allowedDomains: [],
    blockedDomains: [],
    externalWebAccess: true,
    returnTokenBudget: 'default',
    includeSources: false,
  },
  webSearchConsentAcknowledged: true,
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
  workflowComputer: { enabled: true, deny: [] },
};

vi.mock('../ipc/client', () => ({
  getConversationBrowser: vi.fn().mockResolvedValue({ use: false, act: false, sites: [] }),
  setConversationBrowser: vi.fn().mockResolvedValue(undefined),
  setConversationBrowserSites: vi.fn().mockResolvedValue(undefined),
  browserToolDefinitions: vi.fn(),
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

import { getConversationMessages, getMessageIdByRequest, startChatStream } from '../ipc/client';

import { browserToolDefinitions, getConversationBrowser } from '../ipc/client';

const PROMPT = 'open my GitHub notifications';

function tool(name: string) {
  return { name, description: name, inputSchema: { type: 'object', properties: {} } };
}

function captureRequest(): () => ProviderRequest | undefined {
  let request: ProviderRequest | undefined;
  vi.mocked(startChatStream).mockImplementation(async (req) => {
    request = req;
    return { requestId: req.requestId };
  });
  return () => request;
}

async function sendTurn(settings: Partial<AppSettings>): Promise<ProviderRequest> {
  const sent = captureRequest();
  render(
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
      compact
      pendingSendText={PROMPT}
      onPendingSendConsumed={vi.fn()}
    />,
  );
  await waitFor(() => expect(sent()).toBeDefined());
  return sent()!;
}

const toolNames = (request: ProviderRequest) => request.toolDefinitions.map((t) => t.name);

describe('ChatView browser tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConversationMessages).mockResolvedValue([]);
    vi.mocked(getMessageIdByRequest).mockResolvedValue(null);
    vi.mocked(browserToolDefinitions).mockImplementation(async (act: boolean) =>
      (act ? ['open_page', 'read_page', 'click', 'type_text'] : ['open_page', 'read_page']).map(tool) as never,
    );
  });

  it('declares no browser tool while the chat has it off', async () => {
    const names = toolNames(await sendTurn({}));
    expect(names).not.toContain('open_page');
    expect(browserToolDefinitions).not.toHaveBeenCalled();
  });

  it('declares the reading tools when "Use the browser" is on', async () => {
    vi.mocked(getConversationBrowser).mockResolvedValue({ use: true, act: false, sites: [] });
    const names = toolNames(await sendTurn({}));
    expect(browserToolDefinitions).toHaveBeenCalledWith(false);
    expect(names).toEqual(expect.arrayContaining(['open_page', 'read_page']));
    expect(names).not.toContain('click');
  });

  it('adds clicking and typing when "Let it click and type" is on', async () => {
    vi.mocked(getConversationBrowser).mockResolvedValue({ use: true, act: true, sites: [] });
    const names = toolNames(await sendTurn({}));
    expect(browserToolDefinitions).toHaveBeenCalledWith(true);
    expect(names).toEqual(expect.arrayContaining(['open_page', 'click', 'type_text']));
    expect(names.filter((n) => n === 'open_page')).toHaveLength(1);
  });

  it('declares none with Computer off', async () => {
    vi.mocked(getConversationBrowser).mockResolvedValue({ use: true, act: true, sites: [] });
    const names = toolNames(await sendTurn({ workflowComputer: { enabled: false, deny: [] } }));
    expect(names).not.toContain('open_page');
  });

  it('declares none in local-only mode', async () => {
    vi.mocked(getConversationBrowser).mockResolvedValue({ use: true, act: true, sites: [] });
    const names = toolNames(await sendTurn({ localOnly: true }));
    expect(names).not.toContain('open_page');
  });
});
