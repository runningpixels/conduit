import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppView } from './AppView';

const ipc = vi.hoisted(() => ({
  openApp: vi.fn(),
  getAppInputs: vi.fn(),
  setAppInputs: vi.fn(),
  getArtifactNetworkState: vi.fn(),
  grantArtifactNetwork: vi.fn(),
  revokeArtifactNetworkGrant: vi.fn(),
  artifactFetch: vi.fn(),
  openExternalUrl: vi.fn(),
  pageStorageUsage: vi.fn(),
  pageStorageClear: vi.fn(),
  appPrincipal: (id: string) => `app:${id}`,
}));

vi.mock('../ipc/client', () => ipc);

const weatherApp = {
  id: 'a1',
  name: 'Weather dashboard',
  description: undefined,
  icon: undefined,
  category: 'live-data',
  version: '1.0.0',
  origin: 'saved',
  hosts: [],
  storage: false,
  sourceArtifactId: undefined,
  sourceChanged: false,
  lastOpenedAt: undefined,
  createdAt: '2026-09-29T08:00:00Z',
  updatedAt: '2026-09-29T08:00:00Z',
  html: '<p>weather</p>',
  inputs: [{ id: 'city', label: 'City', type: 'string' as const, required: true }],
  inputsMissing: true,
};

function renderAppView(overrides: Partial<Parameters<typeof AppView>[0]> = {}) {
  return render(
    <AppView
      appId="a1"
      allowlist={[]}
      styledPreview={false}
      colorScheme="dark"
      revision={0}
      onBack={vi.fn()}
      onEdit={vi.fn()}
      onUpdateFromSource={vi.fn()}
      onDelete={vi.fn()}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  ipc.getArtifactNetworkState.mockResolvedValue({ blockedReason: null, always: [], session: [] });
});

describe('AppView launch inputs (ADR-013)', () => {
  it('auto-opens the inputs dialog once, when the app is missing a required input', async () => {
    ipc.openApp.mockResolvedValue(weatherApp);
    ipc.getAppInputs.mockResolvedValue({});
    renderAppView();

    const dialog = await screen.findByRole('dialog', { name: 'App inputs' });
    expect(dialog).toBeTruthy();
    expect(screen.getByLabelText('City Required')).toBeTruthy();
  });

  it('does not auto-open when nothing is missing, and shows the Inputs button', async () => {
    ipc.openApp.mockResolvedValue({ ...weatherApp, inputsMissing: false });
    ipc.getAppInputs.mockResolvedValue({ city: 'Paris' });
    renderAppView();

    const inputsButton = await screen.findByRole('button', { name: 'Inputs' });
    expect(screen.queryByRole('dialog', { name: 'App inputs' })).toBeNull();

    fireEvent.click(inputsButton);
    expect(await screen.findByRole('dialog', { name: 'App inputs' })).toBeTruthy();
    expect((screen.getByLabelText('City Required') as HTMLInputElement).value).toBe('Paris');
  });

  it('has no Inputs button and no dialog for an app that declares none', async () => {
    ipc.openApp.mockResolvedValue({ ...weatherApp, inputs: [], inputsMissing: false });
    ipc.getAppInputs.mockResolvedValue({});
    renderAppView();

    await screen.findByRole('heading', { name: 'Weather dashboard' });
    expect(screen.queryByRole('button', { name: 'Inputs' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'App inputs' })).toBeNull();
  });
});
