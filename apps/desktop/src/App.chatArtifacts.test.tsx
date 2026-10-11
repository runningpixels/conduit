/**
 * Opening a chat restores the artifact last open in it, per chat and across
 * restarts, without showing a hidden panel; a chat with nothing remembered
 * lists its artifacts instead of the generic empty state. Every IPC call is a
 * stub.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, ConversationSummary } from '@conduit/config-schema';
import type { Artifact } from './ipc/contracts';
import { readLastArtifact, writeLastArtifact } from './shell/uiPrefs';
import { __writeStoredDocPanelForTest } from './workspace/useLayout';

const conversations: ConversationSummary[] = [
  { id: 'cA', displayTitle: 'Chat A', updatedAt: '2026-10-09T00:00:00Z', messageCount: 2 },
  { id: 'cB', displayTitle: 'Chat B', updatedAt: '2026-10-08T00:00:00Z', messageCount: 2 },
] as ConversationSummary[];

function page(id: string, conversationId: string, title: string, createdAt: string): Artifact {
  return {
    id,
    conversationId,
    kind: 'markdown',
    title,
    mimeType: 'text/markdown',
    contentText: `Body of ${title}`,
    createdAt,
  };
}

const a1 = page('a1', 'cA', 'Alpha one', '2026-10-01T00:00:00Z');
const a2 = page('a2', 'cA', 'Alpha two', '2026-10-02T00:00:00Z');
const b1 = page('b1', 'cB', 'Beta one', '2026-10-03T00:00:00Z');
const byConversation: Record<string, Artifact[]> = { cA: [a1, a2], cB: [b1] };

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
 * whose *shape* the boot path reads.
 */
const SHAPES: Record<string, unknown> = {
  getSettings: settings,
  updateSettings: settings,
  getOnboardingState: {
    onboardingCompleted: true,
    examplesSeeded: false,
    hasProviderCredential: true,
    migrationRecovery: null,
  },
  getAppPaths: { artifacts: 'C:/ws/artifacts', data: 'C:/ws', logs: 'C:/ws/logs' },
  listConversations: conversations,
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
  listKnowledgeCollections: [],
  listDecks: [],
  listDrafts: [],
  listConversationCollections: [],
  listResearchReports: [],
  getDraftResearchMaterial: [],
  listWorkflows: [],
  listWorkflowReviews: [],
  listWorkflowQuestions: [],
  listPrompts: [],
  listApps: [],
  listStarterApps: [],
  listArtifacts: [],
};

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
  'getBrandConfig', 'getBrandLogo', 'saveBrandLogo', 'clearBrandLogo',
  'getBrandWarnings', 'clearBrandConfig', 'importBrandFile', 'applyBrandEdits',
  'exportBrandConfig',
  'listKnowledgeCollections',
  'listWorkflows', 'listApps', 'listStarterApps',
  'getDeckForConversation', 'listDecks', 'openDeck', 'undoStartDeck', 'listDeckSnapshots', 'listSlideThemes',
  'editSlideWords', 'setSlotPinned', 'replaceInDeck', 'insertBullet', 'removeBullet',
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
  // Synchronous: the open document panel names its page with it.
  mod.artifactPrincipal = (id: string) => `artifact:${id}`;
  return mod;
});

beforeAll(() => {
  const proto = Range.prototype as unknown as Record<string, unknown>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }) as DOMRect;
});

async function boot() {
  const ipc = await import('./ipc/client');
  vi.mocked(ipc.listConversations).mockResolvedValue(conversations);
  vi.mocked(ipc.listArtifacts).mockImplementation(async (id: string) => byConversation[id] ?? []);
  vi.mocked(ipc.getArtifact).mockImplementation(
    async (id: string) => [a1, a2, b1].find((artifact) => artifact.id === id) ?? null,
  );
  const { default: App } = await import('./App');
  render(<App />);
  await screen.findByPlaceholderText('Message… or type / for tools');
  return ipc;
}

function selectChat(title: string) {
  const row = document.querySelector<HTMLButtonElement>(`.convo[title="${title}"]`);
  expect(row).not.toBeNull();
  fireEvent.click(row!);
}

/** The open artifact's title in the panel header, if one is open. */
const openTitle = () => document.querySelector('.doc-panel .doc-title-row b')?.textContent ?? null;
const listShown = () => screen.queryByRole('list', { name: 'Artifacts in this chat' }) != null;

describe('the panel remembers the artifact open in each chat', { timeout: 30_000 }, () => {
  beforeEach(() => {
    localStorage.clear();
    __writeStoredDocPanelForTest('open');
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('restores per chat across switches (A → B → A → B)', async () => {
    // Remembered from an earlier session.
    writeLastArtifact('cA', 'a2');
    await boot();
    await waitFor(() => expect(openTitle()).toBe('Alpha two'));

    // Nothing remembered for B: its list, not the generic empty state.
    selectChat('Chat B');
    await waitFor(() => expect(listShown()).toBe(true));
    expect(screen.getByText('1 artifact')).toBeInTheDocument();
    expect(screen.queryByText('Artifacts live here')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Beta one' }));
    await waitFor(() => expect(openTitle()).toBe('Beta one'));
    expect(readLastArtifact('cB')).toBe('b1');

    selectChat('Chat A');
    await waitFor(() => expect(openTitle()).toBe('Alpha two'));
    selectChat('Chat B');
    await waitFor(() => expect(openTitle()).toBe('Beta one'));
  });

  it('closing the artifact returns to the list and forgets it', async () => {
    writeLastArtifact('cA', 'a2');
    await boot();
    await waitFor(() => expect(openTitle()).toBe('Alpha two'));
    fireEvent.click(screen.getByRole('button', { name: 'Close Alpha two' }));
    await waitFor(() => expect(listShown()).toBe(true));
    expect(screen.getByText('2 artifacts')).toBeInTheDocument();
    expect(readLastArtifact('cA')).toBeUndefined();
  });

  it('switches from the header and returns to the list from it', async () => {
    writeLastArtifact('cA', 'a2');
    await boot();
    await waitFor(() => expect(openTitle()).toBe('Alpha two'));
    fireEvent.click(screen.getByRole('button', { name: /Alpha two/, expanded: false }));
    fireEvent.click(screen.getByRole('option', { name: /Alpha one/ }));
    await waitFor(() => expect(openTitle()).toBe('Alpha one'));
    expect(readLastArtifact('cA')).toBe('a1');
    // In place: one artifact open, no tab strip.
    expect(document.querySelector('.artifact-tabs')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Alpha one/, expanded: false }));
    fireEvent.click(screen.getByRole('option', { name: 'All artifacts in this chat' }));
    await waitFor(() => expect(listShown()).toBe(true));
    expect(readLastArtifact('cA')).toBeUndefined();
  });

  it('forgets an artifact that no longer exists and shows the list', async () => {
    writeLastArtifact('cA', 'gone');
    const ipc = await boot();
    await waitFor(() => expect(listShown()).toBe(true));
    expect(ipc.getArtifact).not.toHaveBeenCalledWith('gone');
    expect(readLastArtifact('cA')).toBeUndefined();
  });

  it('restores into a hidden panel without showing it', async () => {
    __writeStoredDocPanelForTest('closed');
    writeLastArtifact('cA', 'a2');
    const ipc = await boot();
    await waitFor(() => expect(ipc.getArtifact).toHaveBeenCalledWith('a2'));
    await waitFor(() => expect(openTitle()).toBe('Alpha two'));
    expect(document.documentElement.getAttribute('data-panel')).toBe('closed');
  });
});
