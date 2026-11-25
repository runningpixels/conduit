import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StandaloneAppRoot } from './StandaloneAppRoot';

const ipc = vi.hoisted(() => ({
  getSettings: vi.fn(),
  listApps: vi.fn(),
  deleteApp: vi.fn(),
  showAppInMain: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

// A stand-in AppView: the root's job is the wiring around it.
const view = vi.hoisted(() => ({ props: null as null | Record<string, unknown> }));
vi.mock('./AppView', () => ({
  AppView: (props: Record<string, unknown>) => {
    view.props = props;
    return <div data-testid="app-view">{`rev ${props.revision as number}`}</div>;
  },
}));
vi.mock('./AppDetailsDialog', () => ({ AppDetailsDialog: () => null }));
vi.mock('../artifacts/pageSiteData', () => ({ sweepPageSiteData: vi.fn(async () => {}) }));

const events = vi.hoisted(() => ({ handler: null as null | ((e: { payload: unknown }) => void) }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: unknown }) => void) => {
    events.handler = cb;
    return () => {};
  }),
}));

const settings = {
  theme: 'dark',
  localOnly: true,
  artifactNetworkEnabled: true,
  artifactRemoteAllowlist: ['example.com'],
  artifactStyledPreview: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  events.handler = null;
  ipc.getSettings.mockResolvedValue(settings);
  ipc.listApps.mockResolvedValue([{ id: 'a1', name: 'Weather' }]);
});

describe('StandaloneAppRoot', () => {
  it('renders the app view in standalone mode with the settings-derived props', async () => {
    render(<StandaloneAppRoot appId="a1" />);
    await screen.findByTestId('app-view');
    expect(view.props).toMatchObject({
      standalone: true,
      appId: 'a1',
      allowlist: ['example.com'],
      styledPreview: true,
      colorScheme: 'dark',
      networkPolicyKey: 'true:true:false',
    });
    await waitFor(() => expect(document.title).toBe('Weather'));
  });

  it('an update bumps the revision; events for other apps are ignored', async () => {
    render(<StandaloneAppRoot appId="a1" />);
    await screen.findByText('rev 0');
    await waitFor(() => expect(events.handler).not.toBeNull());
    act(() => events.handler?.({ payload: { id: 'other', kind: 'updated' } }));
    expect(screen.getByText('rev 0')).toBeTruthy();
    act(() => events.handler?.({ payload: { id: 'a1', kind: 'updated' } }));
    await screen.findByText('rev 1');
  });

  it('a delete shows the removed state with a Close button', async () => {
    render(<StandaloneAppRoot appId="a1" />);
    await screen.findByTestId('app-view');
    await waitFor(() => expect(events.handler).not.toBeNull());
    act(() => events.handler?.({ payload: { id: 'a1', kind: 'deleted' } }));
    expect(await screen.findByText('This app was removed from Conduit.')).toBeTruthy();
    expect(screen.queryByTestId('app-view')).toBeNull();
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  });
});
