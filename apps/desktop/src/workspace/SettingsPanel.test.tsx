import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AppPaths, AppSettings } from '../ipc/contracts';
import { SettingsPanel } from './SettingsPanel';

/// Phase 6 M6.5: diagnostics export hardening. The Diagnostics section must
/// (a) disable Export when `diagnosticsEnabled` is off, (b) show the export path
/// + a Reveal button after a successful export, and (c) prompt the one-time
/// disclosure on the first export, persisting the acknowledgement and aborting
/// if the user cancels. Mock the IPC client so no Tauri bridge is touched; the
/// mock covers every function SettingsPanel + the shared ProviderPicker +
/// ConnectorsSection reach for (vi.mock replaces the module by resolved path,
/// so all importers see the mock).
vi.mock('../ipc/client', () => ({
  getDiagnosticsDisclosureAcknowledged: vi.fn().mockResolvedValue(true),
  acknowledgeDiagnosticsDisclosure: vi.fn().mockResolvedValue(undefined),
  exportDiagnostics: vi.fn(),
  revealPath: vi.fn().mockResolvedValue(undefined),
  updateSettings: vi.fn(),
  checkForUpdate: vi.fn().mockResolvedValue(null),
  downloadAndInstallUpdate: vi.fn().mockResolvedValue(undefined),
  listProviderModels: vi.fn().mockResolvedValue([]),
  loadProviderCredentialReference: vi.fn().mockResolvedValue(null),
  saveProviderCredential: vi.fn().mockResolvedValue({
    providerId: 'anthropic',
    credentialRef: 'keychain://conduit/anthropic',
    storedInKeychain: true,
  }),
  validateProviderCredentials: vi.fn().mockResolvedValue(undefined),
  getConnectorRuntimeStates: vi.fn().mockResolvedValue([]),
  listConnectorCapabilities: vi.fn().mockResolvedValue([]),
  discoverConnector: vi.fn().mockResolvedValue([]),
  startConnector: vi.fn().mockResolvedValue({ name: 'x', version: '1' }),
  stopConnector: vi.fn().mockResolvedValue(undefined),
  revokeConnectorGrant: vi.fn().mockResolvedValue(undefined),
  addLocalConnector: vi.fn().mockResolvedValue({ connectorId: 'c1', connectorVersionId: 'v1' }),
}));

import {
  exportDiagnostics,
  acknowledgeDiagnosticsDisclosure,
  revealPath,
  getDiagnosticsDisclosureAcknowledged,
} from '../ipc/client';

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

function renderPanel(overrides: Partial<Parameters<typeof SettingsPanel>[0]> = {}) {
  const onSettingsChange = vi.fn();
  const onStatus = vi.fn();
  render(
    <SettingsPanel
      open
      onClose={vi.fn()}
      settings={makeSettings()}
      onSettingsChange={onSettingsChange}
      paths={paths}
      onStatus={onStatus}
      {...overrides}
    />,
  );
  return { onSettingsChange, onStatus };
}

describe('SettingsPanel Diagnostics section (Phase 6 M6.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDiagnosticsDisclosureAcknowledged).mockResolvedValue(true);
  });

  it('disables the Export button when diagnosticsEnabled is false', () => {
    renderPanel({ settings: makeSettings({ diagnosticsEnabled: false }) });
    const exportBtn = screen.getByRole('button', { name: 'Export diagnostics' });
    expect(exportBtn).toBeDisabled();
    expect(
      screen.getByText('Enable diagnostics above to export a support bundle.'),
    ).toBeInTheDocument();
  });

  it('enables Export when diagnosticsEnabled is true', () => {
    renderPanel({ settings: makeSettings({ diagnosticsEnabled: true }) });
    expect(screen.getByRole('button', { name: 'Export diagnostics' })).not.toBeDisabled();
  });

  it('exports, shows the path + a Reveal button after a successful export', async () => {
    vi.mocked(exportDiagnostics).mockResolvedValue({
      exportedTo: '/home/user/conduit/exports/diagnostics-1719.json',
      redactedFields: ['root', 'exports'],
    });
    renderPanel({ settings: makeSettings({ diagnosticsEnabled: true }) });

    fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }));

    await waitFor(() => expect(exportDiagnostics).toHaveBeenCalled());
    expect(await screen.findByText('Exported to')).toBeInTheDocument();
    expect(
      screen.getByText('/home/user/conduit/exports/diagnostics-1719.json'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reveal in folder' })).toBeInTheDocument();
  });

  it('Reveal in folder opens the export directory with no renderer-supplied path', async () => {
    vi.mocked(exportDiagnostics).mockResolvedValue({
      exportedTo: '/home/user/conduit/exports/diagnostics-1719.json',
      redactedFields: ['exports'],
    });
    renderPanel({ settings: makeSettings({ diagnosticsEnabled: true }) });
    fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }));
    const reveal = await screen.findByRole('button', { name: 'Reveal in folder' });
    fireEvent.click(reveal);
    await waitFor(() => expect(revealPath).toHaveBeenCalled());
    // The Rust command opens `AppPaths::exports` server-side — the renderer
    // passes no path, so it cannot direct the shell at an arbitrary location.
    expect(revealPath).toHaveBeenCalledWith();
  });

  it('prompts the one-time disclosure on the first export and persists acknowledgement', async () => {
    vi.mocked(getDiagnosticsDisclosureAcknowledged).mockResolvedValue(false);
    vi.mocked(exportDiagnostics).mockResolvedValue({
      exportedTo: '/home/user/conduit/exports/diagnostics-1.json',
      redactedFields: [],
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPanel({ settings: makeSettings({ diagnosticsEnabled: true }) });
    // The disclosure flag loads async; wait for the first-export path to apply.
    await waitFor(() =>
      expect(getDiagnosticsDisclosureAcknowledged).toHaveBeenCalled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(acknowledgeDiagnosticsDisclosure).toHaveBeenCalled();
    expect(exportDiagnostics).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('aborts the export when the disclosure confirm is cancelled', async () => {
    vi.mocked(getDiagnosticsDisclosureAcknowledged).mockResolvedValue(false);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderPanel({ settings: makeSettings({ diagnosticsEnabled: true }) });
    await waitFor(() =>
      expect(getDiagnosticsDisclosureAcknowledged).toHaveBeenCalled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }));

    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(acknowledgeDiagnosticsDisclosure).not.toHaveBeenCalled();
    expect(exportDiagnostics).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});