import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AppSettingsView, type AppSettingsViewProps } from './AppSettingsView';

const ipc = vi.hoisted(() => ({
  appPrincipal: (id: string) => `app:${id}`,
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
}));

vi.mock('../ipc/client', () => ipc);

const baseSettings = {
  slots: { default: null, quick: null },
  dailyTokenCap: null,
  defaultDailyTokenCap: 100_000,
  cloudTokensToday: 25_000,
  usage: [
    { day: '2026-09-25', inputTokens: 0, outputTokens: 0, calls: 0 },
    { day: '2026-09-26', inputTokens: 100, outputTokens: 50, calls: 2 },
    { day: '2026-09-27', inputTokens: 0, outputTokens: 0, calls: 0 },
    { day: '2026-09-28', inputTokens: 0, outputTokens: 0, calls: 0 },
    { day: '2026-09-29', inputTokens: 0, outputTokens: 0, calls: 0 },
    { day: '2026-09-30', inputTokens: 0, outputTokens: 0, calls: 0 },
    { day: '2026-10-01', inputTokens: 20_000, outputTokens: 5_000, calls: 4 },
  ],
};

const now = new Date().toISOString();

function renderView(overrides: Partial<AppSettingsViewProps> = {}) {
  const props: AppSettingsViewProps = {
    appId: 'a1',
    appName: 'Weather',
    sites: [{ origin: 'https://api.open-meteo.com', scope: 'page' }],
    siteLabel: (o) => o.replace('https://', ''),
    onRevokeSite: vi.fn(),
    onLlmRevoked: vi.fn(),
    onClearData: vi.fn(),
    dataRevision: 0,
    onStatus: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<AppSettingsView {...props} />) };
}

beforeEach(() => {
  vi.clearAllMocks();
  ipc.getAppSettings.mockResolvedValue(baseSettings);
  ipc.setAppModelSlot.mockImplementation(async (_id, slot, choice) => ({
    ...baseSettings,
    slots: { ...baseSettings.slots, [slot]: choice },
  }));
  ipc.setAppDailyTokenCap.mockImplementation(async (_id, cap) => ({ ...baseSettings, dailyTokenCap: cap }));
  ipc.listAppActivity.mockResolvedValue([
    { at: now, kind: 'model', ok: true, providerId: 'anthropic', model: 'claude-x', inputTokens: 10, outputTokens: 5, host: null, method: null, status: null, error: null, count: 1 },
    { at: now, kind: 'fetch', ok: true, providerId: null, model: null, inputTokens: null, outputTokens: null, host: 'https://api.open-meteo.com', method: 'GET', status: 200, error: null, count: 1 },
    { at: now, kind: 'storage', ok: true, providerId: null, model: null, inputTokens: null, outputTokens: null, host: null, method: null, status: null, error: null, count: 3 },
    { at: now, kind: 'model', ok: false, providerId: null, model: null, inputTokens: null, outputTokens: null, host: null, method: null, status: null, error: 'quota', count: 1 },
  ]);
  ipc.pageStorageEntries.mockResolvedValue([
    { key: 'city', bytes: 12, updatedAt: now },
    { key: 'history', bytes: 2048, updatedAt: now },
  ]);
  ipc.exportAppDataDialog.mockResolvedValue('C:/x/weather-data.json');
  ipc.listPageLlmGrants.mockResolvedValue([
    { providerId: 'anthropic', providerName: 'Anthropic', isLocal: false, createdAt: now },
  ]);
  ipc.revokePageLlmProvider.mockResolvedValue(undefined);
  ipc.listProviderDescriptors.mockResolvedValue([
    { id: 'anthropic', displayName: 'Anthropic', defaultBaseUrl: null, credentialMode: 'required', isLocal: false, showBaseUrlField: false, tier: 1, description: null },
    { id: 'ollama', displayName: 'Ollama', defaultBaseUrl: null, credentialMode: 'none', isLocal: true, showBaseUrlField: true, tier: 2, description: null },
  ]);
  ipc.listConfiguredProviders.mockResolvedValue(['anthropic', 'ollama']);
  ipc.listProviderModels.mockImplementation(async (id: string) =>
    id === 'anthropic' ? [{ id: 'claude-x' }, { id: 'claude-y', displayName: 'Claude Y' }] : [],
  );
  ipc.getSettings.mockResolvedValue({ activeProvider: 'ollama', activeModel: 'llama3' });
});


const SLOW = { timeout: 5000 };
describe('AppSettingsView', () => {
  it('renders each section from the mocked data', async () => {
    renderView();
    for (const name of ['Model', 'Usage', 'Data', 'Permissions', 'Activity']) {
      expect(await screen.findByRole('heading', { name })).toBeTruthy();
    }
    expect(await screen.findByText('25,000 of 100,000 tokens used today')).toBeTruthy();
    expect(await screen.findByText(/in 2 keys/)).toBeTruthy();
    expect(screen.getByText('city')).toBeTruthy();
    expect(screen.getByText('api.open-meteo.com')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Revoke access to Anthropic' })).toBeTruthy();
    expect(await screen.findByRole('option', { name: 'Your active model (Ollama · llama3)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Same as Main (Ollama · llama3)' })).toBeTruthy();
  });

  it('shows empty states', async () => {
    ipc.pageStorageEntries.mockResolvedValue([]);
    ipc.listAppActivity.mockResolvedValue([]);
    ipc.listPageLlmGrants.mockResolvedValue([]);
    ipc.getAppSettings.mockResolvedValue({ ...baseSettings, usage: baseSettings.usage.map((d) => ({ ...d, inputTokens: 0, outputTokens: 0, calls: 0 })) });
    renderView({ sites: [] });
    expect(await screen.findByText('This app has not saved anything.')).toBeTruthy();
    expect(await screen.findByText('Nothing yet.')).toBeTruthy();
    expect(screen.getByText('It may not reach any site.')).toBeTruthy();
    expect(await screen.findByText('It may not use any model.')).toBeTruthy();
    expect(await screen.findByText('This app has not used a model in the last 7 days.')).toBeTruthy();
  });

  it('writes the activity rows in plain words', async () => {
    renderView();
    expect(await screen.findByText('Anthropic · claude-x · 15 tokens')).toBeTruthy();
    expect(screen.getByText('GET api.open-meteo.com → 200')).toBeTruthy();
    expect(screen.getByText('3 changes to saved data')).toBeTruthy();
    expect(screen.getByText('Model call · failed (daily limit reached)')).toBeTruthy();
  });

  it('picking a provider with listed models saves the first one for that slot', async () => {
    renderView();
    const select = await screen.findByLabelText('Main provider');
    await screen.findAllByRole('option', { name: 'Anthropic' });
    fireEvent.change(select, { target: { value: 'anthropic' } });
    await waitFor(() =>
      expect(ipc.setAppModelSlot).toHaveBeenCalledWith('a1', 'default', { providerId: 'anthropic', model: 'claude-x' }),
    );
    // Reset follows the default again.
    fireEvent.click((await screen.findAllByRole('button', { name: 'Use default' }))[0]);
    await waitFor(() => expect(ipc.setAppModelSlot).toHaveBeenLastCalledWith('a1', 'default', null));
  });

  it('offers only providers that are set up', async () => {
    ipc.listConfiguredProviders.mockResolvedValue(['ollama']);
    renderView();
    await screen.findAllByRole('option', { name: 'Ollama' });
    expect(screen.queryAllByRole('option', { name: 'Anthropic' })).toHaveLength(0);
  });

  it('a provider that lists no models asks for a model name', async () => {
    renderView();
    const select = await screen.findByLabelText('Quick provider');
    await screen.findAllByRole('option', { name: 'Ollama' });
    fireEvent.change(select, { target: { value: 'ollama' } });
    const input = await screen.findByLabelText('Quick model');
    fireEvent.change(input, { target: { value: 'phi3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Use' }));
    await waitFor(() =>
      expect(ipc.setAppModelSlot).toHaveBeenCalledWith('a1', 'quick', { providerId: 'ollama', model: 'phi3' }),
    );
  });

  // Five quick renders in a row: the 1 s default waits and the 5 s test timeout both flaked on a loaded CI runner.
  it('validates the daily limit before calling Rust', async () => {
    renderView();
    const input = await screen.findByLabelText('Daily limit for cloud models (tokens)', undefined, SLOW);
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    expect(await screen.findByText('Enter a whole number between 1,000 and 10,000,000.', undefined, SLOW)).toBeTruthy();
    expect(ipc.setAppDailyTokenCap).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '10000001' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    expect(ipc.setAppDailyTokenCap).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: '50000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limit' }));
    await waitFor(() => expect(ipc.setAppDailyTokenCap).toHaveBeenCalledWith('a1', 50000), SLOW);

    fireEvent.click(await screen.findByRole('button', { name: 'Reset to default' }, SLOW));
    await waitFor(() => expect(ipc.setAppDailyTokenCap).toHaveBeenLastCalledWith('a1', null), SLOW);
  }, 20_000);

  it('exports, clears and revokes through the right commands', async () => {
    const { props } = renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Export data' }));
    await waitFor(() => expect(ipc.exportAppDataDialog).toHaveBeenCalledWith('a1'));
    await waitFor(() => expect(props.onStatus).toHaveBeenCalledWith('Saved to C:/x/weather-data.json'));

    fireEvent.click(await screen.findByRole('button', { name: 'Clear data' }));
    expect(props.onClearData).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Revoke access to api.open-meteo.com' }));
    expect(props.onRevokeSite).toHaveBeenCalledWith('https://api.open-meteo.com');

    fireEvent.click(await screen.findByRole('button', { name: 'Revoke access to Anthropic' }));
    await waitFor(() => expect(ipc.revokePageLlmProvider).toHaveBeenCalledWith('app:a1', 'anthropic'));
    await waitFor(() => expect(props.onLlmRevoked).toHaveBeenCalled());
  });

  it('Escape goes back to the app and does not bubble', async () => {
    const outer = vi.fn();
    const { props } = renderView();
    document.addEventListener('keydown', outer);
    const region = await screen.findByRole('region', { name: /settings/i });
    fireEvent.keyDown(within(region).getByRole('button', { name: 'Back to app' }), { key: 'Escape' });
    expect(props.onBack).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    document.removeEventListener('keydown', outer);
  });
});
