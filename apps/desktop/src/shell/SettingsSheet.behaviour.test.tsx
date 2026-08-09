import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AppSettings } from '../ipc/contracts';
import { SettingsSheet } from './SettingsSheet';

/**
 * Behavioural coverage restored from the deleted SettingsScreen.test.tsx:
 * the REAL DiagnosticsSection and PrivacyDataSection render inside the V7
 * sheet, with only the IPC bridge mocked. Auto-save and diagnostics export
 * flows must behave exactly as they did when settings was a screen.
 */
vi.mock('../ipc/client', () => ({
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
  resetLocalDatabase: vi.fn().mockResolvedValue({ backupPath: '/backup' }),
  listProviderModels: vi.fn().mockResolvedValue([]),
  listProviderDescriptors: vi.fn().mockResolvedValue([]),
  getUsageSummary: vi.fn().mockResolvedValue({
    totalCostCents: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    byProvider: [],
    dailyTotals: [],
  }),
  checkForUpdate: vi.fn().mockResolvedValue(null),
  downloadAndInstallUpdate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../workspace/settings/ProviderPicker', () => ({
  ProviderPicker: () => <div data-testid="provider-picker" />,
}));

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
};

function renderSheet(overrides: Partial<AppSettings> = {}) {
  const onSettingsChange = vi.fn();
  const onStatus = vi.fn();
  render(
    <SettingsSheet
      open
      initialSection="privacy"
      onClose={vi.fn()}
      settings={{ ...baseSettings, ...overrides }}
      onSettingsChange={onSettingsChange}
      paths={null}
      onStatus={onStatus}
    />,
  );
  return { onSettingsChange, onStatus };
}

describe('SettingsSheet behaviour (restored from SettingsScreen tests)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    document.documentElement.removeAttribute('data-provider-colour');
    document.documentElement.removeAttribute('data-reduce-motion');
  });

  it('auto-saves: toggling local-only mode calls updateSettings with the new value', async () => {
    const { updateSettings } = await import('../ipc/client');
    renderSheet();
    fireEvent.click(screen.getByRole('checkbox', { name: /local-only mode/i }));
    await waitFor(() => expect(updateSettings).toHaveBeenCalled());
    const calledWith = vi.mocked(updateSettings).mock.calls[0][0];
    expect(calledWith.localOnly).toBe(false);
  });

  // Diagnostics moved from Advanced into Privacy & data (plan D4). The
  // behaviour asserted below is unchanged; only the route to it is.
  it('diagnostics: disables Export when diagnosticsEnabled is false', () => {
    renderSheet({ diagnosticsEnabled: false });
    fireEvent.click(screen.getByRole('button', { name: 'Privacy & data' }));
    const btn = screen.getByRole('button', { name: 'Export diagnostics' });
    expect(btn).toBeDisabled();
  });

  it('diagnostics: exports and surfaces the bundle path on success', async () => {
    renderSheet({ diagnosticsEnabled: true });
    fireEvent.click(screen.getByRole('button', { name: 'Privacy & data' }));
    fireEvent.click(screen.getByRole('button', { name: 'Export diagnostics' }));
    await waitFor(() => expect(screen.getByText(/Exported to/)).toBeInTheDocument());
    expect(
      screen.getByText('/home/user/conduit/exports/diagnostics-1.json'),
    ).toBeInTheDocument();
  });
});
