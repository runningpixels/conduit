/**
 * Writing in the shell: the rail and Ctrl+5 reach the Writing page, a draft
 * opens in its studio with the one chat as the dock, and approving the
 * outline asks the assistant to write the draft, whose tool calls fill the
 * editor live and leave a version in History. Every IPC call is a stub.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, ProviderEvent, ProviderRequest } from '@conduit/config-schema';
import type { DraftDetail, DraftSummary } from './ipc/contracts';

const settings: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'dark',
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
  agent: { maxSteps: 25, wallClockBudgetSecs: 300 },
  keychainMode: 'os',
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

/**
 * Every IPC call resolves to something harmless. Named entries are the ones
 * whose *shape* the boot path reads; the Proxy default covers the rest, so this
 * file does not have to be revisited every time a command is added.
 */
const SHAPES: Record<string, unknown> = {
  getSettings: settings,
  updateSettings: settings,
  getOnboardingState: {
    onboardingCompleted: true,
    hasProviderCredential: true,
    migrationRecovery: null,
  },
  getAppPaths: { artifacts: 'C:/ws/artifacts', data: 'C:/ws', logs: 'C:/ws/logs' },
  listConversations: [],
  listConversationFolders: [],
  listProviderDescriptors: [],
  listProviderModels: [],
  listConnectorGrants: [],
  listConnectorCapabilities: [],
  getConnectorRuntimeStates: [],
  getConversationMessages: [],
  getConversationCompaction: null,
  compactConversation: null,
  searchMessages: [],
  createConversation: { id: 'c1', title: 'New chat', updatedAt: new Date().toISOString() },
  listSkills: [],
  listConversationSkills: [],
  getSkillPromptBlock: '',
  getMemoryPromptBlock: '',
  listMemoryItems: [],
  loadProviderCredentialReference: { providerId: 'anthropic', credentialRef: '', storedInKeychain: false },
  checkArtifactFileState: {},
  // Ideas: collections decide whether "Ask your documents" is ready.
  listKnowledgeCollections: [],
  // Home reads these when it opens; an empty answer is the empty state.
  listDecks: [],
  listDrafts: [],
  listWorkflows: [],
  listWorkflowReviews: [],
  listWorkflowQuestions: [],
  listPrompts: [],
  listApps: [],
  listStarterApps: [],
};

const markdown = '## Why\n\nForty repositories.';

const outlineDraft: DraftDetail = {
  id: 'd1',
  title: 'One repo',
  conversationId: 'c-draft',
  stage: 'outline',
  brief: 'A post for backend developers.',
  outline: [{ heading: 'Why', intent: 'The pain', targetWords: 300 }],
  markdown: '',
  blocks: [],
  words: 0,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

const writtenDraft: DraftDetail = {
  ...outlineDraft,
  stage: 'draft',
  markdown,
  blocks: [
    { id: 'b1', kind: 'heading', owner: 'ai', pinned: false, start: 0, end: 6 },
    { id: 'b2', kind: 'paragraph', owner: 'ai', pinned: false, start: 8, end: markdown.length },
  ],
  words: 3,
};

const summary: DraftSummary = { id: 'd1', title: 'One repo', stage: 'outline', words: 0, updatedAt: '2026-10-01T00:00:00Z' };

/** The smoke test's list of stubbed IPC exports (App.smoke.test.tsx). */
const IPC_EXPORTS = [
  'getAppPaths', 'getSettings', 'updateSettings', 'saveProviderCredential',
  'setTrayLabels', 'getStartAtLogin', 'setStartAtLogin', 'getRunningWorkflowCount', 'stopWorkflowRun',
  'getWorkflowPermissions', 'approveWorkflowPermissions', 'listWorkflowReviews', 'answerWorkflowReview',
  'listWorkflowQuestions', 'answerWorkflowQuestion', 'rerunWorkflowFrom',
  'loadProviderCredentialReference', 'validateProviderCredentials',
  'listProviderDescriptors', 'listProviderModels', 'startChatStream',
  'cancelChatStream', 'steerChatStream', 'submitAskUser', 'getConversationMessages', 'getConversationCompaction', 'compactConversation', 'getRequestProviderEvents',
  'startResearch', 'approveResearchBrief', 'stopResearch', 'cancelResearch', 'getResearchRun',
  'createConversation', 'listConversations', 'getConversation',
  'deleteConversation', 'setConversationTitle', 'setConversationPinned',
  'setConversationArchived', 'setConversationFolder', 'listConversationFolders',
  'createConversationFolder', 'renameConversationFolder', 'deleteConversationFolder',
  'deleteAllConversations',
  'exportDiagnostics', 'getDiagnosticsDisclosureAcknowledged',
  'acknowledgeDiagnosticsDisclosure', 'revealPath', 'revealArtifactsDir',
  'revealArtifact', 'checkForUpdate', 'downloadAndInstallUpdate',
  'getOnboardingState', 'startMockStream', 'cancelMockStream',
  'listConnectorDefinitions', 'listConnectorVersions', 'listConnectorGrants',
  'listConnectorCapabilities', 'getConnectorRuntimeStates', 'startConnector',
  'stopConnector', 'discoverConnector', 'invokeConnectorTool',
  'approveConnectorToolCall', 'denyConnectorToolCall', 'listToolApprovalMemory', 'revokeToolApprovalMemory', 'revokeConnectorGrant',
  'addLocalConnector', 'addRemoteConnector', 'searchMcpRegistry', 'signinRemoteConnector', 'createArtifact', 'listArtifacts', 'getMessageIdByRequest',
  'searchMessages', 'getUsageSummary', 'removeLastTurn', 'forkConversation',
  'prepareMessageEdit',
  'createPrompt', 'listPrompts', 'getPrompt', 'updatePrompt', 'deletePrompt',
  'listPromptFolders', 'getArtifact', 'setArtifactContent', 'setArtifactTitle',
  'getArtifactContentBytes', 'readArtifactFileBytes', 'checkArtifactFileState',
  'exportArtifact', 'saveAttachment', 'listAttachments', 'deleteAttachment',
  'getAttachmentBytes', 'resetLocalDatabase',
  'listSkills', 'getSkillPromptBlock', 'listConversationSkills', 'setConversationSkills',
  'importSkillFolder', 'importSkillZip', 'exportSkillFolder', 'exportSkillZip',
  'deleteManagedSkill', 'revealSkillsDir',
  'listMemoryItems', 'createMemoryItem', 'updateMemoryItem', 'deleteMemoryItem',
  'acceptMemoryItem', 'getMemoryPromptBlock',
  'previewConversationExport', 'exportConversationDialog', 'exportDeckHtml', 'exportDeckPdf',
  // White-label Phase 3 (Settings → Branding): App.tsx's boot effect already
  // calls getBrandConfig/getBrandLogo unconditionally, same as every other
  // Promise.all entry there — missing from this enumeration, either of them
  // is `undefined`, and calling it throws before `setPaths`/`setSettings`
  // ever run, which hangs the whole boot effect in its catch-less gap and
  // times out this smoke test with no other symptom.
  'getBrandConfig', 'getBrandLogo', 'saveBrandLogo', 'clearBrandLogo',
  'getBrandWarnings', 'clearBrandConfig', 'importBrandFile', 'applyBrandEdits',
  'exportBrandConfig',
  // Ideas (App.tsx reads the collection count for "Ask your documents").
  'listKnowledgeCollections',
  // Home: its lists and the apps App.tsx keeps for it.
  'listWorkflows', 'listApps', 'listStarterApps',
  // Slides: App.tsx asks whether the open chat is bound to a deck.
  'getDeckForConversation', 'listDecks', 'openDeck', 'undoStartDeck', 'listDeckSnapshots', 'listSlideThemes',
  'editSlideWords', 'setSlotPinned', 'replaceInDeck', 'insertBullet', 'removeBullet',
  // Writing: App.tsx asks whether the open chat is bound to a draft; Home lists drafts.
  'listDrafts', 'createDraft', 'getDraft', 'renameDraft', 'deleteDraft', 'saveDraftMarkdown',
  'setDraftOutline', 'setDraftStage', 'setBlockPinned', 'listDraftSnapshots', 'snapshotDraft',
  'restoreDraftSnapshot', 'exportDraft', 'draftForConversation',
] as const;

vi.mock('./ipc/client', () => {
  const mod: Record<string, unknown> = {};
  for (const name of IPC_EXPORTS) {
    mod[name] = vi.fn(async () => SHAPES[name] ?? null);
  }
  return mod;
});

beforeAll(() => {
  const proto = Range.prototype as unknown as Record<string, unknown>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }) as DOMRect;
});

async function boot() {
  const { default: App } = await import('./App');
  render(<App />);
  await waitFor(() => expect(screen.getByPlaceholderText('Message Conduit…')).toBeInTheDocument());
}

describe('Writing in the shell', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    const ipc = await import('./ipc/client');
    vi.mocked(ipc.listDrafts).mockResolvedValue([summary]);
    vi.mocked(ipc.getDraft).mockResolvedValue(outlineDraft);
    vi.mocked(ipc.draftForConversation).mockImplementation(async (id: string) => (id === 'c-draft' ? outlineDraft : null));
    vi.mocked(ipc.setDraftStage).mockResolvedValue({ ...outlineDraft, stage: 'draft' });
    vi.mocked(ipc.snapshotDraft).mockResolvedValue(null);
    vi.mocked(ipc.listDraftSnapshots).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('Ctrl+5 opens Writing; opening a draft shows its studio with the chat as the dock', async () => {
    await boot();
    fireEvent.keyDown(window, { key: '5', ctrlKey: true });
    expect(await screen.findByRole('heading', { name: 'Writing' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Writing' })).toHaveAttribute('aria-current', 'page');
    fireEvent.click(await screen.findByRole('button', { name: 'Open One repo' }));
    // The studio: outline stage in the main view, the chat as the dock's Ask tab.
    expect(await screen.findByRole('button', { name: 'Approve outline' })).toBeInTheDocument();
    expect(document.querySelector('.body[data-studio]')).not.toBeNull();
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Ask', 'History']);
    expect(document.querySelector('.center[data-dock-tab="ask"]')).not.toBeNull();
    // Back goes to the list, the chat stays the draft's.
    fireEvent.click(screen.getByRole('button', { name: /All drafts/ }));
    expect(await screen.findByRole('button', { name: 'Open One repo' })).toBeInTheDocument();
  });

  it('Approve outline moves to the draft stage and asks the assistant to write it; the editor fills in and a version is saved', async () => {
    const ipc = await import('./ipc/client');
    let request: ProviderRequest | undefined;
    let emit: ((event: ProviderEvent) => void) | undefined;
    vi.mocked(ipc.startChatStream).mockImplementation(async (req, onEvent) => {
      request = req;
      emit = onEvent;
      return { requestId: req.requestId };
    });
    await boot();
    fireEvent.click(screen.getByRole('button', { name: 'Writing' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open One repo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Approve outline' }));

    await waitFor(() => expect(ipc.setDraftStage).toHaveBeenCalledWith('d1', 'draft'));
    await waitFor(() => expect(request).toBeDefined());
    const sent = request!;
    expect(sent.conversationId).toBe('c-draft');
    const text = sent.messages.at(-1)?.parts.map((part) => part.content ?? '').join('') ?? '';
    expect(text).toContain('Write the draft from the approved outline.');
    expect(sent.systemPrompt).toContain('long-form piece of non-fiction');
    expect(sent.developerPrompt).toContain('stage: draft');

    // The assistant writes a section: the studio re-reads the draft at once.
    vi.mocked(ipc.getDraft).mockResolvedValue(writtenDraft);
    const requestId = sent.requestId;
    const send = (event: object) => act(() => emit!({ requestId, ...event } as ProviderEvent));
    send({ kind: 'messageStart', index: 0 });
    send({ kind: 'toolCallStart', toolCallId: 't1', index: 1, toolId: 'write_section', name: 'write_section' });
    send({ kind: 'toolExecutionFinished', toolCallId: 't1', toolName: 'write_section', isError: false });
    await waitFor(() => expect(document.querySelector('.cm-content')?.textContent).toContain('Forty repositories.'));
    // Read-only while the turn runs.
    expect(screen.getByText('The assistant is editing…')).toBeInTheDocument();

    send({ kind: 'messageComplete', index: 2, finishReason: 'stop' });
    await waitFor(() =>
      expect(ipc.snapshotDraft).toHaveBeenCalledWith('d1', 'ai-turn', 'Wrote the draft from the outline'),
    );
    await waitFor(() => expect(screen.queryByText('The assistant is editing…')).toBeNull());
  });
});
