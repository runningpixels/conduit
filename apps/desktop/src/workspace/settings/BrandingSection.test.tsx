/**
 * Settings → Branding (white-label plan §4, Phase 3). This is the only
 * user-facing entry point into Mode A — without it, Phases 0-2 (the
 * `brand.md` format, the apply path, the logo pipeline) are validated code
 * nobody can ever reach.
 *
 * Guard G6 (`shell/settingsCompleteness.test.ts`) already asserts that
 * `'branding'` is wired into the `SettingsSection` union, `NAV_ITEMS`, and a
 * rendered body — re-parsing `SettingsSheet.tsx` here would just duplicate
 * that check on the same source text, so it isn't repeated in this file.
 * What *is* covered here is everything G6 can't see: the section's own
 * behaviour once it renders.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings } from '../../ipc/contracts';
import type { BrandConfig } from '@conduit/config-schema';
import { BrandingSection } from './BrandingSection';

// No `@tauri-apps/api/core` mock: BrandingSection no longer imports `invoke`
// directly. ADR 008 (`docs/adr/adr-008-tauri-capability-surface.md`) is why —
// the default capability grants `core:*` only, not `dialog:default`, so the
// renderer must never call a plugin's own JS command (`invoke('plugin:dialog|open')`)
// directly. Import/Export instead go through `importBrandFileDialog` /
// `exportBrandConfigDialog`, which do the picking *and* the action inside a
// single Rust-side command — mocked below like every other IPC call.
vi.mock('../../ipc/client', () => ({
  getBrandConfig: vi.fn().mockResolvedValue(null),
  getBrandLogo: vi.fn().mockResolvedValue(null),
  getBrandWarnings: vi.fn().mockResolvedValue([]),
  clearBrandConfig: vi.fn().mockResolvedValue(undefined),
  clearBrandLogo: vi.fn().mockResolvedValue(undefined),
  importBrandFileDialog: vi.fn(),
  applyBrandEdits: vi.fn(),
  exportBrandConfigDialog: vi.fn(),
  saveBrandLogo: vi.fn(),
}));

import {
  getBrandConfig,
  getBrandLogo,
  clearBrandConfig,
  saveBrandLogo,
  importBrandFileDialog,
  exportBrandConfigDialog,
  applyBrandEdits,
} from '../../ipc/client';

const baseSettings: AppSettings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'dark',
  providerEndpoints: {},
  artifactRemoteAllowlist: [],
  artifactStyledPreview: true,
  updateChannel: 'stable',
  updateCheckEnabled: true,
  onboardingCompleted: true,
  webSearchEnabled: false,
  webSearch: {
    mode: 'auto' as const,
    localBackend: 'duckduckgo',
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
  brandingEnabled: true,
  workspaceToolsEnabled: false,
  workspaceRoot: null,
  workspaceToolsConsentAcknowledged: false,
  generationControls: null,
  userInstructions: null,
  contextCompactEnabled: true,
  contextCompactThresholdPercent: 90,
};

const SAVED_CONFIG: BrandConfig = {
  schemaVersion: 1,
  identity: { appName: 'Acme', displayName: 'Acme AI', tagline: 'Message Acme…' },
  palette: {
    dark: {
      bg: '#111111', bgSide: '#0a0a0a', card: '#161616', cardHi: '#1c1c1c',
      line: '#2a2a2a', lineSoft: '#202020', lineHi: '#333333',
      ink: '#eeeeee', ink2: '#cccccc', ink3: '#999999',
      hue: '#3366ff', hueText: '#5c85ff', hueSolid: '#2a55e0', onHue: '#ffffff',
      ok: '#22aa55', warn: '#ddaa22', err: '#dd4444', link: '#6699ff',
    },
    light: {
      bg: '#fefefe', bgSide: '#f4f4f4', card: '#ffffff', cardHi: '#f0f0f0',
      line: '#dddddd', lineSoft: '#eaeaea', lineHi: '#cccccc',
      ink: '#111111', ink2: '#333333', ink3: '#666666',
      hue: '#2255dd', hueText: '#2255dd', hueSolid: '#2a55e0', onHue: '#ffffff',
      ok: '#117733', warn: '#996600', err: '#aa2222', link: '#1144bb',
    },
  },
};

function renderSection(overrides: Partial<AppSettings> = {}) {
  const onUpdate = vi.fn();
  const onStatus = vi.fn();
  render(
    <BrandingSection settings={{ ...baseSettings, ...overrides }} onUpdate={onUpdate} onStatus={onStatus} />,
  );
  return { onUpdate, onStatus };
}

beforeEach(() => {
  vi.mocked(getBrandConfig).mockResolvedValue(null);
  vi.mocked(getBrandLogo).mockResolvedValue(null);
  vi.mocked(importBrandFileDialog).mockReset();
  vi.mocked(exportBrandConfigDialog).mockReset();
  vi.mocked(applyBrandEdits).mockReset();
  document.documentElement.removeAttribute('data-palette');
  document.documentElement.removeAttribute('style');
  // Several tests (Revert, Reset, toggling off) call the real
  // `applyBrand`/`clearBrand` from `brand/applyBrand.ts` — unmocked, since
  // only `ipc/client` is mocked in this file — which read/write the
  // pre-paint localStorage cache. Clearing it here keeps every test's
  // starting state independent of execution order.
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('the Mode B honesty note', () => {
  it('names what runtime branding cannot change, plainly, with no fake disabled inputs', () => {
    renderSection();
    // Plan item 9: app icon, installer/executable name, bundle identifier —
    // all three, as a sentence, not as greyed-out controls.
    expect(screen.getByText(/app icon/)).toBeInTheDocument();
    expect(screen.getByText(/installer or executable name/)).toBeInTheDocument();
    expect(screen.getByText(/bundle identifier/)).toBeInTheDocument();
    expect(screen.getByText(/not at runtime/)).toBeInTheDocument();
  });

  it('shows the note even when branding is off', () => {
    renderSection({ brandingEnabled: false });
    expect(screen.getByText(/bundle identifier/)).toBeInTheDocument();
  });
});

describe('the enable toggle', () => {
  it('gates every other control: off means genuinely inert, not just dim', async () => {
    renderSection({ brandingEnabled: false });
    await waitFor(() => expect(getBrandConfig).toHaveBeenCalled());
    // A native <fieldset disabled> is what makes this assertion meaningful —
    // every descendant control is disabled in one shot, not individually.
    expect(screen.getByLabelText('App name')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset to stock' })).toBeDisabled();
  });

  it('re-enables every control once toggled on', async () => {
    renderSection({ brandingEnabled: true });
    await waitFor(() => expect(getBrandConfig).toHaveBeenCalled());
    expect(screen.getByLabelText('App name')).not.toBeDisabled();
  });

  it('writes brandingEnabled back through onUpdate', async () => {
    const { onUpdate } = renderSection({ brandingEnabled: false });
    await waitFor(() => expect(getBrandConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('switch', { name: 'Enable branding' }));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ brandingEnabled: true }));
  });

  it('clearing the toggle restores the stock look: applied custom properties are removed', async () => {
    vi.mocked(getBrandConfig).mockResolvedValue(SAVED_CONFIG);
    const { onUpdate } = renderSection({ brandingEnabled: true });
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue('--hue')).toBe('#3366ff'),
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Enable branding' }));
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ brandingEnabled: false }));
    expect(document.documentElement.style.getPropertyValue('--hue')).toBe('');
  });
});

describe('colour validation', () => {
  it('flags an invalid hex value next to the field it belongs to, and does not apply it', async () => {
    renderSection();
    // Wait for the initial (seed-default) live preview to actually land,
    // so "before" reflects the last *valid* applied value rather than the
    // empty string that's there before the first effect has run.
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--bg')).not.toBe(''));

    const bgInput = screen.getByLabelText('Background') as HTMLInputElement;
    const before = document.documentElement.style.getPropertyValue('--bg');

    fireEvent.change(bgInput, { target: { value: 'not-a-colour' } });

    expect(await screen.findByText(/enter a hex colour/i)).toBeInTheDocument();
    // applyBrandTheme drops out-of-grammar values rather than applying them —
    // the previously-applied value (or nothing, if none was ever applied)
    // must be unchanged.
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe(before);
  });

  it('accepts a valid hex value and clears the error', async () => {
    renderSection();
    await waitFor(() => expect(getBrandConfig).toHaveBeenCalled());
    const bgInput = screen.getByLabelText('Background') as HTMLInputElement;
    fireEvent.change(bgInput, { target: { value: 'not-a-colour' } });
    expect(await screen.findByText(/enter a hex colour/i)).toBeInTheDocument();
    fireEvent.change(bgInput, { target: { value: '#123456' } });
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#123456'));
    expect(screen.queryByText(/enter a hex colour/i)).not.toBeInTheDocument();
  });
});

describe('the dark/light theme switcher', () => {
  it('edits only the palette for the theme currently selected', async () => {
    vi.mocked(getBrandConfig).mockResolvedValue(SAVED_CONFIG);
    renderSection({ theme: 'dark' });
    await waitFor(() => expect((screen.getByLabelText('Background') as HTMLInputElement).value).toBe('#111111'));

    // Editing while "Dark" is selected changes the dark swatch only.
    fireEvent.change(screen.getByLabelText('Background'), { target: { value: '#abcabc' } });
    expect((screen.getByLabelText('Background') as HTMLInputElement).value).toBe('#abcabc');

    // Switching to Light shows light's own (untouched) value.
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect((screen.getByLabelText('Background') as HTMLInputElement).value).toBe('#fefefe');

    // Switching back to Dark shows the edit, proving the two palettes are
    // independent rather than one shared draft.
    fireEvent.click(screen.getByRole('button', { name: 'Dark' }));
    expect((screen.getByLabelText('Background') as HTMLInputElement).value).toBe('#abcabc');
  });

  it('"copy to other theme" seeds the other palette from the one being edited', async () => {
    vi.mocked(getBrandConfig).mockResolvedValue(SAVED_CONFIG);
    renderSection({ theme: 'dark' });
    await waitFor(() => expect((screen.getByLabelText('Background') as HTMLInputElement).value).toBe('#111111'));

    fireEvent.change(screen.getByLabelText('Background'), { target: { value: '#abcabc' } });
    fireEvent.click(screen.getByRole('button', { name: /Copy to light/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Light' }));
    expect((screen.getByLabelText('Background') as HTMLInputElement).value).toBe('#abcabc');
  });
});

describe('Revert', () => {
  it('discards the draft and restores the last saved config', async () => {
    vi.mocked(getBrandConfig).mockResolvedValue(SAVED_CONFIG);
    renderSection();
    await waitFor(() => expect((screen.getByLabelText('App name') as HTMLInputElement).value).toBe('Acme'));

    fireEvent.change(screen.getByLabelText('App name'), { target: { value: 'Something Else' } });
    expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Revert' }));

    expect((screen.getByLabelText('App name') as HTMLInputElement).value).toBe('Acme');
    expect(screen.queryByText(/Unsaved changes/)).not.toBeInTheDocument();
  });
});

describe('Reset', () => {
  it('requires confirmation before deleting the on-disk brand', async () => {
    renderSection();
    await waitFor(() => expect(getBrandConfig).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Reset to stock' }));
    // The destructive call must not have happened yet — only the dialog opened.
    expect(clearBrandConfig).not.toHaveBeenCalled();
    expect(screen.getByText(/Reset branding\?/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset branding' }));
    await waitFor(() => expect(clearBrandConfig).toHaveBeenCalled());
  });

  it('does nothing if the confirmation is cancelled', async () => {
    renderSection();
    await waitFor(() => expect(getBrandConfig).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Reset to stock' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(clearBrandConfig).not.toHaveBeenCalled();
  });
});

describe('logo upload failure', () => {
  it('shows a Rust rejection message verbatim, not a generic failure string', async () => {
    vi.mocked(saveBrandLogo).mockRejectedValue(
      new Error('Logo exceeds 2 MiB — resize it and try again'),
    );
    renderSection();
    await waitFor(() => expect(getBrandConfig).toHaveBeenCalled());

    const input = screen.getByTestId('brand-logo-file-input') as HTMLInputElement;
    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByText('Logo exceeds 2 MiB — resize it and try again')).toBeInTheDocument();
    // Not swapped for a generic "upload failed" — the specific message is
    // what makes Rust's validation actionable.
    expect(screen.queryByText(/^upload failed$/i)).not.toBeInTheDocument();
  });
});

describe('Import/Export cancellation (ADR 008)', () => {
  /**
   * `importBrandFileDialog`/`exportBrandConfigDialog` do the OS picker *and*
   * the action inside one Rust round trip (ADR 008: the renderer never
   * invokes a Tauri plugin's own JS command, so it never sees a path — Rust
   * resolves `null` when the user cancels the picker). A cancel is not a
   * failure: the classic file-picker bug is reading it as one.
   */
  it('a cancelled import leaves the draft, the saved config, and the applied brand untouched, with no error', async () => {
    vi.mocked(getBrandConfig).mockResolvedValue(SAVED_CONFIG);
    vi.mocked(importBrandFileDialog).mockResolvedValue(null);
    const { onStatus } = renderSection();
    await waitFor(() => expect((screen.getByLabelText('App name') as HTMLInputElement).value).toBe('Acme'));

    const hueBefore = document.documentElement.style.getPropertyValue('--hue');

    fireEvent.click(screen.getByRole('button', { name: 'Import brand.md…' }));
    await waitFor(() => expect(importBrandFileDialog).toHaveBeenCalled());

    // Nothing moved: same identity, same applied colour, no toast, no alert.
    expect((screen.getByLabelText('App name') as HTMLInputElement).value).toBe('Acme');
    expect(document.documentElement.style.getPropertyValue('--hue')).toBe(hueBefore);
    expect(onStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a cancelled export shows no error and no status toast', async () => {
    vi.mocked(exportBrandConfigDialog).mockResolvedValue(null);
    const { onStatus } = renderSection();
    await waitFor(() => expect(getBrandConfig).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Export…' }));
    await waitFor(() => expect(exportBrandConfigDialog).toHaveBeenCalled());

    expect(onStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a genuine import failure still surfaces the Rust message and does not read as a cancel', async () => {
    vi.mocked(importBrandFileDialog).mockRejectedValue(new Error('brand.md failed validation: unquoted hex at line 12'));
    renderSection();
    await waitFor(() => expect(getBrandConfig).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('button', { name: 'Import brand.md…' }));

    expect(await screen.findByText('brand.md failed validation: unquoted hex at line 12')).toBeInTheDocument();
  });
});

describe('the pre-paint cache stays untouched by an unsaved draft', () => {
  const CACHE_KEY = 'conduit:v1-brand';

  /**
   * Live preview (plan item 16) applies straight through
   * `applyBrandTheme`/`setBrand`, deliberately never the full `applyBrand()`
   * — which also writes this cache — so a never-saved edit can't resurrect
   * itself on the next launch (`main.tsx` replays this cache before first
   * paint). Pinned here because a later refactor that "simplifies" the two
   * live-preview effects into a single `applyBrand()` call would reintroduce
   * exactly that bug, silently.
   */
  it('editing without saving never writes the localStorage brand cache', async () => {
    renderSection();
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--bg')).not.toBe(''));
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();

    fireEvent.change(screen.getByLabelText('Background'), { target: { value: '#abcabc' } });
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#abcabc'));

    // The edit is genuinely live on the DOM (that's the point of live
    // preview) — but the pre-paint cache must still hold nothing.
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();

    fireEvent.change(screen.getByLabelText('App name'), { target: { value: 'Draft Co' } });
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();
  });

  it('writes the cache only once Save actually persists the draft', async () => {
    const saved: BrandConfig = {
      ...SAVED_CONFIG,
      identity: { ...SAVED_CONFIG.identity, appName: 'Acme' },
    };
    vi.mocked(applyBrandEdits).mockResolvedValue(saved);
    renderSection();
    await waitFor(() => expect(getBrandConfig).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('App name'), { target: { value: 'Acme' } });
    await waitFor(() => expect(screen.getByText(/Unsaved changes/)).toBeInTheDocument());
    expect(localStorage.getItem(CACHE_KEY)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(applyBrandEdits).toHaveBeenCalled());
    await waitFor(() => expect(localStorage.getItem(CACHE_KEY)).not.toBeNull());
  });
});
