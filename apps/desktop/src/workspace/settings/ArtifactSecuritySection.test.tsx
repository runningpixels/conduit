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
const site = vi.hoisted(() => ({
  clearAllPageSiteData: vi.fn(async () => ({ cleared: 2, failed: 0 })),
  sweepPageSiteData: vi.fn(async () => {}),
}));
vi.mock('../../artifacts/pageSiteData', () => site);

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
    // The page lost its own origin: what it kept there is swept.
    await waitFor(() => expect(site.sweepPageSiteData).toHaveBeenCalled());
  });

  it('turning the every-page switch off sweeps pages that lose full access', async () => {
    listArtifactNetworkGrants.mockResolvedValue([]);
    site.sweepPageSiteData.mockClear();
    const { rerender } = render(
      <ArtifactSecuritySection settings={{ ...settings, artifactFullWebAccess: true }} onUpdate={vi.fn()} />,
    );
    expect(site.sweepPageSiteData).not.toHaveBeenCalled();
    rerender(<ArtifactSecuritySection settings={{ ...settings, artifactFullWebAccess: false }} onUpdate={vi.fn()} />);
    expect(site.sweepPageSiteData).toHaveBeenCalledWith({ everyPage: false });
  });
});

describe('ArtifactSecuritySection page site data', () => {
  it('"Clear data for all pages" asks first, then clears and says so', async () => {
    listArtifactNetworkGrants.mockResolvedValue([]);
    render(<ArtifactSecuritySection settings={settings} onUpdate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear data for all pages' }));
    expect(site.clearAllPageSiteData).not.toHaveBeenCalled();
    expect(await screen.findByText('Clear data for all pages?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(site.clearAllPageSiteData).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Cleared data for all pages.')).toBeTruthy();
  });

  it('says when some data could not be cleared', async () => {
    listArtifactNetworkGrants.mockResolvedValue([]);
    site.clearAllPageSiteData.mockResolvedValueOnce({ cleared: 1, failed: 1 });
    render(<ArtifactSecuritySection settings={settings} onUpdate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Clear data for all pages' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Some page data couldn’t be cleared. Try again.');
  });
});
