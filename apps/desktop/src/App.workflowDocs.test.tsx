/**
 * A workflow changing the open draft: the shell reloads it when nobody is
 * editing, and otherwise leaves it alone with an "Updated by … — Reload" note.
 * Every IPC call is a stub; the Tauri event is delivered by hand.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { EditorView } from '@codemirror/view';
import type { AppSettings } from '@conduit/config-schema';
import type { DraftDetail, DraftSummary } from './ipc/contracts';
import type { WorkflowDeckChanged, WorkflowDraftChanged } from './workflows/documentUpdates';

const events = vi.hoisted(() => ({
  deck: null as null | ((e: WorkflowDeckChanged) => void),
  draft: null as null | ((e: WorkflowDraftChanged) => void),
}));
vi.mock('./workflows/documentUpdates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./workflows/documentUpdates')>()),
  useWorkflowDocumentEvents: (
    onDeck: (e: WorkflowDeckChanged) => void,
    onDraft: (e: WorkflowDraftChanged) => void,
  ) => {
    events.deck = onDeck;
    events.draft = onDraft;
  },
}));

const settings: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'dark',
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
  // The draft's Sources tab.
  listConversationCollections: [],
  listResearchReports: [],
  getDraftResearchMaterial: [],
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
  sources: { webSearch: false, researchRunIds: [] },
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

const summary: DraftSummary = { id: 'd1', title: 'One repo', stage: 'draft', words: 3, updatedAt: '2026-10-01T00:00:00Z' };

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
  'setDraftSources', 'listResearchReports', 'getDraftResearchMaterial',
  'listConversationCollections', 'setConversationCollections',
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

const changedDraft: DraftDetail = {
  ...writtenDraft,
  markdown: `${markdown}

## This week

Shipped the update.`,
  words: 7,
  updatedAt: '2026-10-07T08:00:00Z',
};

async function openWrittenDraft() {
  const ipc = await import('./ipc/client');
  vi.mocked(ipc.getDraft).mockResolvedValue(writtenDraft);
  vi.mocked(ipc.draftForConversation).mockImplementation(async (id: string) => (id === 'c-draft' ? writtenDraft : null));
  const { default: App } = await import('./App');
  render(<App />);
  await waitFor(() => expect(screen.getByPlaceholderText('Message Conduit…')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Writing' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open One repo' }));
  await waitFor(() => expect(document.querySelector('.cm-content')?.textContent).toContain('Forty repositories.'));
  return ipc;
}

const fire = (draftId: string) =>
  act(() => events.draft?.({ draftId, workflowName: 'Monthly report', runId: 'r1' }));

describe('a workflow changes the open draft', { timeout: 30_000 }, () => {
  beforeEach(async () => {
    const ipc = await import('./ipc/client');
    vi.mocked(ipc.listDrafts).mockResolvedValue([summary]);
    vi.mocked(ipc.snapshotDraft).mockResolvedValue(null);
    vi.mocked(ipc.listDraftSnapshots).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('reloads the draft and the Writing list when nobody is editing', async () => {
    const ipc = await openWrittenDraft();
    vi.mocked(ipc.getDraft).mockClear();
    vi.mocked(ipc.getDraft).mockResolvedValue(changedDraft);
    fire('d1');
    await waitFor(() => expect(ipc.getDraft).toHaveBeenCalledWith('d1'));
    await waitFor(() => expect(document.querySelector('.cm-content')?.textContent).toContain('Shipped the update.'));
    expect(screen.queryByText(/Updated by/)).toBeNull();
  });

  it('leaves a draft that is not open alone', async () => {
    const ipc = await openWrittenDraft();
    vi.mocked(ipc.getDraft).mockClear();
    fire('another-draft');
    await Promise.resolve();
    expect(ipc.getDraft).not.toHaveBeenCalled();
    expect(screen.queryByText(/Updated by/)).toBeNull();
  });

  it('keeps what is being typed, says who updated the draft, and reloads on request', async () => {
    const ipc = await openWrittenDraft();
    const typed = `${markdown} Mine.`;
    vi.mocked(ipc.saveDraftMarkdown).mockResolvedValue({ ...writtenDraft, markdown: typed });
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
    act(() => {
      view.dispatch({ changes: { from: view.state.doc.length, insert: ' Mine.' } });
    });
    await waitFor(() => expect(ipc.saveDraftMarkdown).toHaveBeenCalledWith('d1', typed), { timeout: 5000 });

    vi.mocked(ipc.getDraft).mockClear();
    vi.mocked(ipc.getDraft).mockResolvedValue(changedDraft);
    fire('d1');
    // The note sits where the person is writing (a strip over the editor), and in the chat.
    expect((await screen.findAllByText('Updated by Monthly report')).length).toBeGreaterThanOrEqual(1);
    const banner = document.querySelector('.draft-panel .workflow-update-banner') as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner).toHaveTextContent('Updated by Monthly report');
    expect(ipc.getDraft).not.toHaveBeenCalled();
    expect(document.querySelector('.cm-content')?.textContent).not.toContain('Shipped the update.');

    fireEvent.click(within(banner).getByRole('button', { name: 'Reload' }));
    // What was typed is kept as a version before the draft is replaced.
    await waitFor(() => expect(ipc.snapshotDraft).toHaveBeenCalledWith('d1', 'manual', expect.any(String)));
    await waitFor(() => expect(ipc.getDraft).toHaveBeenCalledWith('d1'));
    await waitFor(() => expect(document.querySelector('.cm-content')?.textContent).toContain('Shipped the update.'));
    expect(screen.queryByText('Updated by Monthly report')).toBeNull();
    expect(document.querySelector('.workflow-update-banner')).toBeNull();
  });
});
