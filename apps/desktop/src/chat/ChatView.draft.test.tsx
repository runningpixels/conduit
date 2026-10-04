import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AppSettings, ProviderEvent, ProviderRequest } from '@conduit/config-schema';
import type { DraftDetail } from '../ipc/contracts';
import { ChatView } from './ChatView';

/// A chat bound to a Writing draft: its turns carry the draft prompts and
/// tools instead of the document ones, and draft tool events reach the studio
/// so the editor fills in while the turn runs.

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
  getDraftResearchMaterial,
  getMessageIdByRequest,
  listConversationCollections,
  startChatStream,
} from '../ipc/client';

const markdown = '## Why\n\nForty repositories.';
const draft: DraftDetail = {
  id: 'd1',
  title: 'One repo',
  conversationId: 'conv-1',
  stage: 'draft',
  brief: 'A post for backend developers.',
  outline: [{ heading: 'Why', intent: 'The pain', targetWords: 300 }],
  markdown,
  blocks: [
    { id: 'b1', kind: 'heading', owner: 'ai', pinned: false, start: 0, end: 6 },
    { id: 'b2', kind: 'paragraph', owner: 'user', pinned: true, start: 8, end: markdown.length },
  ],
  words: 3,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  sources: { webSearch: false, researchRunIds: [] },
};

describe('ChatView bound to a draft', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConversationMessages).mockResolvedValue([]);
    vi.mocked(getMessageIdByRequest).mockResolvedValue(null);
  });

  it('sends draft prompts and tools, and reports draft tool activity', async () => {
    let request: ProviderRequest | undefined;
    let emit: ((event: ProviderEvent) => void) | undefined;
    vi.mocked(startChatStream).mockImplementation(async (req, onEvent) => {
      request = req;
      emit = onEvent;
      return { requestId: req.requestId };
    });
    const onDraftChanged = vi.fn();
    const onDraftToolActivity = vi.fn();
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
        draft={draft}
        onDraftChanged={onDraftChanged}
        onDraftToolActivity={onDraftToolActivity}
        compact
        pendingSendText="Write a blog post about building a monorepo, with a code example."
        onPendingSendConsumed={vi.fn()}
      />,
    );
    await waitFor(() => expect(request).toBeDefined());
    const sent = request!;
    expect(sent.systemPrompt).toContain('long-form piece of non-fiction');
    expect(sent.systemPrompt).not.toContain('write_html_document');
    expect(sent.developerPrompt).toContain('Draft "One repo" · stage: draft');
    expect(sent.developerPrompt).toContain('b2 · user · pinned · Forty repositories.');
    const names = sent.toolDefinitions.map((tool) => tool.name);
    expect(names).not.toContain('write_html_document');
    expect(names).not.toContain('start_deck');

    const requestId = sent.requestId;
    const send = (event: object) => act(() => emit!({ requestId, ...event } as ProviderEvent));
    send({ kind: 'messageStart', index: 0 });
    send({ kind: 'toolCallStart', toolCallId: 't1', index: 1, toolId: 'read_draft', name: 'read_draft' });
    expect(onDraftToolActivity).toHaveBeenLastCalledWith('read_draft');
    send({ kind: 'toolExecutionFinished', toolCallId: 't1', toolName: 'read_draft', isError: false });
    // Reading changes nothing.
    expect(onDraftChanged).not.toHaveBeenCalled();
    expect(onDraftToolActivity).toHaveBeenLastCalledWith(null);

    send({ kind: 'toolCallStart', toolCallId: 't2', index: 2, toolId: 'write_section', name: 'write_section' });
    expect(onDraftToolActivity).toHaveBeenLastCalledWith('write_section');
    send({ kind: 'toolExecutionFinished', toolCallId: 't2', toolName: 'write_section', isError: false });
    expect(onDraftChanged).toHaveBeenCalledTimes(1);

    send({ kind: 'toolCallStart', toolCallId: 't3', index: 3, toolId: 'edit_blocks', name: 'edit_blocks' });
    send({ kind: 'toolExecutionFinished', toolCallId: 't3', toolName: 'edit_blocks', isError: true });
    // A refused edit (a pinned block) changed nothing either.
    expect(onDraftChanged).toHaveBeenCalledTimes(1);
    expect(onDraftToolActivity).toHaveBeenLastCalledWith(null);

    send({ kind: 'messageComplete', index: 4, finishReason: 'stop' });
    await waitFor(() => expect(onChatTurnComplete).toHaveBeenCalled());
  });

  function renderDraftChat(over: {
    draft?: DraftDetail;
    settings?: Partial<AppSettings>;
    onDraftPreview?: (previews: unknown[]) => void;
    onOpenDraftSources?: () => void;
    pendingSendText?: string | null;
  }) {
    return render(
      <ChatView
        settings={{ ...baseSettings, ...over.settings }}
        onSelectModel={vi.fn()}
        onStatus={vi.fn()}
        conversationId="conv-1"
        artifacts={[]}
        fileStateMap={{}}
        onPromoteArtifact={vi.fn()}
        onOpenArtifact={vi.fn()}
        onChatTurnComplete={vi.fn()}
        draft={over.draft ?? draft}
        onDraftChanged={vi.fn()}
        onDraftToolActivity={vi.fn()}
        onDraftPreview={over.onDraftPreview}
        onOpenDraftSources={over.onOpenDraftSources}
        compact
        pendingSendText={over.pendingSendText ?? null}
        onPendingSendConsumed={vi.fn()}
      />,
    );
  }

  const webReady: Partial<AppSettings> = {
    localOnly: false,
    webSearchEnabled: true,
    webSearchConsentAcknowledged: true,
  };

  it('sets parallelToolCalls false on draft-stage turns only', async () => {
    let request: ProviderRequest | undefined;
    vi.mocked(startChatStream).mockImplementation(async (req) => {
      request = req;
      return { requestId: req.requestId };
    });
    const { unmount } = renderDraftChat({ pendingSendText: 'Write the next section.' });
    await waitFor(() => expect(request).toBeDefined());
    expect(request!.generationControls?.parallelToolCalls).toBe(false);
    unmount();

    request = undefined;
    renderDraftChat({ draft: { ...draft, stage: 'outline' }, pendingSendText: 'Propose an outline.' });
    await waitFor(() => expect(request).toBeDefined());
    expect(request!.generationControls?.parallelToolCalls).toBeUndefined();
  });

  it('a draft with web search on offers the local web tools and the citation rule, never hosted search', async () => {
    let request: ProviderRequest | undefined;
    vi.mocked(startChatStream).mockImplementation(async (req) => {
      request = req;
      return { requestId: req.requestId };
    });
    renderDraftChat({
      draft: { ...draft, sources: { webSearch: true, researchRunIds: [] } },
      settings: webReady,
      pendingSendText: 'Write the next section.',
    });
    await waitFor(() => expect(request).toBeDefined());
    const names = request!.toolDefinitions.map((tool) => tool.name);
    expect(names).toContain('web_search');
    expect(names).toContain('web_fetch');
    expect(names.filter((name) => name === 'web_search')).toHaveLength(1);
    expect(request!.webSearch).toBeUndefined();
    expect(request!.systemPrompt).toContain('Look things up with web_search/web_fetch');
    // The chat's "lead with a direct answer" search prompt would fight the draft.
    expect(request!.developerPrompt ?? '').not.toContain('lead with a direct answer');
    // No reports attached: no research material is read.
    expect(getDraftResearchMaterial).not.toHaveBeenCalled();
  });

  it('web search the settings do not allow stays off for the draft', async () => {
    let request: ProviderRequest | undefined;
    vi.mocked(startChatStream).mockImplementation(async (req) => {
      request = req;
      return { requestId: req.requestId };
    });
    renderDraftChat({
      draft: { ...draft, sources: { webSearch: true, researchRunIds: [] } },
      pendingSendText: 'Write the next section.',
    });
    await waitFor(() => expect(request).toBeDefined());
    expect(request!.toolDefinitions.map((tool) => tool.name)).not.toContain('web_search');
    expect(request!.systemPrompt).not.toContain('web_search/web_fetch');
  });

  it('documents attached to the draft chat add the document rule; reports add verified facts', async () => {
    vi.mocked(listConversationCollections).mockResolvedValue(['k1']);
    vi.mocked(getDraftResearchMaterial).mockResolvedValue([
      {
        runId: 'run-1',
        question: 'Build speed',
        truncated: false,
        claims: [{ id: 'R1.1', claim: 'Builds got 40% faster.', sourceTitle: 'Build report', url: 'https://example.com/a' }],
      },
    ]);
    let request: ProviderRequest | undefined;
    vi.mocked(startChatStream).mockImplementation(async (req) => {
      request = req;
      return { requestId: req.requestId };
    });
    const onOpenDraftSources = vi.fn();
    renderDraftChat({
      draft: { ...draft, sources: { webSearch: true, researchRunIds: ['run-1'] } },
      settings: webReady,
      onOpenDraftSources,
    });
    // The composer shows the draft's sources as chips that open the Sources tab.
    const chips = await screen.findByRole('group', { name: 'Active in this chat' });
    await waitFor(() => expect(within(chips).getByText('1 document collection')).toBeInTheDocument());
    expect(within(chips).getByText('Web search')).toBeInTheDocument();
    expect(within(chips).getByText('1 report')).toBeInTheDocument();
    fireEvent.click(within(chips).getByText('1 report'));
    expect(onOpenDraftSources).toHaveBeenCalled();
    // The "+" menu leaves out web search and Research: the Sources tab owns them.
    fireEvent.click(screen.getByRole('button', { name: 'Add to this message' }));
    expect(screen.queryByRole('menuitemcheckbox', { name: /Web search/ })).toBeNull();
    expect(screen.queryByRole('menuitemcheckbox', { name: /Research/ })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    const composer = screen.getByRole('textbox', { name: /message/i });
    fireEvent.change(composer, { target: { value: 'Write the next section.' } });
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(request).toBeDefined());
    expect(getDraftResearchMaterial).toHaveBeenCalledWith('d1');
    expect(request!.systemPrompt).toContain('name the document in parentheses');
    expect(request!.developerPrompt).toContain('Verified facts from research reports');
    expect(request!.developerPrompt).toContain('R1.1 · Builds got 40% faster. · Build report · https://example.com/a');
  });

  it('hands the studio a preview of each streaming write_section call, and clears it when the call runs', async () => {
    let request: ProviderRequest | undefined;
    let emit: ((event: ProviderEvent) => void) | undefined;
    vi.mocked(startChatStream).mockImplementation(async (req, onEvent) => {
      request = req;
      emit = onEvent;
      return { requestId: req.requestId };
    });
    const onDraftPreview = vi.fn();
    renderDraftChat({ onDraftPreview, pendingSendText: 'Write the next section.' });
    await waitFor(() => expect(request).toBeDefined());
    const requestId = request!.requestId;
    const send = (event: object) => act(() => emit!({ requestId, ...event } as ProviderEvent));
    send({ kind: 'messageStart', index: 0 });
    send({ kind: 'toolCallStart', toolCallId: 't1', index: 1, toolId: 'write_section', name: 'write_section' });
    send({ kind: 'toolCallDelta', toolCallId: 't1', index: 1, content: '{"heading":"How","markdown":"One build' });
    await waitFor(() =>
      expect(onDraftPreview).toHaveBeenLastCalledWith([{ toolCallId: 't1', heading: 'How', markdown: 'One build' }]),
    );
    send({ kind: 'toolCallDelta', toolCallId: 't1', index: 1, content: ' for all."}' });
    await waitFor(() =>
      expect(onDraftPreview).toHaveBeenLastCalledWith([{ toolCallId: 't1', heading: 'How', markdown: 'One build for all.' }]),
    );
    send({ kind: 'toolExecutionFinished', toolCallId: 't1', toolName: 'write_section', isError: false });
    expect(onDraftPreview).toHaveBeenLastCalledWith([]);
    send({ kind: 'messageComplete', index: 2, finishReason: 'stop' });
  });
});
