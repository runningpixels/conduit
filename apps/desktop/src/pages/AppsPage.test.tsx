import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AppSummary } from '../ipc/contracts';
import { AppsPage } from './AppsPage';
import { AppDetailsDialog } from '../apps/AppDetailsDialog';
import { YourAppsRow } from '../apps/YourAppsRow';
import { defaultMark } from '../apps/AppTile';

const ipc = vi.hoisted(() => ({
  listApps: vi.fn(),
  openApp: vi.fn(),
  saveApp: vi.fn(),
  updateApp: vi.fn(),
  updateAppFromArtifact: vi.fn(),
  deleteApp: vi.fn(),
  getArtifact: vi.fn(),
  getArtifactContentBytes: vi.fn(),
  getArtifactNetworkState: vi.fn(),
  grantArtifactNetwork: vi.fn(),
  revokeArtifactNetworkGrant: vi.fn(),
  artifactFetch: vi.fn(),
  openExternalUrl: vi.fn(),
  artifactPrincipal: (id: string) => `artifact:${id}`,
  appPrincipal: (id: string) => `app:${id}`,
}));

vi.mock('../ipc/client', () => ipc);

const weather: AppSummary = {
  id: 'a1',
  name: 'Lisbon weather',
  description: 'Seven days for one city',
  icon: '18°',
  category: 'live-data',
  version: '1.0.0',
  origin: 'saved',
  hosts: ['https://api.open-meteo.com'],
  sourceArtifactId: 'art-1',
  sourceChanged: true,
  lastOpenedAt: undefined,
  createdAt: '2026-09-29T08:00:00Z',
  updatedAt: '2026-09-29T08:00:00Z',
};

const timer: AppSummary = {
  ...weather,
  id: 'a2',
  name: 'Pomodoro timer',
  description: undefined,
  icon: undefined,
  category: 'tools',
  hosts: [],
  sourceChanged: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  ipc.listApps.mockResolvedValue([weather, timer]);
  ipc.getArtifactNetworkState.mockResolvedValue({ blockedReason: null, always: [], session: [] });
});

describe('AppsPage', () => {
  it('lists saved apps with what they reach, and offers an update when the source changed', async () => {
    render(
      <AppsPage openAppId={null} onOpenAppIdChange={vi.fn()} allowlist={[]} styledPreview={false} colorScheme="dark" />,
    );
    const grid = await screen.findByRole('list');
    const cards = within(grid).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText('Lisbon weather')).toBeTruthy();
    expect(within(cards[0]).getByText('api.open-meteo.com')).toBeTruthy();
    expect(within(cards[0]).getByRole('button', { name: 'Update' })).toBeTruthy();
    expect(within(cards[1]).getByText('No internet')).toBeTruthy();
    expect(within(cards[1]).queryByRole('button', { name: 'Update' })).toBeNull();
  });

  it('opens an app from its card', async () => {
    const onOpen = vi.fn();
    render(<AppsPage openAppId={null} onOpenAppIdChange={onOpen} allowlist={[]} styledPreview={false} colorScheme="dark" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Pomodoro timer' }));
    expect(onOpen).toHaveBeenCalledWith('a2');
  });

  it('explains how to save one when there are none', async () => {
    ipc.listApps.mockResolvedValue([]);
    render(<AppsPage openAppId={null} onOpenAppIdChange={vi.fn()} allowlist={[]} styledPreview={false} colorScheme="dark" />);
    expect(await screen.findByText('No apps yet')).toBeTruthy();
  });

  it('updates from the source page with the hosts that page declares', async () => {
    ipc.getArtifact.mockResolvedValue({
      contentText: '<meta name="conduit-network" content="https://api.github.com — profiles"><p>v2</p>',
    });
    ipc.updateAppFromArtifact.mockResolvedValue({ ...weather, version: '1.1.0', sourceChanged: false });
    const onStatus = vi.fn();
    render(
      <AppsPage
        openAppId={null}
        onOpenAppIdChange={vi.fn()}
        allowlist={[]}
        styledPreview={false}
        colorScheme="dark"
        onStatus={onStatus}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    await waitFor(() => expect(ipc.updateAppFromArtifact).toHaveBeenCalledWith('a1', ['https://api.github.com']));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith('Updated “Lisbon weather” to v1.1.0.'));
  });

  it('shows an open app between a header and a status strip, and deletes it after confirming', async () => {
    ipc.openApp.mockResolvedValue({ ...timer, html: '<p>25:00</p>' });
    ipc.deleteApp.mockResolvedValue(undefined);
    const onOpen = vi.fn();
    render(<AppsPage openAppId="a2" onOpenAppIdChange={onOpen} allowlist={[]} styledPreview={false} colorScheme="dark" />);
    expect(await screen.findByRole('heading', { name: 'Pomodoro timer' })).toBeTruthy();
    expect(screen.getByText('Works without the internet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'App actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete app' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(ipc.deleteApp).toHaveBeenCalledWith('a2'));
    expect(onOpen).toHaveBeenCalledWith(null);
  });
});

describe('AppDetailsDialog', () => {
  it('saves a page, keeping only the access the user ticks', async () => {
    ipc.getArtifactNetworkState.mockResolvedValue({
      blockedReason: null,
      always: ['https://api.open-meteo.com', 'https://api.github.com'],
      session: [],
    });
    ipc.saveApp.mockResolvedValue(weather);
    const onSaved = vi.fn();
    const html =
      '<meta name="conduit-network" content="https://geocoding-api.open-meteo.com — find the city"><p>hi</p>';
    render(
      <AppDetailsDialog
        target={{ mode: 'save', artifactId: 'art-1', title: 'Lisbon weather', html }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Lisbon weather');
    const keep = await screen.findByRole('checkbox', { name: 'Keep access to api.open-meteo.com' });
    expect((keep as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText('geocoding-api.open-meteo.com: asks the first time the app connects')).toBeTruthy();
    fireEvent.click(keep);
    fireEvent.click(screen.getByRole('button', { name: 'Save app' }));
    await waitFor(() =>
      expect(ipc.saveApp).toHaveBeenCalledWith(
        'art-1',
        { name: 'Lisbon weather', icon: null, description: null, category: 'live-data' },
        ['https://geocoding-api.open-meteo.com'],
        ['https://api.open-meteo.com'],
      ),
    );
    expect(onSaved).toHaveBeenCalledWith(weather, 'save');
  });

  it('shows why a save failed and stays open', async () => {
    ipc.saveApp.mockRejectedValue(new Error('This page is too large to save as an app (5 MB at most).'));
    const onSaved = vi.fn();
    render(
      <AppDetailsDialog
        target={{ mode: 'save', artifactId: 'art-1', title: 'Big', html: '<p>x</p>' }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save app' }));
    expect((await screen.findByRole('alert')).textContent).toContain('too large');
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('closes on Escape before the document panel sees it', () => {
    const onClose = vi.fn();
    const panelEscape = vi.fn();
    document.addEventListener('keydown', panelEscape);
    render(
      <AppDetailsDialog target={{ mode: 'edit', app: timer }} onClose={onClose} onSaved={vi.fn()} />,
    );
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(panelEscape).not.toHaveBeenCalled();
    document.removeEventListener('keydown', panelEscape);
  });
});

describe('YourAppsRow', () => {
  it('shows nothing without apps, and opens one with a click', () => {
    const { container, rerender } = render(<YourAppsRow apps={[]} onOpen={vi.fn()} onAll={vi.fn()} />);
    expect(container.textContent).toBe('');
    const onOpen = vi.fn();
    const onAll = vi.fn();
    rerender(<YourAppsRow apps={[weather, timer]} onOpen={onOpen} onAll={onAll} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Lisbon weather' }));
    fireEvent.click(screen.getByRole('button', { name: /All apps/ }));
    expect(onOpen).toHaveBeenCalledWith('a1');
    expect(onAll).toHaveBeenCalled();
  });
});

describe('defaultMark', () => {
  it('takes initials, or the start of a single word', () => {
    expect(defaultMark('Lisbon weather')).toBe('Lw');
    expect(defaultMark('snake')).toBe('Sn');
    expect(defaultMark('   ')).toBe('·');
  });
});
