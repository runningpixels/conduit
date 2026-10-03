import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AppSettings } from '../../ipc/contracts';
import { openExternalUrl } from '../../ipc/client';
import { SEARCH_KEY_PAGES, WebSearchSection } from './WebSearchSection';

vi.mock('../../ipc/client', () => ({
  loadProviderCredentialReference: vi.fn().mockResolvedValue(null),
  saveProviderCredential: vi.fn(),
  openExternalUrl: vi.fn().mockResolvedValue(undefined),
}));

function settings(webSearch: Partial<AppSettings['webSearch']> = {}): AppSettings {
  return {
    activeProvider: 'ollama',
    activeModel: 'llama3',
    localOnly: false,
    diagnosticsEnabled: false,
    theme: 'system',
    language: 'system',
    providerEndpoints: {},
    artifactRemoteAllowlist: [],
    artifactStyledPreview: true,
    artifactNetworkEnabled: true,
    closeToTray: false,
    closeToTrayOffered: false,
    updateChannel: 'stable',
    updateCheckEnabled: true,
    updatePolicy: 'manual',
    onboardingCompleted: true,
    webSearchEnabled: true,
    webSearch: {
      mode: 'local',
      localBackend: 'exa',
      searchContextSize: 'medium',
      allowedDomains: [],
      blockedDomains: [],
      externalWebAccess: true,
      returnTokenBudget: 'default',
      includeSources: false,
      ...webSearch,
    },
    webSearchConsentAcknowledged: true,
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
  } as AppSettings;
}

function renderSection(webSearch: Partial<AppSettings['webSearch']> = {}) {
  const onUpdate = vi.fn();
  const onStatus = vi.fn();
  render(<WebSearchSection settings={settings(webSearch)} onUpdate={onUpdate} onStatus={onStatus} />);
  return { onUpdate, onStatus };
}

afterEach(() => vi.clearAllMocks());

describe('WebSearchSection', () => {
  it('offers Exa first, with an optional key and a link to get one', () => {
    renderSection();
    const radios = screen.getAllByRole('radio', { name: /Exa|DuckDuckGo|Tavily|Brave|SearXNG/ });
    expect(radios[0]).toHaveAccessibleName(/^Exa/);
    expect(radios[0]).toBeChecked();
    expect(screen.getByText('Exa API key (optional)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Get a key from Exa/ }));
    expect(openExternalUrl).toHaveBeenCalledWith(SEARCH_KEY_PAGES.exa);
  });

  it('links each key-based service to its own signup page', () => {
    renderSection({ localBackend: 'tavily' });
    expect(screen.getByText('Tavily API key')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Get a key from Tavily/ }));
    expect(openExternalUrl).toHaveBeenCalledWith(SEARCH_KEY_PAGES.tavily);
  });

  it('points a DuckDuckGo user at Exa, with a one-click switch', () => {
    const { onUpdate } = renderSection({ localBackend: 'duckduckgo' });
    expect(screen.getByRole('note')).toHaveTextContent(/most searches come back empty/);
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Exa' }));
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ webSearch: expect.objectContaining({ localBackend: 'exa' }) }),
    );
  });

  it('links SearXNG to its setup guide', () => {
    renderSection({ localBackend: 'searxng' });
    fireEvent.click(screen.getByRole('button', { name: /How to run SearXNG/ }));
    expect(openExternalUrl).toHaveBeenCalledWith(SEARCH_KEY_PAGES.searxng);
  });
});
