import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InstallAppDialog } from './InstallAppDialog';

const ipc = vi.hoisted(() => ({ installApp: vi.fn(), appInstallStatus: vi.fn() }));
vi.mock('../ipc/client', () => ipc);
const icons = vi.hoisted(() => ({ renderAppIconImages: vi.fn() }));
vi.mock('./appIconImages', () => icons);

const app = { id: 'a1', name: 'Weather dashboard', icon: '☀', category: 'live-data' as const };
const status = { appId: 'a1', installed: true, desktopShortcut: true, place: 'startMenu' as const };

beforeEach(() => {
  vi.clearAllMocks();
  icons.renderAppIconImages.mockResolvedValue([{ size: 16, pngBase64: 'QUJD' }]);
  ipc.installApp.mockResolvedValue(status);
});

function renderDialog(place: 'startMenu' | 'applications' | 'appMenu' | 'unsupported', onInstalled = vi.fn()) {
  render(<InstallAppDialog app={app} place={place} onClose={vi.fn()} onInstalled={onInstalled} />);
  return onInstalled;
}

describe('InstallAppDialog', () => {
  it('says where it will appear, by place', () => {
    renderDialog('startMenu');
    expect(screen.getByText(/Start menu › .* Apps/)).toBeTruthy();
  });

  it('Applications on macOS, with no desktop shortcut option', () => {
    renderDialog('applications');
    expect(screen.getByText(/Applications › .* Apps/)).toBeTruthy();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('app menu on Linux', () => {
    renderDialog('appMenu');
    expect(screen.getByText('It will appear in your app menu.')).toBeTruthy();
    expect(screen.getByRole('checkbox')).toBeTruthy();
  });

  it('the desktop shortcut is on by default and sent with the install', async () => {
    const onInstalled = renderDialog('startMenu');
    const box = screen.getByRole('checkbox', { name: 'Also add a shortcut to the desktop' }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(ipc.installApp).toHaveBeenCalledWith('a1', [{ size: 16, pngBase64: 'QUJD' }], true));
    await waitFor(() => expect(onInstalled).toHaveBeenCalledWith(app, status));
  });

  it('unticking the shortcut sends false', async () => {
    renderDialog('startMenu');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(ipc.installApp).toHaveBeenCalledWith('a1', expect.anything(), false));
  });

  it('applications never sends a desktop shortcut', async () => {
    renderDialog('applications');
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(ipc.installApp).toHaveBeenCalledWith('a1', expect.anything(), false));
  });

  it('an install error stays in the dialog', async () => {
    ipc.installApp.mockRejectedValue(new Error('Could not write the shortcut'));
    const onInstalled = renderDialog('startMenu');
    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Could not write the shortcut');
    expect(onInstalled).not.toHaveBeenCalled();
  });
});
