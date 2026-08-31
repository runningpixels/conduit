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

  it('defaults to the Orange Charcoal palette and offers all three', () => {
    renderSection();
    const select = screen.getByLabelText('Palette') as HTMLSelectElement;
    expect(select.value).toBe('orange-charcoal');
    expect(screen.getByRole('option', { name: /Orange Charcoal/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Orange-Dark/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Terra/ })).toBeInTheDocument();
  });

  it('persists the choice and applies it to the document', () => {
    renderSection();
    fireEvent.change(screen.getByLabelText('Palette'), { target: { value: 'terra' } });
    expect(localStorage.getItem('conduit:v9-palette')).toBe('terra');
    expect(document.documentElement.getAttribute('data-palette')).toBe('terra');
    fireEvent.change(screen.getByLabelText('Palette'), { target: { value: 'orange-dark' } });
    expect(localStorage.getItem('conduit:v9-palette')).toBe('orange-dark');
    expect(document.documentElement.getAttribute('data-palette')).toBe('orange-dark');
  });

  /**
   * The palette is a look, not a theme: the two axes are orthogonal and the
   * select must not touch AppSettings, which is where `theme` lives and which
   * crosses the IPC boundary into a Rust enum.
   */
  it('does not write the palette into AppSettings', () => {
    const { onUpdate } = renderSection();
    fireEvent.change(screen.getByLabelText('Palette'), { target: { value: 'terra' } });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('leaves the theme select independent of the palette', () => {
    const { onUpdate } = renderSection();
    fireEvent.change(screen.getByLabelText('Palette'), { target: { value: 'terra' } });
    fireEvent.change(screen.getByLabelText('Theme'), { target: { value: 'light' } });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ theme: 'light' }));
    expect(document.documentElement.getAttribute('data-palette')).toBe('terra');
  });
});

describe('diagram size select', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-mermaid-scale');
  });

  it('defaults to 85% and offers compact / default / full', () => {
    renderSection();
    const select = screen.getByLabelText('Diagram size') as HTMLSelectElement;
    expect(select.value).toBe('default');
    expect(screen.getByRole('option', { name: /Compact \(75%\)/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Default \(85%\)/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Full \(100%\)/ })).toBeInTheDocument();
  });

  it('persists the choice and applies it to the document', () => {
    renderSection();
    fireEvent.change(screen.getByLabelText('Diagram size'), { target: { value: 'compact' } });
    expect(localStorage.getItem('conduit:v9-mermaid-scale')).toBe('compact');
    expect(document.documentElement.getAttribute('data-mermaid-scale')).toBe('compact');
  });

  it('does not write diagram size into AppSettings', () => {
    const { onUpdate } = renderSection();
    fireEvent.change(screen.getByLabelText('Diagram size'), { target: { value: 'full' } });
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
