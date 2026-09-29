import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SettingsPatch } from '../ipc/contracts';

const ipc = vi.hoisted(() => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getStartAtLogin: vi.fn(),
  setStartAtLogin: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

import { BackgroundSection } from './BackgroundSection';

let stored = { closeToTray: false, closeToTrayOffered: false };

beforeEach(() => {
  vi.clearAllMocks();
  stored = { closeToTray: false, closeToTrayOffered: false };
  ipc.getSettings.mockImplementation(async () => ({ ...stored }));
  ipc.updateSettings.mockImplementation(async (patch: SettingsPatch) => {
    stored = {
      closeToTray: patch.closeToTray ?? stored.closeToTray,
      closeToTrayOffered: patch.closeToTrayOffered ?? stored.closeToTrayOffered,
    };
    return { ...stored };
  });
  ipc.getStartAtLogin.mockResolvedValue(false);
  ipc.setStartAtLogin.mockImplementation(async (enabled: boolean) => enabled);
});

describe('BackgroundSection', () => {
  it('says nothing about the tray until something is scheduled', async () => {
    render(<BackgroundSection scheduleEnabled={false} onStatus={vi.fn()} />);
    expect(await screen.findByText(/Scheduled runs happen while Conduit is open/)).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /running in the tray/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('offers the tray once, the first time a schedule is on, and accepting switches it on', async () => {
    render(<BackgroundSection scheduleEnabled onStatus={vi.fn()} />);
    const offer = await screen.findByRole('group', { name: 'Keep Conduit running in the tray?' });
    expect(offer).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep running in the tray' }));
    await waitFor(() => expect(ipc.updateSettings).toHaveBeenCalledWith({ closeToTray: true, closeToTrayOffered: true }));
    expect(await screen.findByRole('checkbox', { name: 'Keep running in the tray when the window is closed' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Start Conduit in the tray when I sign in' })).toBeEnabled();
    expect(screen.getByText(/To quit, use the tray icon's menu/)).toBeInTheDocument();
  });

  it('"Not now" records the answer and leaves the switch off, not the offer', async () => {
    render(<BackgroundSection scheduleEnabled onStatus={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(ipc.updateSettings).toHaveBeenCalledWith({ closeToTrayOffered: true }));
    const tray = await screen.findByRole('checkbox', { name: 'Keep running in the tray when the window is closed' });
    expect(tray).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Start Conduit in the tray when I sign in' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Not now' })).not.toBeInTheDocument();
  });

  it('starts at sign-in only with the tray on, and turning the tray off turns it off', async () => {
    stored = { closeToTray: true, closeToTrayOffered: true };
    render(<BackgroundSection scheduleEnabled={false} onStatus={vi.fn()} />);
    const start = await screen.findByRole('checkbox', { name: 'Start Conduit in the tray when I sign in' });
    fireEvent.click(start);
    await waitFor(() => expect(ipc.setStartAtLogin).toHaveBeenCalledWith(true));
    await waitFor(() => expect(start).toBeChecked());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep running in the tray when the window is closed' }));
    await waitFor(() => expect(ipc.updateSettings).toHaveBeenCalledWith({ closeToTray: false, closeToTrayOffered: true }));
    await waitFor(() => expect(start).not.toBeChecked());
    expect(start).toBeDisabled();
  });

  it('leaves out the sign-in switch where it is unavailable, and reports a failed change', async () => {
    stored = { closeToTray: true, closeToTrayOffered: true };
    ipc.getStartAtLogin.mockRejectedValue(new Error('unsupported'));
    ipc.updateSettings.mockRejectedValue({ message: 'disk full' });
    const onStatus = vi.fn();
    render(<BackgroundSection scheduleEnabled onStatus={onStatus} />);
    const tray = await screen.findByRole('checkbox', { name: 'Keep running in the tray when the window is closed' });
    expect(screen.queryByRole('checkbox', { name: /sign in/ })).not.toBeInTheDocument();
    fireEvent.click(tray);
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith("Couldn't change that setting: disk full"));
    expect(tray).toBeChecked();
  });
});
