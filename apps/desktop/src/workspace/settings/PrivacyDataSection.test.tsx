/**
 * The keychain-mode row (V9 §2.6, ADR-009).
 *
 * The row is the only place a user learns that the file store is weaker than
 * the keychain and that it needs a key from the environment. Its *copy* is the
 * feature as much as the select is: a dropdown offering "OS keychain" and
 * "File (encrypted)" as equal-looking options, with no mention of
 * CONDUIT_CREDENTIAL_KEY, would be an invitation to pick the worse one by
 * accident. So the wording is asserted, not just the control.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AppSettings } from '../../ipc/contracts';
import { PrivacyDataSection } from './PrivacyDataSection';

vi.mock('../../ipc/client', () => ({
  resetLocalDatabase: vi.fn().mockResolvedValue({ backupPath: null }),
}));

const settings: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'system',
  providerEndpoints: {},
  artifactRemoteAllowlist: [],
  artifactStyledPreview: true,
  updateChannel: 'stable',
  updateCheckEnabled: true,
  onboardingCompleted: true,
  webSearchEnabled: false,
  webSearch: {
    searchContextSize: 'medium',
    allowedDomains: [],
    blockedDomains: [],
    externalWebAccess: true,
    returnTokenBudget: 'default',
    includeSources: false,
  },
  webSearchConsentAcknowledged: false,
  agent: { maxSteps: 25, wallClockBudgetSecs: 300 },
  keychainMode: 'os',
  brandingEnabled: false,
  workspaceToolsEnabled: false,
  workspaceRoot: null,
  workspaceToolsConsentAcknowledged: false,
};

function renderSection(overrides: Partial<AppSettings> = {}) {
  const onUpdate = vi.fn();
  render(
    <PrivacyDataSection
      settings={{ ...settings, ...overrides }}
      onUpdate={onUpdate}
      onStatus={vi.fn()}
    />,
  );
  return { onUpdate };
}

describe('keychain mode', () => {
  it('offers both backends and marks the keychain as recommended', () => {
    renderSection();
    const select = screen.getByLabelText('Keychain mode') as HTMLSelectElement;
    expect(select.value).toBe('os');
    expect(screen.getByRole('option', { name: /OS keychain \(recommended\)/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /File \(encrypted\)/ })).toBeInTheDocument();
  });

  it('writes the chosen mode back', () => {
    const { onUpdate } = renderSection();
    fireEvent.change(screen.getByLabelText('Keychain mode'), { target: { value: 'file' } });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ keychainMode: 'file' }));
  });

  /**
   * The load-bearing copy. In file mode the user has to know the key comes from
   * an environment variable and that nothing works without it — otherwise the
   * first symptom is a save that fails for no visible reason.
   */
  it('names the environment variable when the file store is selected', () => {
    renderSection({ keychainMode: 'file' });
    expect(screen.getByText(/CONDUIT_CREDENTIAL_KEY/)).toBeInTheDocument();
    expect(screen.getByText(/base64-encoded\s+32-byte value/)).toBeInTheDocument();
  });

  it('states that the file store is weaker and why it exists', () => {
    renderSection({ keychainMode: 'file' });
    expect(screen.getByText(/weaker than\s+the OS keychain/)).toBeInTheDocument();
    expect(screen.getByText(/headless CI/)).toBeInTheDocument();
  });

  it('promises no fallback to the keychain', () => {
    renderSection({ keychainMode: 'file' });
    // ADR-009's non-silent-downgrade rule, stated where the user chooses.
    expect(screen.getByText(/rather\s+than falling back to the keychain/)).toBeInTheDocument();
  });

  it('warns that switching does not move existing keys', () => {
    renderSection({ keychainMode: 'os' });
    expect(screen.getByText(/does not move keys you have already saved/)).toBeInTheDocument();
  });
});
