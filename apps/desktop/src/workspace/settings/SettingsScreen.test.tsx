import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AppPaths, AppSettings } from '../../ipc/contracts';
import { SettingsScreen } from './SettingsScreen';

/// SettingsScreen tests: tab navigation, section rendering, auto-save.
/// Mock the IPC client so no Tauri bridge is touched.
vi.mock('../../ipc/client', () => ({
  updateSettings: vi.fn().mockResolvedValue({
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
    onboardingCompleted: true,
  }),
  getDiagnosticsDisclosureAcknowledged: vi.fn().mockResolvedValue(true),
  acknowledgeDiagnosticsDisclosure: vi.fn().mockResolvedValue(undefined),
  exportDiagnostics: vi.fn().mockResolvedValue({
    exportedTo: '/home/user/conduit/exports/diagnostics-1.json',
    redactedFields: [],
  }),
  revealPath: vi.fn().mockResolvedValue(undefined),
  checkForUpdate: vi.fn().mockResolvedValue(null),
  downloadAndInstallUpdate: vi.fn().mockResolvedValue(undefined),
  listProviderModels: vi.fn().mockResolvedValue([]),
  listProviderDescriptors: vi.fn().mockResolvedValue([
    { id: 'gemini', displayName: 'Google Gemini', defaultBaseUrl: null, credentialMode: 'required', isLocal: false, showBaseUrlField: false, tier: 1, description: null },
    { id: 'deepseek', displayName: 'DeepSeek', defaultBaseUrl: 'https://api.deepseek.com', credentialMode: 'required', isLocal: false, showBaseUrlField: false, tier: 1, description: 'Cost-efficient V4 models' },
    { id: 'mistral', displayName: 'Mistral', defaultBaseUrl: 'https://api.mistral.ai/v1', credentialMode: 'required', isLocal: false, showBaseUrlField: false, tier: 1, description: 'Codestral and Mistral Large' },
    { id: 'anthropic', displayName: 'Anthropic', defaultBaseUrl: null, credentialMode: 'required', isLocal: false, showBaseUrlField: false, tier: 0, description: null },
    { id: 'openai', displayName: 'OpenAI', defaultBaseUrl: null, credentialMode: 'required', isLocal: false, showBaseUrlField: false, tier: 0, description: null },
    { id: 'ollama', displayName: 'Ollama', defaultBaseUrl: 'http://127.0.0.1:11434', credentialMode: 'none', isLocal: true, showBaseUrlField: true, tier: 0, description: null },
  ]),
  loadProviderCredentialReference: vi.fn().mockResolvedValue(null),
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
  resetLocalDatabase: vi.fn().mockResolvedValue({ backupPath: '/backup' }),
}));

const paths: AppPaths = {
  root: '/home/user/conduit',
  settingsFile: '/home/user/conduit/settings.json',
  database: '/home/user/conduit/conduit.sqlite',
  attachments: '/home/user/conduit/attachments',
  artifacts: '/home/user/conduit/artifacts',
  logs: '/home/user/conduit/logs',
  diagnostics: '/home/user/conduit/diagnostics',
  updates: '/home/user/conduit/updates',
  streams: '/home/user/conduit/streams',
};

function makeSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
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
    ...overrides,
  };
}

function renderScreen(overrides: Partial<AppSettings> = {}) {
  const onSettingsChange = vi.fn();
  const onStatus = vi.fn();
  render(
    <SettingsScreen
      settings={makeSettings(overrides)}
      onSettingsChange={onSettingsChange}
      paths={paths}
      onStatus={onStatus}
    />,
  );
  return { onSettingsChange, onStatus };
}

describe('SettingsScreen tab navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Provider & Model tab by default', () => {
    renderScreen();
    // The tab sidebar button and section header both show "Provider & Model"
    expect(screen.getAllByText('Provider & Model').length).toBeGreaterThanOrEqual(1);
    // ProviderPicker should be visible
    expect(screen.getByText('Provider')).toBeInTheDocument();
  });

  it('navigates to Appearance tab when clicked', () => {
    renderScreen();
    fireEvent.click(screen.getByText('Appearance'));
    expect(screen.getByText('Theme')).toBeInTheDocument();
  });

  it('navigates to Privacy & Data tab when clicked', () => {
    renderScreen();
    fireEvent.click(screen.getByText('Privacy & Data'));
    expect(screen.getByText('Local-only mode')).toBeInTheDocument();
  });

  it('navigates to Artifact Security tab when clicked', () => {
    renderScreen();
    fireEvent.click(screen.getByText('Artifact Security'));
    expect(screen.getByText('Artifact remote allowlist')).toBeInTheDocument();
  });

  it('navigates to Updates tab when clicked', () => {
    renderScreen();
    fireEvent.click(screen.getByText('Updates'));
    expect(screen.getByText('Channel')).toBeInTheDocument();
  });

  it('navigates to Connectors tab when clicked', () => {
    renderScreen();
    fireEvent.click(screen.getByText('Connectors'));
    expect(screen.getByText('No connectors registered yet. Add a local stdio connector below.')).toBeInTheDocument();
  });

  it('navigates to Diagnostics tab when clicked', () => {
    renderScreen();
    fireEvent.click(screen.getByText('Diagnostics'));
    expect(screen.getByRole('button', { name: 'Export diagnostics' })).toBeInTheDocument();
  });

  it('navigates to About tab when clicked', () => {
    renderScreen();
    fireEvent.click(screen.getByText('About'));
    expect(screen.getByText('/home/user/conduit')).toBeInTheDocument();
  });

  it('navigates to Web Search tab when clicked', () => {
    renderScreen({ localOnly: false });
    fireEvent.click(screen.getByText('Web Search'));
    expect(screen.getByRole('checkbox', { name: /enable web search/i })).toBeInTheDocument();
  });

  it('opens the requested sub-tab via initialTab', () => {
    const onSettingsChange = vi.fn();
    const onStatus = vi.fn();
    render(
      <SettingsScreen
        settings={makeSettings({ localOnly: false })}
        onSettingsChange={onSettingsChange}
        paths={paths}
        onStatus={onStatus}
        initialTab="web-search"
      />,
    );
    expect(screen.getByRole('checkbox', { name: /enable web search/i })).toBeInTheDocument();
  });
});

describe('SettingsScreen Web Search section (Phase 7)', () => {
  it('warns when local-only mode blocks web search', () => {
    renderScreen({ localOnly: true });
    fireEvent.click(screen.getByText('Web Search'));
    expect(
      screen.getByText(/web search is unavailable in local-only mode/i),
    ).toBeInTheDocument();
  });
});

describe('SettingsScreen auto-save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls updateSettings when a toggle changes', async () => {
    const { updateSettings } = await import('../../ipc/client');
    renderScreen();
    // Navigate to Privacy & Data
    fireEvent.click(screen.getByText('Privacy & Data'));
    // Toggle local-only mode off
    const checkbox = screen.getByRole('checkbox', { name: /local-only mode/i });
    fireEvent.click(checkbox);
    // Should call updateSettings with localOnly: false
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const calledWith = vi.mocked(updateSettings).mock.calls[0][0];
    expect(calledWith.localOnly).toBe(false);
  });

  it('calls updateSettings when theme changes', async () => {
    const { updateSettings } = await import('../../ipc/client');
    renderScreen();
    // Navigate to Appearance
    fireEvent.click(screen.getByText('Appearance'));
    // Change theme to dark
    const select = screen.getByDisplayValue('System');
    fireEvent.change(select, { target: { value: 'dark' } });
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const calledWith = vi.mocked(updateSettings).mock.calls[0][0];
    expect(calledWith.theme).toBe('dark');
  });
});

describe('SettingsScreen Diagnostics section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables Export when diagnosticsEnabled is false', () => {
    renderScreen({ diagnosticsEnabled: false });
    fireEvent.click(screen.getByText('Diagnostics'));
    const btn = screen.getByRole('button', { name: 'Export diagnostics' });
    expect(btn).toBeDisabled();
  });

  it('enables Export when diagnosticsEnabled is true', () => {
    renderScreen({ diagnosticsEnabled: true });
    fireEvent.click(screen.getByText('Diagnostics'));
    expect(screen.getByRole('button', { name: 'Export diagnostics' })).not.toBeDisabled();
  });

  it('exports and shows path after successful export', async () => {
    renderScreen({ diagnosticsEnabled: true });
    fireEvent.click(screen.getByText('Diagnostics'));
    fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }));
    await waitFor(() => expect(screen.getByText('Exported to')).toBeInTheDocument());
    expect(screen.getByText('/home/user/conduit/exports/diagnostics-1.json')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reveal in folder' })).toBeInTheDocument();
  });

  it('prompts disclosure on first export', async () => {
    const { getDiagnosticsDisclosureAcknowledged, acknowledgeDiagnosticsDisclosure, exportDiagnostics } = await import('../../ipc/client');
    vi.mocked(getDiagnosticsDisclosureAcknowledged).mockResolvedValue(false);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderScreen({ diagnosticsEnabled: true });
    fireEvent.click(screen.getByText('Diagnostics'));
    await waitFor(() => expect(getDiagnosticsDisclosureAcknowledged).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(acknowledgeDiagnosticsDisclosure).toHaveBeenCalled();
    expect(exportDiagnostics).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('aborts export when disclosure cancelled', async () => {
    const { getDiagnosticsDisclosureAcknowledged, exportDiagnostics } = await import('../../ipc/client');
    vi.mocked(getDiagnosticsDisclosureAcknowledged).mockResolvedValue(false);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderScreen({ diagnosticsEnabled: true });
    fireEvent.click(screen.getByText('Diagnostics'));
    await waitFor(() => expect(getDiagnosticsDisclosureAcknowledged).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }));
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(exportDiagnostics).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
