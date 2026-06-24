import { describe, it, expect } from 'vitest';
// Repo-root tooling script (Phase 6 M6.2). It is plain ESM JS with no type
// bindings; vitest runs it directly. `@ts-ignore` keeps `tsc -b` (`pnpm check`)
// quiet about the missing declaration — the logic is covered here.
// @ts-ignore
import { buildManifest, classifyBundle } from '../../../../scripts/generate-update-manifest.mjs';

describe('generate-update-manifest buildManifest', () => {
  const basePlatforms = [
    { platform: 'windows-x86_64', signature: 'sig-win', url: 'https://example.com/win.zip' },
    { platform: 'darwin-aarch64', signature: 'sig-mac-arm', url: 'https://example.com/mac-arm.tar.gz' },
    { platform: 'linux-x86_64', signature: 'sig-linux', url: 'https://example.com/linux.tar.gz' },
  ];

  it('emits the Tauri 2 manifest shape for a fixture set', () => {
    const manifest = buildManifest({
      version: '1.2.3',
      notes: 'first beta',
      pubDate: '2026-06-23T12:00:00Z',
      platforms: basePlatforms,
    });
    expect(manifest).toEqual({
      version: '1.2.3',
      notes: 'first beta',
      pub_date: '2026-06-23T12:00:00Z',
      platforms: {
        'windows-x86_64': { signature: 'sig-win', url: 'https://example.com/win.zip' },
        'darwin-aarch64': { signature: 'sig-mac-arm', url: 'https://example.com/mac-arm.tar.gz' },
        'linux-x86_64': { signature: 'sig-linux', url: 'https://example.com/linux.tar.gz' },
      },
    });
  });

  it('defaults notes to an empty string and trims signatures', () => {
    const manifest = buildManifest({
      version: '1.0.0',
      pubDate: '2026-06-23T12:00:00Z',
      platforms: [{ platform: 'windows-x86_64', signature: '  sig  ', url: 'https://x/y.zip' }],
    });
    expect(manifest.notes).toBe('');
    expect(manifest.platforms['windows-x86_64'].signature).toBe('sig');
  });

  it('rejects an unknown platform key', () => {
    expect(() =>
      buildManifest({
        version: '1.0.0',
        pubDate: '2026-06-23T12:00:00Z',
        platforms: [{ platform: 'windows-arm64', signature: 's', url: 'https://x/y' }],
      }),
    ).toThrow(/unknown platform/);
  });

  it('rejects a missing signature (so a partial manifest never ships)', () => {
    expect(() =>
      buildManifest({
        version: '1.0.0',
        pubDate: '2026-06-23T12:00:00Z',
        platforms: [{ platform: 'windows-x86_64', signature: '', url: 'https://x/y' }],
      }),
    ).toThrow(/missing signature/);
  });

  it('rejects a non-https download URL', () => {
    expect(() =>
      buildManifest({
        version: '1.0.0',
        pubDate: '2026-06-23T12:00:00Z',
        platforms: [{ platform: 'windows-x86_64', signature: 's', url: 'http://insecure/y' }],
      }),
    ).toThrow(/non-https/);
  });

  it('rejects a non-semver version and a bad pubDate', () => {
    expect(() =>
      buildManifest({ version: 'latest', pubDate: '2026-06-23T12:00:00Z', platforms: [] }),
    ).toThrow(/invalid version/);
    expect(() =>
      buildManifest({ version: '1.0.0', pubDate: 'not-a-date', platforms: [] }),
    ).toThrow(/invalid pubDate/);
  });
});

describe('generate-update-manifest classifyBundle', () => {
  it('maps each Tauri bundle filename to its updater platform + .sig sibling', () => {
    expect(classifyBundle('Conduit_1.2.3_x64-setup.nsis.zip')).toEqual({
      platform: 'windows-x86_64',
      sigFile: 'Conduit_1.2.3_x64-setup.nsis.zip.sig',
    });
    expect(classifyBundle('Conduit_1.2.3_aarch64.app.tar.gz')).toEqual({
      platform: 'darwin-aarch64',
      sigFile: 'Conduit_1.2.3_aarch64.app.tar.gz.sig',
    });
    expect(classifyBundle('Conduit_1.2.3_x64.app.tar.gz')).toEqual({
      platform: 'darwin-x86_64',
      sigFile: 'Conduit_1.2.3_x64.app.tar.gz.sig',
    });
    expect(classifyBundle('Conduit_1.2.3_amd64.AppImage.tar.gz')).toEqual({
      platform: 'linux-x86_64',
      sigFile: 'Conduit_1.2.3_amd64.AppImage.tar.gz.sig',
    });
  });

  it('ignores non-updater files (the raw .exe, .deb, unrelated files)', () => {
    expect(classifyBundle('Conduit_1.2.3_x64-setup.exe')).toBeNull();
    expect(classifyBundle('Conduit_1.2.3_amd64.deb')).toBeNull();
    expect(classifyBundle('README.md')).toBeNull();
  });
});