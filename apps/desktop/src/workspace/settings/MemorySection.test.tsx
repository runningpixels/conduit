import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings } from '../../ipc/contracts';
import type { MemoryItem } from '../../ipc/contracts';
import { MemorySection } from './MemorySection';

const {
  listMemoryItems,
  createMemoryItem,
  updateMemoryItem,
  deleteMemoryItem,
  acceptMemoryItem,
} = vi.hoisted(() => ({
  listMemoryItems: vi.fn(),
  createMemoryItem: vi.fn(),
  updateMemoryItem: vi.fn(),
  deleteMemoryItem: vi.fn(),
  acceptMemoryItem: vi.fn(),
}));

vi.mock('../../ipc/client', () => ({
  listMemoryItems,
  createMemoryItem,
  updateMemoryItem,
  deleteMemoryItem,
  acceptMemoryItem,
}));

const settings: AppSettings = {
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

function item(overrides: Partial<MemoryItem>): MemoryItem {
  return {
    id: 'm1',
    kind: 'core',
    body: 'I prefer terse commit messages',
    pinned: false,
    status: 'active',
    createdAt: '2026-09-04T00:00:00Z',
    updatedAt: '2026-09-04T00:00:00Z',
    ...overrides,
  };
}

describe('MemorySection', () => {
  beforeEach(() => {
    listMemoryItems.mockReset();
    createMemoryItem.mockReset();
    updateMemoryItem.mockReset();
    deleteMemoryItem.mockReset();
    acceptMemoryItem.mockReset();
    listMemoryItems.mockResolvedValue([]);
    createMemoryItem.mockResolvedValue(item({}));
    updateMemoryItem.mockResolvedValue(item({}));
    deleteMemoryItem.mockResolvedValue(undefined);
    acceptMemoryItem.mockResolvedValue(item({ status: 'active' }));
  });

  it('toggles disable-all through settings', async () => {
    const onUpdate = vi.fn();
    render(<MemorySection settings={settings} onUpdate={onUpdate} onStatus={vi.fn()} />);
    await screen.findByText('No saved facts yet', { exact: false });
    fireEvent.click(screen.getByRole('switch', { name: 'Use saved memory' }));
    expect(onUpdate).toHaveBeenCalledWith({ ...settings, memoryEnabled: false });
  });

  it('saves a fact authored in Settings as active', async () => {
    const onStatus = vi.fn();
    listMemoryItems.mockResolvedValueOnce([]).mockResolvedValueOnce([item({})]);
    render(<MemorySection settings={settings} onUpdate={vi.fn()} onStatus={onStatus} />);
    await screen.findByText('No saved facts yet', { exact: false });
    fireEvent.change(screen.getByPlaceholderText(/A fact to remember/), {
      target: { value: 'I prefer terse commit messages' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save fact' }));
    await waitFor(() => {
      expect(createMemoryItem).toHaveBeenCalledWith('I prefer terse commit messages', 'core');
    });
    expect(await screen.findByText('I prefer terse commit messages')).toBeInTheDocument();
    expect(onStatus).toHaveBeenCalledWith('Saved memory');
  });

  it('lets the user save or discard a pending proposal', async () => {
    const pending = item({ id: 'p1', status: 'pending', body: 'Queued BANANA-MEMORY' });
    listMemoryItems
      .mockResolvedValueOnce([pending])
      .mockResolvedValueOnce([]);
    render(<MemorySection settings={settings} onUpdate={vi.fn()} onStatus={vi.fn()} />);
    expect(await screen.findByText('Queued BANANA-MEMORY')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(acceptMemoryItem).toHaveBeenCalledWith('p1');
    });
  });

  it('pins and deletes an active fact', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const active = item({});
    listMemoryItems.mockResolvedValue([active]);
    render(<MemorySection settings={settings} onUpdate={vi.fn()} onStatus={vi.fn()} />);
    expect(await screen.findByText('I prefer terse commit messages')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    await waitFor(() => {
      expect(updateMemoryItem).toHaveBeenCalledWith(
        'm1',
        'I prefer terse commit messages',
        'core',
        true,
      );
    });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(deleteMemoryItem).toHaveBeenCalledWith('m1');
    });
    vi.mocked(window.confirm).mockRestore();
  });
});
