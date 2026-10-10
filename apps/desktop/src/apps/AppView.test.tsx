import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppView } from './AppView';
import { ARTIFACT_BLOCKED_LOAD_MESSAGE_TYPE } from '../artifacts/blockedLoads';

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
  pageLlmState: vi.fn(),
  grantPageLlm: vi.fn(),
  revokePageLlm: vi.fn(),
  pageLlmComplete: vi.fn(),
  getAppSettings: vi.fn(),
  setAppModelSlot: vi.fn(),
  setAppDailyTokenCap: vi.fn(),
  listAppActivity: vi.fn(),
  pageStorageEntries: vi.fn(),
  exportAppDataDialog: vi.fn(),
  listPageLlmGrants: vi.fn(),
  revokePageLlmProvider: vi.fn(),
  listProviderDescriptors: vi.fn(),
  listConfiguredProviders: vi.fn(),
  listProviderModels: vi.fn(),
  getSettings: vi.fn(),
  appPrincipal: (id: string) => `app:${id}`,
}));

vi.mock('../ipc/client', () => ipc);
const site = vi.hoisted(() => ({
  clearPageSiteData: vi.fn(async () => true),
  sweepPageSiteData: vi.fn(async () => {}),
}));
vi.mock('../artifacts/pageSiteData', () => site);

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
  ipc.getAppSettings.mockResolvedValue({
    slots: { default: null, quick: null },
    dailyTokenCap: null,
    defaultDailyTokenCap: 100_000,
    cloudTokensToday: 0,
    usage: [],
  });
  ipc.listAppActivity.mockResolvedValue([]);
  ipc.pageStorageEntries.mockResolvedValue([]);
  ipc.listPageLlmGrants.mockResolvedValue([]);
  ipc.listProviderDescriptors.mockResolvedValue([]);
  ipc.listConfiguredProviders.mockResolvedValue([]);
  ipc.getSettings.mockResolvedValue({ activeProvider: 'ollama', activeModel: 'llama3' });
  ipc.getArtifactNetworkState.mockResolvedValue({ blockedReason: null, always: [], session: [] });
  ipc.pageLlmState.mockResolvedValue({
    providerId: 'anthropic',
    providerName: 'Anthropic',
    isLocal: false,
    blockedReason: null,
    granted: null,
  });
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

describe('AppView model access (ADR-014)', () => {
  it('has no strip fact and no revoke menu item before access is granted', async () => {
    ipc.openApp.mockResolvedValue({ ...weatherApp, inputs: [], inputsMissing: false });
    ipc.getAppInputs.mockResolvedValue({});
    renderAppView();

    await screen.findByRole('heading', { name: 'Weather dashboard' });
    expect(screen.queryByText('Uses your AI model')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'App actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Stop model access' })).toBeNull();
  });

  it('shows a strip fact once the reader granted model access', async () => {
    ipc.openApp.mockResolvedValue({ ...weatherApp, inputs: [], inputsMissing: false });
    ipc.getAppInputs.mockResolvedValue({});
    ipc.pageLlmState.mockResolvedValue({
      providerId: 'anthropic',
      providerName: 'Anthropic',
      isLocal: false,
      blockedReason: null,
      granted: 'always',
    });
    renderAppView();

    expect(await screen.findByText('Uses your AI model')).toBeInTheDocument();
  });

  it('"Stop model access" in the ⋯ menu revokes the grant', async () => {
    ipc.openApp.mockResolvedValue({ ...weatherApp, inputs: [], inputsMissing: false });
    ipc.getAppInputs.mockResolvedValue({});
    ipc.pageLlmState.mockResolvedValue({
      providerId: 'anthropic',
      providerName: 'Anthropic',
      isLocal: false,
      blockedReason: null,
      granted: 'always',
    });
    renderAppView();

    await screen.findByText('Uses your AI model');
    fireEvent.click(screen.getByRole('button', { name: 'App actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stop model access' }));
    await waitFor(() => expect(ipc.revokePageLlm).toHaveBeenCalledWith('app:a1'));
  });

  it('the ⋯ menu and the gear open Settings; the app frame stays mounted while it is open', async () => {
    ipc.openApp.mockResolvedValue({ ...weatherApp, inputs: [], inputsMissing: false });
    ipc.getAppInputs.mockResolvedValue({});
    const { container } = renderAppView();

    await screen.findByRole('button', { name: 'App actions' });
    fireEvent.click(screen.getByRole('button', { name: 'App actions' }));
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));

    expect(await screen.findByRole('heading', { name: 'Weather dashboard settings' })).toBeInTheDocument();
    const frame = container.querySelector('.app-view-frame') as HTMLElement;
    expect(frame).not.toBeNull();
    expect(frame.hidden).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Back to app' }));
    expect(screen.queryByRole('heading', { name: 'Weather dashboard settings' })).toBeNull();
    expect(frame.hidden).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('heading', { name: 'Weather dashboard settings' })).toBeInTheDocument();
  });
});

describe('AppView full web access (ADR-007)', () => {
  it('offers full access for what the page could not load; allowing restarts it with the full policy', async () => {
    ipc.openApp.mockResolvedValue({ ...weatherApp, inputs: [], inputsMissing: false });
    ipc.getAppInputs.mockResolvedValue({});
    ipc.grantArtifactNetwork.mockResolvedValue(undefined);
    const { container } = renderAppView();
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    expect(container.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts');

    // The frame may be re-created while the page settles (slow CI), and the
    // host only trusts messages from the current frame: report from whichever
    // frame is mounted until the banner shows.
    const banner = await waitFor(() => {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { type: ARTIFACT_BLOCKED_LOAD_MESSAGE_TYPE, directive: 'script-src-elem', origin: 'https://cdn.jsdelivr.net' },
            source: container.querySelector('iframe')!.contentWindow,
          }),
        );
      });
      return screen.getByText(/This page wants full web access/);
    });
    expect(banner.textContent).toContain('scripts from cdn.jsdelivr.net');
    fireEvent.click(screen.getAllByRole('button', { name: 'Review' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'Allow full web access' }));

    await waitFor(() => expect(ipc.grantArtifactNetwork).toHaveBeenCalledWith('app:a1', 'full', 'page'));
    await waitFor(() => expect(container.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts allow-modals'));
    expect(container.querySelector('iframe')!.getAttribute('srcdoc')).toContain("script-src 'unsafe-inline' https:");
    expect(screen.queryByText(/This page wants full web access/)).toBeNull();
  });

  it('loads a page that already has full access once, straight into the full policy', async () => {
    ipc.openApp.mockResolvedValue({ ...weatherApp, inputs: [], inputsMissing: false });
    ipc.getAppInputs.mockResolvedValue({});
    ipc.getArtifactNetworkState.mockResolvedValue({ blockedReason: null, always: ['full'], session: [], fullAccess: true });
    const { container } = renderAppView();
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    expect(container.querySelector('iframe')!.getAttribute('sandbox')).toBe('allow-scripts allow-modals');
  });
});

describe('AppView site data (ADR-007)', () => {
  it('"Clear site data" is offered only with full web access, asks first, then clears and reloads', async () => {
    ipc.openApp.mockResolvedValue({ ...weatherApp, inputs: [], inputsMissing: false });
    ipc.getAppInputs.mockResolvedValue({});
    ipc.getArtifactNetworkState.mockResolvedValue({ blockedReason: null, always: ['full'], session: [], fullAccess: true });
    const onStatus = vi.fn();
    const { container } = renderAppView({ onStatus });
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    const before = container.querySelector('iframe');

    fireEvent.click(screen.getByRole('button', { name: 'App actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Clear site data' }));
    expect(site.clearPageSiteData).not.toHaveBeenCalled();
    expect(await screen.findByText('Clear “Weather dashboard”’s site data?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => expect(site.clearPageSiteData).toHaveBeenCalledWith('app:a1'));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('Cleared “Weather dashboard”’s site data.'));
    // The frame starts over.
    await waitFor(() => expect(container.querySelector('iframe')).not.toBe(before));
  });

  it('has no "Clear site data" without full web access', async () => {
    ipc.openApp.mockResolvedValue({ ...weatherApp, inputs: [], inputsMissing: false });
    ipc.getAppInputs.mockResolvedValue({});
    const { container } = renderAppView();
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'App actions' }));
    expect(screen.queryByRole('menuitem', { name: 'Clear site data' })).toBeNull();
  });
});
