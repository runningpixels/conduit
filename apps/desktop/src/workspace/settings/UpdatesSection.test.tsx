import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings } from '../../ipc/contracts';
import { UpdatesSection } from './UpdatesSection';

vi.mock('../../ipc/client', () => ({
  getUpdateStatus: vi.fn(),
  checkForUpdate: vi.fn(),
  downloadAndInstallUpdate: vi.fn(),
}));

const { getUpdateStatus, checkForUpdate } = await import('../../ipc/client');

const SETTINGS = {
  updateChannel: 'stable',
  updateCheckEnabled: true,
  updatePolicy: 'manual',
} as unknown as AppSettings;

function renderSection() {
  render(<UpdatesSection settings={SETTINGS} onUpdate={vi.fn()} onStatus={vi.fn()} />);
}

describe('UpdatesSection manual check', () => {
  beforeEach(() => {
    vi.mocked(getUpdateStatus).mockResolvedValue({
      lastChecked: 1_700_000_000,
      staged: null,
      automaticSupported: true,
    });
  });

  it('does not claim up to date before any check in this session', async () => {
    renderSection();
    await screen.findByText(/Last checked/);
    expect(screen.queryByText('You are up to date')).toBeNull();
  });

  it('shows the up-to-date message after a check finds nothing newer', async () => {
    vi.mocked(checkForUpdate).mockResolvedValue(null);
    renderSection();
    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('You are up to date')).toBeTruthy();
  });

  it('clears the message when the next check finds an update', async () => {
    vi.mocked(checkForUpdate)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ version: '9.9.9', date: null, notes: null });
    renderSection();
    const button = await screen.findByRole('button', { name: 'Check now' });
    fireEvent.click(button);
    await screen.findByText('You are up to date');
    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(screen.queryByText('You are up to date')).toBeNull());
  });
});
