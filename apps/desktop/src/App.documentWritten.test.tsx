/**
 * A document tool finishing opens the document it saved. Models pass their own
 * slugs as `artifact_id` ('otd', 'on-this-day.html'); the tool then creates a
 * new artifact under a fresh id, and the panel used to try the slug, find
 * nothing, and stay on its empty state. Every IPC call is a stub.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, ProviderEvent, ProviderRequest } from '@conduit/config-schema';
import type { Artifact } from './ipc/contracts';

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
 * whose *shape* the boot path reads.
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

/** An older page of the same chat, and the one this turn's write created. */
const older: Artifact = {
  id: 'older-uuid',
  conversationId: 'c1',
  kind: 'html',
  title: 'Older page',
  sourceMessageId: 'm0',
  createdAt: '2026-10-01T00:00:00Z',
};
const written: Artifact = {
  id: 'real-uuid',
  conversationId: 'c1',
  kind: 'html',
  title: 'On this day',
  sourceMessageId: 'm1',
  mimeType: 'text/html',
  contentText: '<!doctype html><html><body>On this day</body></html>',
  createdAt: '2026-10-09T00:00:00Z',
};

/** Boot, send a message, and have the model write a page with these arguments. */
async function writePage(args: Record<string, unknown>, listed: Artifact[]) {
  const ipc = await import('./ipc/client');
  let request: ProviderRequest | undefined;
  let emit: ((event: ProviderEvent) => void) | undefined;
  vi.mocked(ipc.startChatStream).mockImplementation(async (req, onEvent) => {
    request = req;
    emit = onEvent;
    return { requestId: req.requestId };
  });
  // The chat starts with no artifacts; the previous test's list stays behind otherwise.
  vi.mocked(ipc.listArtifacts).mockResolvedValue([]);
  vi.mocked(ipc.getMessageIdByRequest).mockResolvedValue('m1');
  vi.mocked(ipc.getArtifact).mockImplementation(
    async (id: string) => [older, written].find((artifact) => artifact.id === id) ?? null,
  );
  const { default: App } = await import('./App');
  render(<App />);
  const composer = await screen.findByPlaceholderText('Message… or type / for tools');
  fireEvent.change(composer, { target: { value: 'Make an on-this-day page' } });
  fireEvent.keyDown(composer, { key: 'Enter' });
  await waitFor(() => expect(request).toBeDefined());

  // The tool has saved the page by the time it reports finishing.
  vi.mocked(ipc.listArtifacts).mockResolvedValue(listed);
  const requestId = request!.requestId;
  const send = (event: object) => act(() => emit!({ requestId, ...event } as ProviderEvent));
  send({ kind: 'messageStart', index: 0 });
  send({ kind: 'toolCallStart', toolCallId: 't1', index: 1, toolId: 'write_html_document', name: 'write_html_document' });
  send({ kind: 'toolCallComplete', toolCallId: 't1', index: 1, arguments: args });
  send({ kind: 'toolExecutionFinished', toolCallId: 't1', toolName: 'write_html_document', isError: false });
  return ipc;
}

describe('opening the document a tool wrote', { timeout: 30_000 }, () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens the artifact the write created, not the slug the model passed as artifact_id', async () => {
    // Listed newest-updated first: the older page was touched after this
    // write, so "newest listed" alone would open the wrong one.
    const ipc = await writePage(
      { artifact_id: 'otd', title: 'On this day', html: written.contentText },
      [older, written],
    );
    await waitFor(() => expect(ipc.getArtifact).toHaveBeenCalledWith('real-uuid'));
    expect(ipc.getArtifact).not.toHaveBeenCalledWith('otd');
    expect(ipc.getMessageIdByRequest).toHaveBeenCalled();
  });

  it('a write with no artifact_id still opens the newest listed artifact', async () => {
    const ipc = await writePage({ title: 'On this day', html: written.contentText }, [written, older]);
    await waitFor(() => expect(ipc.getArtifact).toHaveBeenCalledWith('real-uuid'));
    expect(ipc.getArtifact).not.toHaveBeenCalledWith('older-uuid');
  });
});
