import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  addRemoteConnector: vi.fn(),
  searchMcpRegistry: vi.fn().mockResolvedValue([]),
  signinRemoteConnector: vi.fn(),
  listToolApprovalMemory: vi.fn().mockResolvedValue([]),
  revokeToolApprovalMemory: vi.fn().mockResolvedValue(true),
}));

import { getOnboardingState, listProviderDescriptors, updateSettings } from '../ipc/client';

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
  contextCompactEnabled: true,
  contextCompactThresholdPercent: 90,
  memoryEnabled: true,
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

/** The dot nav is clickable, so a step is reachable in one jump rather than a
 *  run of Continues that has to be re-counted every time a step is added. */
function goToStep(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }));
}

function goToFinishStep() {
  goToStep(/· Finish/i);
}

describe('Onboarding (Phase 6 M6.4)', () => {
  /* The steps now write through on change, so `updateSettings` is called during
     ordinary interaction rather than only at the gate. Reset it per test: a
     `mockImplementation` left standing from the ordering test below would
     otherwise decide what a later test sees. The default returns the patch
     merged into the baseline, which is what Rust does. */
  beforeEach(() => {
    vi.mocked(updateSettings).mockReset();
    vi.mocked(updateSettings).mockImplementation(
      async (patch) => ({ ...baseSettings, ...patch }) as AppSettings,
    );
    vi.mocked(getOnboardingState).mockReset();
    vi.mocked(getOnboardingState).mockResolvedValue({
      onboardingCompleted: false,
      hasProviderCredential: true,
      migrationRecovery: null,
    });
  });

  it('renders welcome, appearance step, and progress dots', () => {
    renderOnboarding();
    expect(screen.getByText('Welcome to Conduit')).toBeInTheDocument();
    // Appearance leads: a user who cannot read the interface cannot act on any
    // later step, and the language switch re-mounts App, which is free here and
    // destructive once the key field below has something in it.
    expect(screen.getByText('Set your language and look')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1 · Appearance/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /2 · Provider/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /3 · Privacy/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /4 · Connectors/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /5 · Finish/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Get started' })).not.toBeInTheDocument();
  });

  it('shows the diagnostics disclosure copy on the privacy step', () => {
    renderOnboarding();
    goToStep(/· Privacy/i);
    const copy = screen.getAllByText(/never secrets, base URLs, allowlists, or chat content/i);
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
    goToStep(/· Privacy/i);
    const checkbox = screen.getByRole('checkbox', { name: /Enable diagnostics export/i });
    fireEvent.click(checkbox);
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ diagnosticsEnabled: true }));
  });

  it('persists a privacy toggle immediately rather than waiting for the finish gate', async () => {
    // Four steps of choices are a lot to lose. Every step that edits settings
    // directly writes through on change, so quitting mid-setup keeps what was
    // already decided — and so the language re-mount below cannot roll one back.
    const { onSettingsChange } = renderOnboarding();
    goToStep(/· Privacy/i);
    fireEvent.click(screen.getByRole('checkbox', { name: /Local-only mode/i }));
    expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ localOnly: false }));
    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ localOnly: false })),
    );
  });

  describe('the provider step', () => {
    it('clears local-only mode when a cloud provider is chosen', async () => {
      /* `local_only` defaults to true and `active_provider` to `anthropic`, and
       * `stream_manager.rs` rejects every adapter that is not local while the
       * flag is on — so the documented first run used to end at "Cloud provider
       * 'anthropic' is disabled while local_only mode is on", naming a setting
       * the user had never seen. Choosing a cloud provider is the decision to
       * leave local-only mode; this makes that explicit instead of fatal. */
      const { onSettingsChange, onStatus } = renderOnboarding();
      goToStep(/· Provider/i);
      const select = await screen.findByDisplayValue('Anthropic');
      fireEvent.change(select, { target: { value: 'openai' } });

      expect(onSettingsChange).toHaveBeenCalledWith(
        expect.objectContaining({ activeProvider: 'openai', localOnly: false }),
      );
      // Announced, not silent: a setting that changes behind the user is the
      // problem this fixes, not the mechanism it uses.
      expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('OpenAI'));
    });

    it('leaves local-only mode alone when a local provider is chosen', async () => {
      // One-way. Running a local model once is not a request to start blocking
      // cloud providers, and that flag reaches well beyond this dropdown.
      const { onSettingsChange, onStatus } = renderOnboarding();
      goToStep(/· Provider/i);
      const select = await screen.findByDisplayValue('Anthropic');
      fireEvent.change(select, { target: { value: 'ollama' } });

      expect(onSettingsChange).toHaveBeenCalledWith(
        expect.objectContaining({ activeProvider: 'ollama', localOnly: true }),
      );
      expect(onStatus).not.toHaveBeenCalled();
    });
  });

  describe('the appearance step', () => {
    it('offers only locales with a catalog behind them, named in their own language', () => {
      renderOnboarding();
      expect(screen.getByRole('option', { name: 'Deutsch' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: '日本語' })).toBeInTheDocument();
      // The pseudo-locale is generated for layout QA and is never offered.
      expect(screen.queryByRole('option', { name: /Pseudo/i })).not.toBeInTheDocument();
    });

    it('writes the language to Rust BEFORE announcing it to the provider', async () => {
      /* The regression this file exists to prevent.
       *
       * `I18nProvider` carries `key={locale}`, so announcing a language
       * re-mounts <App>: settings reset to the placeholder and the boot IPC
       * re-runs, after which App reconciles by calling `setPreference` with
       * whatever Rust returned. Announce first and Rust still holds the old
       * value, so the reconcile reverts the choice — and since that flip changes
       * the key again, it can repeat. The write has to land first.
       *
       * Asserted as an ordering, not as "both happened", because both happening
       * in the wrong order is exactly the bug. */
      const order: string[] = [];
      vi.mocked(updateSettings).mockImplementation(async (patch) => {
        order.push('write');
        return { ...baseSettings, ...patch };
      });
      const onSettingsChange = vi.fn(() => {
        order.push('announce');
      });

      renderOnboarding({ onSettingsChange });
      fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'de' } });

      await waitFor(() => expect(order).toContain('announce'));
      expect(order).toEqual(['write', 'announce']);
      expect(updateSettings).toHaveBeenCalledWith(expect.objectContaining({ language: 'de' }));
    });

    it('leaves the language alone when the write fails', async () => {
      // Announcing a language Rust rejected would re-mount into a locale that
      // does not survive the next boot — the same revert, reached the other way.
      vi.mocked(updateSettings).mockRejectedValueOnce(new Error('disk full'));
      const { onSettingsChange, onStatus } = renderOnboarding();

      fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'fr' } });

      await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('save')));
      expect(onSettingsChange).not.toHaveBeenCalled();
    });

    it('applies the theme optimistically, without waiting for the write', () => {
      // The opposite order, and correct here: theme repaints through App's
      // effect and re-mounts nothing, so making the user wait on IPC to see a
      // colour change would be latency for its own sake.
      const { onSettingsChange } = renderOnboarding();
      fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'light' } });
      expect(onSettingsChange).toHaveBeenCalledWith(expect.objectContaining({ theme: 'light' }));
    });
  });

  describe('the review step', () => {
    it('shows back what was actually configured', async () => {
      renderOnboarding({
        settings: { ...baseSettings, language: 'ja', theme: 'light', localOnly: false },
      });
      goToFinishStep();

      // The provider by its label, not its id: "Anthropic", never "anthropic".
      expect(await screen.findByText('Anthropic')).toBeInTheDocument();
      expect(screen.getByText('claude-sonnet-4')).toBeInTheDocument();
      expect(screen.getByText('日本語')).toBeInTheDocument();
      expect(screen.getByText('Light')).toBeInTheDocument();
      expect(screen.getByText('Off')).toBeInTheDocument();
    });

    it('falls back to the provider id when descriptors cannot be listed', async () => {
      vi.mocked(listProviderDescriptors).mockRejectedValueOnce(new Error('offline'));
      renderOnboarding({ settings: { ...baseSettings, activeProvider: 'openai_compat' } });
      goToFinishStep();
      expect(await screen.findByText('openai_compat')).toBeInTheDocument();
    });
  });
});
