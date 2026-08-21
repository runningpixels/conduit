import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { MigrationRecoveryInfo } from '../ipc/contracts';
import { MigrationRecoveryNotice } from './Onboarding';

/// The recovery screen is the one place in the app with no escape hatch behind
/// it: if its buttons do not work, the user cannot reach the workspace at all.
/// Its single "Restart" button used to call `window.location.reload()`, which
/// reloads the webview but leaves the Rust process — and the startup-captured
/// `migration_recovery` — untouched, so the dialog rendered again on every
/// reload. These tests pin each exit down to the IPC call it must make.
vi.mock('../ipc/client', () => ({
  acknowledgeMigrationRecovery: vi.fn().mockResolvedValue(undefined),
  discardMigrationBackup: vi.fn().mockResolvedValue({ removedPaths: [], freedBytes: 0 }),
  requestLocalDataWipe: vi.fn().mockResolvedValue({ requiresRestart: true, estimatedBytes: 0 }),
  restartApp: vi.fn().mockResolvedValue(undefined),
  getOnboardingState: vi.fn(),
  updateSettings: vi.fn(),
  listProviderModels: vi.fn().mockResolvedValue([]),
  listProviderDescriptors: vi.fn().mockResolvedValue([]),
  loadProviderCredentialReference: vi.fn().mockResolvedValue({
    providerId: 'anthropic',
    credentialRef: 'keychain://conduit/anthropic',
    storedInKeychain: false,
  }),
  saveProviderCredential: vi.fn(),
  validateProviderCredentials: vi.fn(),
  getConnectorRuntimeStates: vi.fn().mockResolvedValue([]),
  listConnectorCapabilities: vi.fn().mockResolvedValue([]),
  listConnectorGrants: vi.fn().mockResolvedValue([]),
  discoverConnector: vi.fn().mockResolvedValue([]),
  startConnector: vi.fn(),
  stopConnector: vi.fn(),
  revokeConnectorGrant: vi.fn(),
  addLocalConnector: vi.fn(),
}));

import {
  acknowledgeMigrationRecovery,
  discardMigrationBackup,
  requestLocalDataWipe,
  restartApp,
} from '../ipc/client';

const recovery: MigrationRecoveryInfo = {
  backupPath: 'C:\\Users\\x\\AppData\\Local\\Conduit\\Conduit\\data\\conduit.sqlite.corrupt-1787026415.bak',
  error: 'migration failed: migration 1 was previously applied but has been modified',
  backupExists: true,
  backupBytes: 2_621_440,
};

function renderNotice(overrides: Partial<MigrationRecoveryInfo> = {}) {
  const onStatus = vi.fn();
  const onDismissed = vi.fn();
  render(
    <MigrationRecoveryNotice
      recovery={{ ...recovery, ...overrides }}
      onStatus={onStatus}
      onDismissed={onDismissed}
    />,
  );
  return { onStatus, onDismissed };
}

function openDeletePanel() {
  fireEvent.click(screen.getByRole('button', { name: /Delete data/i }));
}

describe('MigrationRecoveryNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the backup path and the underlying migration error', () => {
    renderNotice();
    expect(screen.getByText(recovery.backupPath)).toBeTruthy();
    expect(screen.getByText(recovery.error)).toBeTruthy();
  });

  it('"Continue" clears the recovery state in the backend, not just in the webview', async () => {
    const { onDismissed } = renderNotice();
    fireEvent.click(screen.getByRole('button', { name: /Continue with the fresh store/i }));

    await waitFor(() => expect(acknowledgeMigrationRecovery).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onDismissed).toHaveBeenCalledTimes(1));
    // A webview reload would leave `migration_recovery` set and re-render this
    // same screen; the process must not be asked to restart for a dismiss.
    expect(restartApp).not.toHaveBeenCalled();
  });

  it('"Restart Conduit" restarts the process rather than reloading the page', async () => {
    renderNotice();
    fireEvent.click(screen.getByRole('button', { name: /Restart Conduit/i }));
    await waitFor(() => expect(restartApp).toHaveBeenCalledTimes(1));
  });

  it('destructive actions stay behind the disclosure', () => {
    renderNotice();
    expect(screen.queryByRole('button', { name: /Delete backup/i })).toBeNull();
    openDeletePanel();
    expect(screen.getByRole('button', { name: /Delete backup/i })).toBeTruthy();
  });

  it('deleting the backup reports what was freed and does not restart', async () => {
    vi.mocked(discardMigrationBackup).mockResolvedValue({
      removedPaths: ['conduit.sqlite.corrupt-1787026415.bak'],
      freedBytes: 2_621_440,
    });
    const { onStatus, onDismissed } = renderNotice();
    openDeletePanel();
    fireEvent.click(screen.getByRole('button', { name: /Delete backup/i }));

    await waitFor(() => expect(discardMigrationBackup).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('2.5 MB')));
    expect(onDismissed).toHaveBeenCalled();
    expect(restartApp).not.toHaveBeenCalled();
  });

  it('offers no backup delete once the backup is gone', () => {
    renderNotice({ backupExists: false, backupBytes: 0 });
    openDeletePanel();
    expect(screen.getByRole('button', { name: /Delete backup/i }).hasAttribute('disabled')).toBe(true);
  });

  it('the full wipe requires an explicit confirmation before it can run', async () => {
    renderNotice();
    openDeletePanel();

    const wipeButton = screen.getByRole('button', { name: /Delete and restart/i });
    expect(wipeButton.hasAttribute('disabled')).toBe(true);
    fireEvent.click(wipeButton);
    expect(requestLocalDataWipe).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: /cannot be undone/i }));
    fireEvent.click(screen.getByRole('button', { name: /Delete and restart/i }));

    // Defaults to the narrower scope: settings and keychain keys survive unless
    // the user picks otherwise.
    await waitFor(() => expect(requestLocalDataWipe).toHaveBeenCalledWith('conversations'));
    await waitFor(() => expect(restartApp).toHaveBeenCalledTimes(1));
  });

  it('passes the wider scope through when the user selects it', async () => {
    renderNotice();
    openDeletePanel();
    fireEvent.click(screen.getByRole('radio', { name: /Everything above/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /cannot be undone/i }));
    fireEvent.click(screen.getByRole('button', { name: /Delete and restart/i }));

    await waitFor(() => expect(requestLocalDataWipe).toHaveBeenCalledWith('everything'));
  });

  it('surfaces a failed action instead of leaving the buttons dead', async () => {
    vi.mocked(acknowledgeMigrationRecovery).mockRejectedValueOnce(new Error('locked'));
    const { onStatus, onDismissed } = renderNotice();
    fireEvent.click(screen.getByRole('button', { name: /Continue with the fresh store/i }));

    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('locked')));
    expect(onDismissed).not.toHaveBeenCalled();
    // Re-enabled, so the user can retry or pick another way out.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Continue with the fresh store/i }).hasAttribute('disabled'),
      ).toBe(false),
    );
  });
});
