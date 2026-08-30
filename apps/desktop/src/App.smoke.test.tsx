/**
 * App-level smoke test — does the shell actually render?
 *
 * The suite had no test that mounted `App`. Every component below it was
 * covered, so a fault *in the shell itself* — a bad import, a throw during
 * render, a hook used above every error boundary — produced a blank window with
 * 595 green tests and a clean `tsc -b`. That is precisely the failure this
 * repo already builds mockups to catch, except a blank page has no visual
 * difference to diff: there is nothing on it.
 *
 * So this asserts the least interesting thing possible, which is the point: the
 * three columns mount and the composer exists. It is a canary, not a feature
 * test — if it fails, nothing else in the suite is worth reading yet.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { AppSettings } from '@conduit/config-schema';

const settings: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'dark',
  providerEndpoints: {},
  artifactRemoteAllowlist: [],
  artifactStyledPreview: true,
  updateChannel: 'stable',
  updateCheckEnabled: true,
  onboardingCompleted: true,
  webSearchEnabled: false,
  webSearch: {
    searchContextSize: 'medium',
    allowedDomains: [],
    blockedDomains: [],
    externalWebAccess: true,
    returnTokenBudget: 'default',
    includeSources: false,
  },
  webSearchConsentAcknowledged: false,
  agent: { maxSteps: 25, wallClockBudgetSecs: 300 },
  keychainMode: 'os',
  brandingEnabled: false,
  workspaceToolsEnabled: false,
  workspaceRoot: null,
  workspaceToolsConsentAcknowledged: false,
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
  listProviderDescriptors: [],
  listProviderModels: [],
  listConnectorGrants: [],
  listConnectorCapabilities: [],
  getConnectorRuntimeStates: [],
  getConversationMessages: [],
  searchMessages: [],
  createConversation: { id: 'c1', title: 'New chat', updatedAt: new Date().toISOString() },
  loadProviderCredentialReference: { providerId: 'anthropic', credentialRef: '', storedInKeychain: false },
  checkArtifactFileState: {},
};

/**
 * Every export of the IPC client, stubbed. Enumerated rather than proxied
 * because vitest needs a real module object to wrap — a Proxy target fails with
 * "Cannot create proxy with a non-object as target or handler".
 */
const IPC_EXPORTS = [
  'getAppPaths', 'getSettings', 'updateSettings', 'saveProviderCredential',
  'loadProviderCredentialReference', 'validateProviderCredentials',
  'listProviderDescriptors', 'listProviderModels', 'startChatStream',
  'cancelChatStream', 'getConversationMessages', 'getRequestProviderEvents',
  'createConversation', 'listConversations', 'getConversation',
  'deleteConversation', 'setConversationTitle', 'deleteAllConversations',
  'exportDiagnostics', 'getDiagnosticsDisclosureAcknowledged',
  'acknowledgeDiagnosticsDisclosure', 'revealPath', 'revealArtifactsDir',
  'revealArtifact', 'checkForUpdate', 'downloadAndInstallUpdate',
  'getOnboardingState', 'startMockStream', 'cancelMockStream',
  'listConnectorDefinitions', 'listConnectorVersions', 'listConnectorGrants',
  'listConnectorCapabilities', 'getConnectorRuntimeStates', 'startConnector',
  'stopConnector', 'discoverConnector', 'invokeConnectorTool',
  'approveConnectorToolCall', 'denyConnectorToolCall', 'revokeConnectorGrant',
  'addLocalConnector', 'createArtifact', 'listArtifacts', 'getMessageIdByRequest',
  'searchMessages', 'getUsageSummary', 'removeLastTurn', 'forkConversation',
  'createPrompt', 'listPrompts', 'getPrompt', 'updatePrompt', 'deletePrompt',
  'listPromptFolders', 'getArtifact', 'setArtifactContent', 'setArtifactTitle',
  'getArtifactContentBytes', 'readArtifactFileBytes', 'checkArtifactFileState',
  'exportArtifact', 'saveAttachment', 'listAttachments', 'deleteAttachment',
  'getAttachmentBytes', 'resetLocalDatabase',
  // White-label Phase 3 (Settings → Branding): App.tsx's boot effect already
  // calls getBrandConfig/getBrandLogo unconditionally, same as every other
  // Promise.all entry there — missing from this enumeration, either of them
  // is `undefined`, and calling it throws before `setPaths`/`setSettings`
  // ever run, which hangs the whole boot effect in its catch-less gap and
  // times out this smoke test with no other symptom.
  'getBrandConfig', 'getBrandLogo', 'saveBrandLogo', 'clearBrandLogo',
  'getBrandWarnings', 'clearBrandConfig', 'importBrandFile', 'applyBrandEdits',
  'exportBrandConfig',
] as const;

vi.mock('./ipc/client', () => {
  const mod: Record<string, unknown> = {};
  for (const name of IPC_EXPORTS) {
    mod[name] = vi.fn(async () => SHAPES[name] ?? null);
  }
  return mod;
});

describe('App shell', () => {
  it('mounts the three columns and the composer', async () => {
    const { default: App } = await import('./App');
    render(<App />);

    // The composer is the deepest thing on the boot path, so its presence means
    // the whole chain — App → body → center → ChatView → Composer — survived.
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Message Conduit…')).toBeInTheDocument(),
    );

    expect(document.querySelector('.app'), 'the app frame').not.toBeNull();
    expect(document.querySelector('.titlebar'), 'the caption row').not.toBeNull();
    expect(document.querySelector('.sidebar'), 'the sidebar column').not.toBeNull();
    expect(document.querySelector('.main-head'), 'the title strip').not.toBeNull();
  });

  it('renders no React error boundary fallback on a clean boot', async () => {
    const { default: App } = await import('./App');
    render(<App />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Message Conduit…')).toBeInTheDocument(),
    );
    expect(screen.queryByText(/something went wrong/i)).toBeNull();
  });
});
