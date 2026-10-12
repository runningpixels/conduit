import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AppSummary } from '../ipc/contracts';
import { AppsHomePage, type AppsHomePageProps } from './AppsHomePage';

function app(id: string, name: string, extra: Partial<AppSummary> = {}): AppSummary {
  return { id, name, description: null, icon: null, category: 'tools', hosts: [], ...extra } as unknown as AppSummary;
}

const APPS = [
  app('a1', 'World weather', {
    icon: '☀',
    category: 'live-data',
    description: 'Weather in eight cities',
    hosts: ['api.open-meteo.com'],
    lastOpenedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
  }),
  app('a2', 'Pomodoro', { icon: '25:00', llm: true }),
  app('a3', 'Habit tracker'),
];

function renderHome(props: Partial<AppsHomePageProps> = {}) {
  const handlers = { onOpen: vi.fn(), onNewApp: vi.fn(), onManage: vi.fn() };
  render(<AppsHomePage apps={APPS} {...handlers} {...props} />);
  return handlers;
}

describe('AppsHomePage', () => {
  it('shows every app as a tile with its name, in the order given', () => {
    renderHome();
    const grid = screen.getByRole('list', { name: 'Your apps' });
    const names = within(grid)
      .getAllByRole('button')
      .map((b) => b.querySelector('.apps-home-name')?.textContent);
    expect(names).toEqual(['World weather', 'Pomodoro', 'Habit tracker']);
    // The tile is the app's own mark, or its initials when it has none.
    expect(within(grid).getByRole('button', { name: /World weather/ }).querySelector('.app-tile')?.textContent).toBe('☀');
    expect(within(grid).getByRole('button', { name: /Habit tracker/ }).querySelector('.app-tile')?.textContent).toBe('Ht');
  });

  it('says what each app is: kind, when it was opened, what it does, what it uses', () => {
    renderHome();
    const weather = within(screen.getByRole('list', { name: 'Your apps' })).getByRole('button', { name: 'World weather' });
    expect(weather.querySelector('.apps-home-meta')?.textContent).toBe('Live data · Opened 2h ago');
    expect(weather.querySelector('.apps-home-desc')?.textContent).toBe('Weather in eight cities');
    expect([...weather.querySelectorAll('.apps-home-trait')].map((el) => el.textContent)).toEqual(['Uses the internet, asks first']);

    const pomodoro = within(screen.getByRole('list', { name: 'Your apps' })).getByRole('button', { name: 'Pomodoro' });
    expect(pomodoro.querySelector('.apps-home-meta')?.textContent).toBe('Tools · Not opened yet');
    expect(pomodoro.querySelector('.apps-home-desc')).toBeNull();
    expect([...pomodoro.querySelectorAll('.apps-home-trait')].map((el) => el.textContent)).toEqual([
      'Works without the internet',
      'Uses your AI model',
    ]);
  });

  it('opens an app on click', () => {
    const { onOpen } = renderHome();
    fireEvent.click(screen.getByRole('button', { name: /Pomodoro/ }));
    expect(onOpen).toHaveBeenCalledWith('a2');
  });

  it('filters by name as you type, and Enter opens the first match', () => {
    const { onOpen } = renderHome();
    const search = screen.getByRole('searchbox', { name: 'Search your apps' });
    fireEvent.change(search, { target: { value: 'HAB' } });
    expect(screen.getAllByRole('button', { name: /Habit tracker|World weather|Pomodoro/ })).toHaveLength(1);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledWith('a3');
  });

  it('says so when nothing matches', () => {
    renderHome();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'chess' } });
    expect(screen.getByText('No apps match “chess”.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Your apps' })).toBeNull();
  });

  it('starts a new app and goes to Manage from the header', () => {
    const { onNewApp, onManage } = renderHome();
    fireEvent.click(screen.getByRole('button', { name: 'New app' }));
    expect(onNewApp).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    expect(onManage).toHaveBeenCalledOnce();
  });

  it('points an empty home screen at the starter apps in Manage', () => {
    const { onManage } = renderHome({ apps: [] });
    expect(screen.getByText('No apps yet')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Browse starter apps' }));
    expect(onManage).toHaveBeenCalledOnce();
  });
});
