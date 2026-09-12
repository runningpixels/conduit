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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { AppSettings } from '@conduit/config-schema';
import { I18nProvider } from './i18n';
import deMessages from './i18n/messages/de.json';

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
  'cancelChatStream', 'steerChatStream', 'submitAskUser', 'getConversationMessages', 'getConversationCompaction', 'compactConversation', 'getRequestProviderEvents',
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
  'previewConversationExport', 'exportConversationDialog',
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

afterEach(() => {
  // Shared across tests by reference: the IPC mock reads it at call time.
  settings.language = 'system';
});

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

  /* The boot loop, which shipped as a blank-looking bug: every piece of content
   * in the window re-mounting several times a second, for as long as the app
   * was open.
   *
   * App lives inside `I18nProvider`, which carries `key={locale}` so that a
   * language change re-mounts the subtree rather than leaving formatted text
   * frozen in somebody's `useState`. App also mirrors `AppSettings.language`
   * back into the provider. Both are correct; together they were not, because
   * App's `settings` starts as `defaultSettings`, whose language is `'system'`
   * — a placeholder, not a value the user chose. So every mount announced
   * `'system'`, which resolves somewhere other than an explicit choice, which
   * changed the key, which re-mounted App, which reset `settings` to the
   * placeholder and announced `'system'` again. Round and round at the speed of
   * the boot IPC.
   *
   * It needed a stored language that is not `'system'`, so it stayed invisible
   * for as long as the picker had nothing worth choosing, and appeared the day
   * the catalogs landed.
   *
   * Counted through `getSettings` rather than by watching the DOM: the boot
   * effect calls it exactly once per mount, so the call count *is* the mount
   * count, and it cannot be satisfied by a test that merely restates the fix.
   */
  it('boots once when a language is stored, instead of re-mounting forever', async () => {
    settings.language = 'de';
    const { getSettings } = await import('./ipc/client');
    vi.mocked(getSettings).mockClear();

    const { default: App } = await import('./App');
    render(
      <I18nProvider initialPreference="de" initialMessages={deMessages as Record<string, string>}>
        <App />
      </I18nProvider>,
    );

    await waitFor(() =>
      expect(screen.getByPlaceholderText('Nachricht an Conduit…')).toBeInTheDocument(),
    );
    // Long enough for many round trips if the key were flapping.
    await new Promise((resolve) => setTimeout(resolve, 300));

    /* One boot is the settled case. Two is the legitimate ceiling: a stale
     * localStorage mirror resolves to a different locale than Rust reports,
     * which re-mounts once, on purpose, and then agrees with itself. */
    expect(
      vi.mocked(getSettings).mock.calls.length,
      'App re-mounted — the locale key is flapping',
    ).toBeLessThanOrEqual(2);
  });
});
