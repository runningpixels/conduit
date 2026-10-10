import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, ProviderRequest } from '@conduit/config-schema';
import { ChatView } from './ChatView';

/// A normal chat reads web pages whenever web access is on in Settings: the
/// turn declares `web_fetch` even with the search toggle off, so "open Hacker
/// News and summarise it" is not answered with "I can't browse". Search
/// itself still needs the toggle (or a search-sounding prompt).

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

const HN_PROMPT =
  'can you open Hacker News / Ycombinator, read the main stories and make me an artifact with a summary and clickable links';
const FETCH_PROMPT_LINE = 'You can read public web pages with web_fetch.';

function captureRequest(): () => ProviderRequest | undefined {
  let request: ProviderRequest | undefined;
  vi.mocked(startChatStream).mockImplementation(async (req) => {
    request = req;
    return { requestId: req.requestId };
  });
  return () => request;
}

function renderChat(settings: Partial<AppSettings>, pendingSendText: string | null) {
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
      compact
      pendingSendText={pendingSendText}
      onPendingSendConsumed={vi.fn()}
    />,
  );
}

async function sendTurn(settings: Partial<AppSettings>, prompt: string): Promise<ProviderRequest> {
  const sent = captureRequest();
  renderChat(settings, prompt);
  await waitFor(() => expect(sent()).toBeDefined());
  return sent()!;
}

const toolNames = (request: ProviderRequest) => request.toolDefinitions.map((tool) => tool.name);
const count = (names: string[], name: string) => names.filter((n) => n === name).length;

describe('ChatView web_fetch without the search toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConversationMessages).mockResolvedValue([]);
    vi.mocked(getMessageIdByRequest).mockResolvedValue(null);
  });

  it('a normal turn with web access on gets web_fetch but not web_search, and the fetch prompt', async () => {
    const request = await sendTurn({}, HN_PROMPT);
    const names = toolNames(request);
    expect(count(names, 'web_fetch')).toBe(1);
    expect(names).not.toContain('web_search');
    expect(request.webSearch).toBeUndefined();
    expect(request.developerPrompt).toContain(FETCH_PROMPT_LINE);
    expect(request.developerPrompt).toContain('up to 12 per turn');
    // "make me an artifact" is a creation turn: read first, then write once.
    expect(request.developerPrompt).toContain('write the document once');
  });

  it('local-only declares no web tools and no fetch prompt', async () => {
    const request = await sendTurn({ localOnly: true }, HN_PROMPT);
    expect(toolNames(request)).not.toContain('web_fetch');
    expect(toolNames(request)).not.toContain('web_search');
    expect(request.developerPrompt ?? '').not.toContain(FETCH_PROMPT_LINE);
  });

  it('web access off in Settings declares no web tools', async () => {
    const request = await sendTurn({ webSearchEnabled: false }, HN_PROMPT);
    expect(toolNames(request)).not.toContain('web_fetch');
    expect(toolNames(request)).not.toContain('web_search');
    expect(request.developerPrompt ?? '').not.toContain(FETCH_PROMPT_LINE);
  });

  it('the search toggle on a local backend adds web_search; each tool is declared once', async () => {
    const sent = captureRequest();
    renderChat({}, null);
    fireEvent.click(await screen.findByRole('button', { name: 'Web' }));
    const composer = screen.getByRole('textbox', { name: /message/i });
    fireEvent.change(composer, { target: { value: 'what is new in rust 2026' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(sent()).toBeDefined());
    const names = toolNames(sent()!);
    expect(count(names, 'web_search')).toBe(1);
    expect(count(names, 'web_fetch')).toBe(1);
    expect(sent()!.webSearch).toBeUndefined();
    // The search prompt covers fetching; the fetch-only line is not added.
    expect(sent()!.developerPrompt).toContain("local web_search tool");
    expect(sent()!.developerPrompt).not.toContain(FETCH_PROMPT_LINE);
  });

  it('a hosted search turn declares web_fetch once and uses the hosted prompt', async () => {
    const request = await sendTurn(
      { webSearch: { ...baseSettings.webSearch, mode: 'hosted' } },
      'search the web for the latest rust news',
    );
    const names = toolNames(request);
    expect(count(names, 'web_fetch')).toBe(1);
    expect(names).not.toContain('web_search');
    expect(request.webSearch?.enabled).toBe(true);
    expect(request.developerPrompt).not.toContain(FETCH_PROMPT_LINE);
  });
});
