/**
 * The Palette select.
 *
 * `SettingsSheet.test.tsx` mocks this whole component out, so the Appearance
 * controls that live *inside* it have no coverage from there — only the toggles
 * rendered directly by the sheet do. This file is where a control added here
 * gets asserted.
 *
 * The palette is renderer-only (localStorage + `html[data-palette]`), so the
 * assertions are on the storage key and the document attribute rather than on
 * an `onUpdate` callback, which is what the AppSettings-backed rows use.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AppSettings } from '../../ipc/contracts';
import { AppearanceSection } from './AppearanceSection';

const settings = {
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
  webSearchConsentAcknowledged: false,
  keychainMode: 'os',
} as unknown as AppSettings;

function renderSection() {
  const onUpdate = vi.fn();
  render(<AppearanceSection settings={settings} onUpdate={onUpdate} />);
  return { onUpdate };
}

describe('palette select', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-palette');
  });

  it('defaults to the Terra palette and offers both', () => {
    renderSection();
    const select = screen.getByLabelText('Palette') as HTMLSelectElement;
    expect(select.value).toBe('terra');
    expect(screen.getByRole('option', { name: /Terra/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Claude/ })).toBeInTheDocument();
  });

  it('persists the choice and applies it to the document', () => {
    renderSection();
    fireEvent.change(screen.getByLabelText('Palette'), { target: { value: 'claude' } });
    expect(localStorage.getItem('conduit:v9-palette')).toBe('claude');
    expect(document.documentElement.getAttribute('data-palette')).toBe('claude');
  });

  /**
   * The palette is a look, not a theme: the two axes are orthogonal and the
   * select must not touch AppSettings, which is where `theme` lives and which
   * crosses the IPC boundary into a Rust enum.
   */
  it('does not write the palette into AppSettings', () => {
    const { onUpdate } = renderSection();
    fireEvent.change(screen.getByLabelText('Palette'), { target: { value: 'claude' } });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('leaves the theme select independent of the palette', () => {
    const { onUpdate } = renderSection();
    fireEvent.change(screen.getByLabelText('Palette'), { target: { value: 'claude' } });
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'light' } });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ theme: 'light' }));
    expect(document.documentElement.getAttribute('data-palette')).toBe('claude');
  });
});
