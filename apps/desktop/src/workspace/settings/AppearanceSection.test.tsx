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
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { AppSettings } from '../../ipc/contracts';
import { AppearanceSection } from './AppearanceSection';
import { PSEUDO_LOCALE, SHIPPED_LOCALES } from '../../i18n';

const settings = {
  activeProvider: 'anthropic',
  activeModel: 'claude-sonnet-4',
  localOnly: true,
  diagnosticsEnabled: true,
  theme: 'system',
  language: 'system',
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

describe('language select', () => {
  /**
   * The only control in the app whose own label a user may not be able to
   * read: someone who has just installed on a German machine and wants
   * English is looking at a settings pane written in German. That is why the
   * options are native names rather than translated ones, and why it sits at
   * the top of the first pane.
   */
  it('offers System plus every shipped locale, named in its own language', () => {
    renderSection();
    const select = screen.getByLabelText('Language');
    expect(select).toBeInTheDocument();

    // Scoped to this select: "System" is also a Theme option, and the two
    // must not be confused for one another.
    const options = within(select);
    expect(options.getByRole('option', { name: 'System' })).toBeInTheDocument();
    for (const locale of SHIPPED_LOCALES) {
      expect(
        options.getByRole('option', { name: locale.nativeName }),
        `${locale.code} is missing from the picker`,
      ).toBeInTheDocument();
    }
    // System + the eight shipped locales, and nothing else.
    expect(select.querySelectorAll('option')).toHaveLength(SHIPPED_LOCALES.length + 1);
  });

  it('never offers the pseudo-locale', () => {
    // `en-XA` is a layout-QA tool reachable only by a dev override. A user
    // who picked it would get `[Šààvvéé———]` with no obvious way back.
    renderSection();
    const values = Array.from(
      screen.getByLabelText('Language').querySelectorAll('option'),
      (o) => o.value,
    );
    expect(values).not.toContain(PSEUDO_LOCALE);
  });

  it('writes the choice into AppSettings, where it crosses into Rust', () => {
    // Unlike the palette above, this one *is* AppSettings-backed: it has to
    // survive a restart, and Rust needs it for the reply-language line in the
    // system prompt (D12).
    const { onUpdate } = renderSection();
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'de' } });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ language: 'de' }));
  });

  it('round-trips a region-qualified tag without mangling it', () => {
    // `pt-BR`, not `ptBr` — the value written here is the exact string the
    // Rust enum and the catalog filenames use.
    const { onUpdate } = renderSection();
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'pt-BR' } });
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ language: 'pt-BR' }));
  });

  it('says that the choice also moves the reply language', () => {
    // D12 folds two things into one setting; the only defence against that
    // being a surprise is saying so next to the control.
    renderSection();
    expect(screen.getByText(/language the assistant replies in/i)).toBeInTheDocument();
  });
});
