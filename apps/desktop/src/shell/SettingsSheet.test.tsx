import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { AppSettings } from '../ipc/contracts';
import { SettingsSheet, type SettingsSection } from './SettingsSheet';

vi.mock('../ipc/client', () => ({
  listProviderModels: vi.fn().mockResolvedValue([
    { id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4' },
    { id: 'gpt-4.1-mini', displayName: 'GPT-4.1 mini' },
  ]),
  updateSettings: vi.fn().mockResolvedValue({}),
}));

vi.mock('../workspace/settings/ProviderPicker', () => ({
  ProviderPicker: () => <div data-testid="provider-picker" />,
}));
vi.mock('../workspace/settings/AppearanceSection', () => ({
  AppearanceSection: () => <div data-testid="appearance-section" />,
}));
vi.mock('../workspace/settings/PrivacyDataSection', () => ({
  PrivacyDataSection: () => <div data-testid="privacy-section" />,
}));
vi.mock('../workspace/settings/ArtifactSecuritySection', () => ({
  ArtifactSecuritySection: () => <div data-testid="artifact-security-section" />,
}));
vi.mock('../workspace/settings/UpdatesSection', () => ({
  UpdatesSection: () => <div data-testid="updates-section" />,
}));
vi.mock('../workspace/settings/ConnectorsSection', () => ({
  ConnectorsSection: () => <div data-testid="connectors-section" />,
}));
vi.mock('../workspace/settings/DiagnosticsSection', () => ({
  DiagnosticsSection: () => <div data-testid="diagnostics-section" />,
}));
vi.mock('../workspace/settings/AboutSection', () => ({
  AboutSection: () => <div data-testid="about-section" />,
}));
vi.mock('../workspace/settings/WebSearchSection', () => ({
  WebSearchSection: () => <div data-testid="web-search-section" />,
}));
vi.mock('../workspace/settings/WorkspaceToolsSection', () => ({
  WorkspaceToolsSection: () => <div data-testid="workspace-section" />,
}));
vi.mock('../workspace/settings/AgentSection', () => ({
  AgentSection: () => <div data-testid="agent-section" />,
}));
vi.mock('../workspace/settings/PromptsSection', () => ({
  PromptsSection: () => <div data-testid="prompts-section" />,
}));
vi.mock('../workspace/settings/UsageSection', () => ({
  UsageSection: () => <div data-testid="usage-section" />,
}));

import { listProviderModels } from '../ipc/client';

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
    mode: 'auto' as const,
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
};

function renderSheet(overrides: { initialSection?: SettingsSection } = {}) {
  const onClose = vi.fn();
  const onSettingsChange = vi.fn();
  const onStatus = vi.fn();
  render(
    <SettingsSheet
      open
      initialSection={overrides.initialSection}
      onClose={onClose}
      settings={baseSettings}
      onSettingsChange={onSettingsChange}
      paths={null}
      onStatus={onStatus}
    />,
  );
  return { onClose, onSettingsChange, onStatus };
}

describe('SettingsSheet', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-palette');
    document.documentElement.removeAttribute('data-provider-colour');
    document.documentElement.removeAttribute('data-reduce-motion');
  });

  it('renders the nav sections and defaults to providers', () => {
    renderSheet();
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    expect(screen.getAllByText('Providers & keys').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Chat defaults')).toBeTruthy();
    expect(screen.getByText('Web search')).toBeTruthy();
    expect(screen.getByText('Workspace')).toBeTruthy();
    expect(screen.getByText('Connectors')).toBeTruthy();
    expect(screen.getByText('Prompts')).toBeTruthy();
    expect(screen.getByText('Appearance')).toBeTruthy();
    expect(screen.getByText('Privacy & data')).toBeTruthy();
    expect(screen.getByText('About')).toBeTruthy();
    // Advanced is dissolved (plan D4).
    expect(screen.queryByText('Advanced')).toBeNull();
    expect(screen.getByTestId('provider-picker')).toBeTruthy();
  });

  it('switches sections from the nav', () => {
    renderSheet();
    fireEvent.click(screen.getByText('Appearance'));
    expect(screen.getByTestId('appearance-section')).toBeTruthy();
    fireEvent.click(screen.getByText('Connectors'));
    expect(screen.getByTestId('connectors-section')).toBeTruthy();
    fireEvent.click(screen.getByText('Prompts'));
    expect(screen.getByTestId('prompts-section')).toBeTruthy();
    fireEvent.click(screen.getByText('Web search'));
    expect(screen.getByTestId('web-search-section')).toBeTruthy();
    fireEvent.click(screen.getByText('Workspace'));
    expect(screen.getByTestId('workspace-section')).toBeTruthy();
  });

  it('honours initialSection', () => {
    renderSheet({ initialSection: 'prompts' });
    expect(screen.getByTestId('prompts-section')).toBeTruthy();
  });

  it('honours initialSection for web search', () => {
    renderSheet({ initialSection: 'web-search' });
    expect(screen.getByTestId('web-search-section')).toBeTruthy();
  });

  /**
   * Privacy keeps trust/data controls and diagnostics; usage, updates, and
   * about paths live under the dedicated About section.
   */
  it('keeps privacy controls under Privacy & data', () => {
    renderSheet({ initialSection: 'privacy' });
    expect(screen.getByTestId('privacy-section')).toBeTruthy();
    expect(screen.getByTestId('artifact-security-section')).toBeTruthy();
    expect(screen.getByTestId('diagnostics-section')).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Include metadata on export' })).toBeTruthy();
    expect(screen.queryByTestId('usage-section')).toBeNull();
    expect(screen.queryByTestId('updates-section')).toBeNull();
    expect(screen.queryByTestId('about-section')).toBeNull();
  });

  it('keeps usage, updates, and paths under About', () => {
    renderSheet({ initialSection: 'about' });
    expect(screen.getByTestId('usage-section')).toBeTruthy();
    expect(screen.getByTestId('updates-section')).toBeTruthy();
    expect(screen.getByTestId('about-section')).toBeTruthy();
  });

  it('mounts agent guardrails under Chat defaults', () => {
    renderSheet({ initialSection: 'chat' });
    expect(screen.getByTestId('agent-section')).toBeTruthy();
    expect(screen.queryByTestId('web-search-section')).toBeNull();
    expect(screen.queryByTestId('workspace-section')).toBeNull();
  });
  it('provider colour toggle persists to localStorage and applies the html attribute', () => {
    renderSheet();
    fireEvent.click(screen.getByText('Appearance'));
    const toggle = screen.getByRole('switch', { name: 'Provider colour' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(localStorage.getItem('conduit:v7-provider-colour')).toBe('off');
    expect(document.documentElement.getAttribute('data-provider-colour')).toBe('off');
  });

  /** V9 §10.1's escape hatch for the collapsed status line (plan D6). */
  it('expanded status toggle persists to localStorage and applies the html attribute', () => {
    renderSheet();
    fireEvent.click(screen.getByText('Appearance'));
    const toggle = screen.getByRole('switch', { name: 'Expanded status line' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(localStorage.getItem('conduit:v9-expanded-status')).toBe('on');
    expect(document.documentElement.getAttribute('data-expanded-status')).toBe('on');
  });

  it('reduce motion toggle persists to localStorage and applies the html attribute', () => {
    renderSheet();
    fireEvent.click(screen.getByText('Appearance'));
    fireEvent.click(screen.getByRole('switch', { name: 'Reduce motion' }));
    expect(localStorage.getItem('conduit:v7-reduce-motion')).toBe('on');
    expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('on');
  });

  it('chat defaults: show reasoning + send-with persist; models load for the active provider', async () => {
    renderSheet();
    fireEvent.click(screen.getByText('Chat defaults'));
    await waitFor(() => expect(listProviderModels).toHaveBeenCalledWith('anthropic'));
    fireEvent.click(screen.getByRole('switch', { name: 'Show reasoning by default' }));
    expect(localStorage.getItem('conduit:v7-show-reasoning')).toBe('on');
    fireEvent.change(screen.getByLabelText('Send with'), { target: { value: 'cmd-enter' } });
    expect(localStorage.getItem('conduit:v7-send-with')).toBe('cmd-enter');
  });

  it('escape closes the sheet', () => {
    const { onClose } = renderSheet();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('scrim click closes the sheet', () => {
    const { onClose } = renderSheet();
    const scrim = document.querySelector('.scrim')!;
    fireEvent.pointerDown(scrim);
    expect(onClose).toHaveBeenCalled();
  });
});
