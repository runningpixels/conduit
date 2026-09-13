import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { ThemePicker } from './ThemePicker';
import { DEFAULT_THEME_ID, THEMES, themeById } from '../../themes/registry';

function resetDocument() {
  localStorage.clear();
  document.documentElement.removeAttribute('data-look');
  document.documentElement.removeAttribute('data-palette');
}

describe('ThemePicker', () => {
  beforeEach(resetDocument);

  /** The card's accessible name for each shipped manifest, by i18n key. */
  const CARD_NAME: Record<string, RegExp> = {
    orangeCharcoal: /^Orange Charcoal/,
    orangeDark: /^Orange-Dark/,
    terra: /^Terra/,
    amberTerminal: /^Amber Terminal/,
    greenPhosphor: /^Green Phosphor/,
    amberPaper: /^Amber Paper/,
    graphite: /^Graphite/,
    editorial: /^Editorial/,
    highContrast: /^High Contrast/,
  };

  it('renders one radio per manifest, in a labelled radiogroup', () => {
    render(<ThemePicker />);
    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(within(group).getAllByRole('radio')).toHaveLength(THEMES.length);
    for (const theme of THEMES) {
      expect(within(group).getByRole('radio', { name: CARD_NAME[theme.i18nKey] })).toBeInTheDocument();
    }
  });

  it('starts with the default theme checked', () => {
    render(<ThemePicker />);
    const defaultTheme = themeById(DEFAULT_THEME_ID);
    expect(defaultTheme).toBeDefined();
    const checked = screen.getByRole('radio', { name: CARD_NAME[defaultTheme!.i18nKey] });
    expect(checked).toHaveAttribute('aria-checked', 'true');
    // Every other card is unchecked.
    const others = screen.getAllByRole('radio').filter((el) => el !== checked);
    for (const el of others) expect(el).toHaveAttribute('aria-checked', 'false');
  });

  it('selecting a card calls through to selectTheme and updates aria-checked', () => {
    render(<ThemePicker />);
    const terra = screen.getByRole('radio', { name: /Terra/ });
    fireEvent.click(terra);

    expect(terra).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem('conduit:v9-palette')).toBe('terra');
    expect(localStorage.getItem('conduit:v10-look')).toBe('soft');
    expect(document.documentElement.getAttribute('data-palette')).toBe('terra');

    const others = screen.getAllByRole('radio').filter((el) => el !== terra);
    for (const el of others) expect(el).toHaveAttribute('aria-checked', 'false');
  });

  it('does not move the palette while a white-label brand owns it', () => {
    document.documentElement.setAttribute('data-palette', 'brand');
    render(<ThemePicker />);
    fireEvent.click(screen.getByRole('radio', { name: /Terra/ }));
    // The look still moves (brand only owns the palette axis); the document
    // palette attribute stays 'brand' even though the stored preference moves.
    expect(document.documentElement.getAttribute('data-palette')).toBe('brand');
    expect(localStorage.getItem('conduit:v9-palette')).toBe('terra');
  });

  describe('keyboard navigation', () => {
    it('ArrowRight/ArrowLeft move focus and selection, wrapping at the ends', () => {
      render(<ThemePicker />);
      const radios = screen.getAllByRole('radio');
      radios[0].focus();

      fireEvent.keyDown(radios[0], { key: 'ArrowRight' });
      expect(radios[1]).toHaveFocus();
      expect(radios[1]).toHaveAttribute('aria-checked', 'true');

      fireEvent.keyDown(radios[1], { key: 'ArrowLeft' });
      expect(radios[0]).toHaveFocus();
      expect(radios[0]).toHaveAttribute('aria-checked', 'true');

      // Wraps backward from the first card to the last.
      fireEvent.keyDown(radios[0], { key: 'ArrowLeft' });
      expect(radios[radios.length - 1]).toHaveFocus();
    });

    it('Home/End jump to the first/last card and select it', () => {
      render(<ThemePicker />);
      const radios = screen.getAllByRole('radio');
      radios[0].focus();

      fireEvent.keyDown(radios[0], { key: 'End' });
      expect(radios[radios.length - 1]).toHaveFocus();
      expect(radios[radios.length - 1]).toHaveAttribute('aria-checked', 'true');

      fireEvent.keyDown(radios[radios.length - 1], { key: 'Home' });
      expect(radios[0]).toHaveFocus();
      expect(radios[0]).toHaveAttribute('aria-checked', 'true');
    });

    it('only the checked card is in the tab order (roving tabindex)', () => {
      render(<ThemePicker />);
      const radios = screen.getAllByRole('radio');
      const checked = radios.find((r) => r.getAttribute('aria-checked') === 'true');
      for (const r of radios) {
        expect(r).toHaveAttribute('tabindex', r === checked ? '0' : '-1');
      }
    });
  });

  describe('the custom (unnamed) look x palette pairing', () => {
    afterEach(() => {
      vi.doUnmock('../../themes/registry');
      vi.resetModules();
    });

    it('checks no card and shows the custom note', async () => {
      vi.resetModules();
      vi.doMock('../../themes/registry', async () => {
        const actual =
          await vi.importActual<typeof import('../../themes/registry')>('../../themes/registry');
        // Every real look x palette pair is named today, so the only way to
        // reach "no manifest names this pair" is to mock the lookup itself —
        // uiPrefs.test.ts exercises the same seam the same way.
        return { ...actual, themeForPair: () => undefined };
      });
      const { ThemePicker: MockedThemePicker } = await import('./ThemePicker');
      render(<MockedThemePicker />);

      for (const radio of screen.getAllByRole('radio')) {
        expect(radio).toHaveAttribute('aria-checked', 'false');
      }
      expect(screen.getByText(/Custom combination/)).toBeInTheDocument();
    });
  });

  it('badges single-mode themes with the one mode they render', () => {
    render(<ThemePicker />);
    for (const theme of THEMES) {
      const card = screen.getByRole('radio', { name: CARD_NAME[theme.i18nKey] });
      const dark = within(card).queryByText('Dark only');
      const light = within(card).queryByText('Light only');
      const only = theme.modes.length === 1 ? theme.modes[0] : null;
      expect(Boolean(dark)).toBe(only === 'dark');
      expect(Boolean(light)).toBe(only === 'light');
    }
  });
});
