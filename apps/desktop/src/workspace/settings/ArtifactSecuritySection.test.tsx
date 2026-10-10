/**
 * Full web access in Settings → Artifact security (ADR-007): the switch that
 * gives every page full web access (off by default), and per-page grants
 * listed next to the site grants, removable.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings } from '../../ipc/contracts';
import { ArtifactSecuritySection } from './ArtifactSecuritySection';

const listArtifactNetworkGrants = vi.fn();
const revokeArtifactNetworkGrant = vi.fn();

vi.mock('../../ipc/client', () => ({
  listArtifactNetworkGrants: (...args: unknown[]) => listArtifactNetworkGrants(...args),
  revokeArtifactNetworkGrant: (...args: unknown[]) => revokeArtifactNetworkGrant(...args),
  clearArtifactNetworkGrants: vi.fn().mockResolvedValue(undefined),
}));

const settings = {
  localOnly: false,
  artifactNetworkEnabled: true,
  artifactRemoteAllowlist: [],
} as unknown as AppSettings;

describe('ArtifactSecuritySection full web access', () => {
  it('offers the every-page switch, off by default, and saves it', () => {
    listArtifactNetworkGrants.mockResolvedValue([]);
    const onUpdate = vi.fn();
    render(<ArtifactSecuritySection settings={settings} onUpdate={onUpdate} />);
    const toggle = screen.getByRole('switch', { name: 'Give every page full web access' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(toggle);
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ artifactFullWebAccess: true }));
  });

  it('turns the switch off again', () => {
    listArtifactNetworkGrants.mockResolvedValue([]);
    const onUpdate = vi.fn();
    render(
      <ArtifactSecuritySection settings={{ ...settings, artifactFullWebAccess: true }} onUpdate={onUpdate} />,
    );
    const toggle = screen.getByRole('switch', { name: 'Give every page full web access' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ artifactFullWebAccess: false }));
  });

  it('lists a page given full web access with the site grants, and removes it', async () => {
    listArtifactNetworkGrants.mockResolvedValue([
      {
        principal: 'artifact:a1',
        kind: 'artifact',
        host: 'full',
        createdAt: '2026-10-09T00:00:00Z',
        lastUsedAt: null,
        title: 'Chart',
      },
      {
        principal: 'app:b2',
        kind: 'app',
        host: 'https://api.open-meteo.com',
        createdAt: '2026-10-09T00:00:00Z',
        lastUsedAt: null,
        title: 'Weather',
      },
    ]);
    revokeArtifactNetworkGrant.mockResolvedValue(undefined);
    render(<ArtifactSecuritySection settings={settings} onUpdate={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Full web access')).toBeTruthy());
    expect(screen.getByText('api.open-meteo.com')).toBeTruthy();
    const row = screen.getByText('Full web access').closest('li')!;
    fireEvent.click(row.querySelector('button')!);
    await waitFor(() => expect(revokeArtifactNetworkGrant).toHaveBeenCalledWith('artifact:a1', 'full'));
  });
});
