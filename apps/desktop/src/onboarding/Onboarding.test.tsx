import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AppSettings } from '../ipc/contracts';
import { Onboarding } from './Onboarding';

/// Phase 6 M6.4: the first-run BYOK gate. Mock the IPC client so no Tauri bridge
/// is touched; the mock covers every function Onboarding + the shared
/// ProviderPicker + ConnectorsSection reach for (vi.mock replaces the module by
/// resolved path, so all importers see the mock).
vi.mock('../ipc/client', () => ({
  getOnboardingState: vi.fn(),
  updateSettings: vi.fn(),
  listProviderModels: vi.fn().mockResolvedValue([]),
  listProviderDescriptors: vi.fn().mockResolvedValue([
    { id: 'anthropic', displayName: 'Anthropic', defaultBaseUrl: null, credentialMode: 'required', isLocal: false, showBaseUrlField: false, tier: 0, description: null },
    { id: 'openai', displayName: 'OpenAI', defaultBaseUrl: null, credentialMode: 'required', isLocal: false, showBaseUrlField: false, tier: 0, description: null },
    { id: 'ollama', displayName: 'Ollama', defaultBaseUrl: 'http://127.0.0.1:11434', credentialMode: 'none', isLocal: true, showBaseUrlField: true, tier: 0, description: null },
  ]),
  loadProviderCredentialReference: vi.fn().mockResolvedValue({
    providerId: 'anthropic',
    credentialRef: 'keychain://conduit/anthropic',
    storedInKeychain: false,
  }),
  saveProviderCredential: vi.fn().mockResolvedValue({
    providerId: 'anthropic',
    credentialRef: 'keychain://conduit/anthropic',
    storedInKeychain: true,
  }),
  validateProviderCredentials: vi.fn().mockResolvedValue(undefined),
  getConnectorRuntimeStates: vi.fn().mockResolvedValue([]),
  listConnectorCapabilities: vi.fn().mockResolvedValue([]),
  listConnectorGrants: vi.fn().mockResolvedValue([]),
  discoverConnector: vi.fn().mockResolvedValue([]),
  startConnector: vi.fn().mockResolvedValue({ name: 'x', version: '1' }),
  stopConnector: vi.fn().mockResolvedValue(undefined),
  revokeConnectorGrant: vi.fn().mockResolvedValue(undefined),
  addLocalConnector: vi.fn().mockResolvedValue({ connectorId: 'c1', connectorVersionId: 'v1' }),
  listToolApprovalMemory: vi.fn().mockResolvedValue([]),
  revokeToolApprovalMemory: vi.fn().mockResolvedValue(true),
}));

import { getOnboardingState, updateSettings } from '../ipc/client';

const baseSettings: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'system',
  providerEndpoints: {},
  artifactRemoteAllowlist: [],
  artifactStyledPreview: true,
  updateChannel: 'stable',
  updateCheckEnabled: true,
  onboardingCompleted: false,
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
  agent: {
    maxSteps: 25,
    wallClockBudgetSecs: 300,
  },
  keychainMode: 'os',
  brandingEnabled: false,
  workspaceToolsEnabled: false,
  workspaceRoot: null,
  workspaceToolsConsentAcknowledged: false,
  generationControls: null,
  userInstructions: null,
};

function renderOnboarding(overrides: Partial<Parameters<typeof Onboarding>[0]> = {}) {
  const onSettingsChange = vi.fn();
  const onStatus = vi.fn();
  const onComplete = vi.fn();
  render(
    <Onboarding
      settings={baseSettings}
      onSettingsChange={onSettingsChange}
      onStatus={onStatus}
      status={null}
      onComplete={onComplete}
      {...overrides}
    />,
  );
  return { onSettingsChange, onStatus, onComplete };
}

function goToFinishStep() {
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
}

describe('Onboarding (Phase 6 M6.4)', () => {
  it('renders welcome, provider step, and progress dots', () => {
    renderOnboarding();
    expect(screen.getByText('Welcome to Conduit')).toBeInTheDocument();
    expect(screen.getByText('Choose a provider and bring your key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1 · Provider/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /2 · Connectors/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /3 · Finish/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Get started' })).not.toBeInTheDocument();
  });

  it('shows the diagnostics disclosure copy on the finish step', () => {
    renderOnboarding();
    goToFinishStep();
    const copy = screen.getAllByText(/never secrets, base URLs, allowlists, or conversation content/i);
    expect(copy).toHaveLength(1);
  });

  it('persists onboardingCompleted + completes when a provider credential is configured', async () => {
    vi.mocked(getOnboardingState).mockResolvedValue({
      onboardingCompleted: false,
      hasProviderCredential: true,
      migrationRecovery: null,
    });
    vi.mocked(updateSettings).mockImplementation(
      async (patch) => ({ ...baseSettings, ...patch, onboardingCompleted: true }),
    );

    const { onComplete, onSettingsChange } = renderOnboarding();
    goToFinishStep();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));

    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ onboardingCompleted: true }));
    expect(onSettingsChange).toHaveBeenCalled();
  });

  it('refuses to complete (no updateSettings flag flip) when no provider credential is configured', async () => {
    vi.mocked(getOnboardingState).mockResolvedValue({
      onboardingCompleted: false,
      hasProviderCredential: false,
      migrationRecovery: null,
    });
    const updateSpy = vi.mocked(updateSettings);
    updateSpy.mockClear();

    const { onComplete, onStatus } = renderOnboarding();
    goToFinishStep();
    fireEvent.click(screen.getByRole('button', { name: 'Get started' }));

    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('provider key')));
    expect(updateSpy).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('toggling diagnostics updates settings', () => {
    const { onSettingsChange } = renderOnboarding({ settings: { ...baseSettings, diagnosticsEnabled: false } });
    goToFinishStep();
    const checkbox = screen.getByRole('checkbox', { name: /Enable diagnostics export/i });
    fireEvent.click(checkbox);
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ diagnosticsEnabled: true }));
  });
});
