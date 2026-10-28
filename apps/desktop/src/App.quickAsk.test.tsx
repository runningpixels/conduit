/**
 * Quick ask in the shell: a question sent from the shortcut's ask box (the
 * `quick-ask` event, or one already waiting when the app starts) is asked the
 * way Home's ask box asks it — a deck request starts a deck, anything else goes
 * to a fresh chat. The quick-ask bridge and every IPC call are stubs.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { AppSettings, ProviderRequest } from '@conduit/config-schema';

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
 * whose *shape* the boot path reads; the Proxy default covers the rest, so this
 * file does not have to be revisited every time a command is added.
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

/** The smoke test's list of stubbed IPC exports (App.smoke.test.tsx). */
const IPC_EXPORTS = [
  'getAppPaths', 'getSettings', 'updateSettings', 'saveProviderCredential',
  'setTrayLabels', 'getStartAtLogin', 'setStartAtLogin', 'getRunningWorkflowCount', 'stopWorkflowRun',
  'getWorkflowPermissions', 'approveWorkflowPermissions', 'listWorkflowReviews', 'answerWorkflowReview',
  'listWorkflowQuestions', 'answerWorkflowQuestion', 'rerunWorkflowFrom',
  'loadProviderCredentialReference', 'validateProviderCredentials',
  'listProviderDescriptors', 'listProviderModels', 'startChatStream',
  'cancelChatStream', 'steerChatStream', 'submitAskUser', 'getConversationMessages', 'getConversationCompaction', 'compactConversation', 'getRequestEventLog',
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
  // Slides: the quick-ask deck route starts a deck.
  'createDeck', 'getDeck',
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

vi.mock('./ipc/client', () => {
  const mod: Record<string, unknown> = {};
  for (const name of IPC_EXPORTS) {
    mod[name] = vi.fn(async () => SHAPES[name] ?? null);
  }
  return mod;
});

/** The quick-ask bridge: a slot the test fills, and the event the test fires. */
const bridge = vi.hoisted(() => ({
  pending: null as string | null,
  listeners: [] as Array<() => void>,
}));
vi.mock('./quickAsk/quickAskIpc', () => ({
  takePendingQuickAsk: vi.fn(async () => {
    const text = bridge.pending;
    bridge.pending = null;
    return text;
  }),
  listenQuickAsk: vi.fn((onWaiting: () => void) => {
    bridge.listeners.push(onWaiting);
    return () => {
      bridge.listeners = bridge.listeners.filter((fn) => fn !== onWaiting);
    };
  }),
}));

/** What Rust does on submit: fill the slot, then signal. */
function sendFromAskBox(text: string) {
  bridge.pending = text;
  for (const fn of [...bridge.listeners]) fn();
}

beforeAll(() => {
  const proto = Range.prototype as unknown as Record<string, unknown>;
  proto.getClientRects ??= () => [] as unknown as DOMRectList;
  proto.getBoundingClientRect ??= () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 }) as DOMRect;
});

async function boot() {
  const { default: App } = await import('./App');
  render(<App />);
  await waitFor(() => expect(screen.getByPlaceholderText('Message… or type / for tools')).toBeInTheDocument());
}

function lastUserText(request: ProviderRequest | undefined): string {
  return request?.messages.at(-1)?.parts.map((part) => part.content ?? '').join('') ?? '';
}

describe('Quick ask in the shell', { timeout: 30_000 }, () => {
  afterEach(() => {
    bridge.pending = null;
    bridge.listeners = [];
    vi.clearAllMocks();
  });

  it('asks a question from the ask box in a fresh chat', async () => {
    const ipc = await import('./ipc/client');
    let request: ProviderRequest | undefined;
    vi.mocked(ipc.startChatStream).mockImplementation(async (req) => {
      request = req;
      return { requestId: req.requestId };
    });
    await boot();
    await waitFor(() => expect(bridge.listeners.length).toBeGreaterThan(0));
    sendFromAskBox('What changed in Rust 1.90?');
    await waitFor(() => expect(request).toBeDefined(), { timeout: 5000 });
    expect(lastUserText(request)).toBe('What changed in Rust 1.90?');
    expect(ipc.createDeck).not.toHaveBeenCalled();
    expect(bridge.pending).toBeNull();
  });

  it('asks a question that was waiting before the app was ready, once', async () => {
    const ipc = await import('./ipc/client');
    const requests: ProviderRequest[] = [];
    vi.mocked(ipc.startChatStream).mockImplementation(async (req) => {
      requests.push(req);
      return { requestId: req.requestId };
    });
    bridge.pending = 'Summarize my week';
    await boot();
    await waitFor(() => expect(requests.length).toBe(1), { timeout: 5000 });
    expect(lastUserText(requests[0])).toBe('Summarize my week');
    // A late signal finds the slot empty: nothing is asked twice.
    for (const fn of [...bridge.listeners]) fn();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requests.length).toBe(1);
  });

  it('routes a deck request to Slides', async () => {
    const ipc = await import('./ipc/client');
    vi.mocked(ipc.createDeck).mockRejectedValue(new Error('stop here'));
    await boot();
    await waitFor(() => expect(bridge.listeners.length).toBeGreaterThan(0));
    sendFromAskBox('Make a slide deck about our Q3 results');
    await waitFor(() => expect(ipc.createDeck).toHaveBeenCalledTimes(1), { timeout: 5000 });
    expect(ipc.startChatStream).not.toHaveBeenCalled();
  });
});
