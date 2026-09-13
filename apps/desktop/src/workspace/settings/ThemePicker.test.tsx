import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ThemePicker } from './ThemePicker';
import { DEFAULT_THEME_ID, THEMES, themeById } from '../../themes/registry';

const { listUserThemes, revealThemesDir, createExampleUserTheme } = vi.hoisted(() => ({
  listUserThemes: vi.fn(),
  revealThemesDir: vi.fn(),
  createExampleUserTheme: vi.fn(),
}));

vi.mock('../../ipc/client', () => ({
  listUserThemes,
  revealThemesDir,
  createExampleUserTheme,
}));

function resetDocument() {
  localStorage.clear();
  for (const attr of Array.from(document.documentElement.attributes)) {
    document.documentElement.removeAttribute(attr.name);
  }
  document.documentElement.removeAttribute('style');
}

describe('ThemePicker', () => {
  beforeEach(() => {
    resetDocument();
    listUserThemes.mockReset().mockResolvedValue([]);
    revealThemesDir.mockReset().mockResolvedValue(undefined);
    createExampleUserTheme.mockReset();
  });

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

// ── Theming Phase 5 — user theme files ─────────────────────────────────────

function fullPalette(overrides: Record<string, string> = {}) {
  return {
    bg: '#111111', bgSide: '#121212', card: '#131313', cardHi: '#141414',
    line: '#151515', lineSoft: '#161616', lineHi: '#171717',
    ink: '#e0e0e0', ink2: '#d0d0d0', ink3: '#c0c0c0',
    hue: '#ff9900', hueText: '#ffb020', hueSolid: '#ffb020', onHue: '#000000',
    ok: '#22cc55', warn: '#ddaa00', err: '#dd3333', link: '#66aaff',
    ...overrides,
  };
}

const VALID_ENTRY = {
  id: 'my-theme',
  fileName: 'my-theme.theme.md',
  theme: { schemaVersion: 1, name: 'My Custom Theme', description: 'A hand-rolled look.', extends: 'graphite' },
};

const INVALID_ENTRY = {
  id: 'broken',
  fileName: 'broken.theme.md',
  error: 'missing required field "extends"',
};

describe('ThemePicker — user theme files (theming Phase 5)', () => {
  beforeEach(() => {
    resetDocument();
    listUserThemes.mockReset().mockResolvedValue([]);
    revealThemesDir.mockReset().mockResolvedValue(undefined);
    createExampleUserTheme.mockReset();
  });

  it('renders a valid user theme as a card in its own labelled radiogroup, badged Custom', async () => {
    listUserThemes.mockResolvedValue([VALID_ENTRY]);
    render(<ThemePicker />);

    const group = await screen.findByRole('radiogroup', { name: 'Your themes' });
    const card = within(group).getByRole('radio', { name: /My Custom Theme/ });
    expect(within(card).getByText('Custom')).toBeInTheDocument();
    expect(within(card).getByText('A hand-rolled look.')).toBeInTheDocument();
  });

  it('selecting a user theme card applies it and marks it checked', async () => {
    listUserThemes.mockResolvedValue([VALID_ENTRY]);
    render(<ThemePicker />);

    const card = await screen.findByRole('radio', { name: /My Custom Theme/ });
    fireEvent.click(card);

    expect(card).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem('conduit:v10-user-theme')).toBe('my-theme');
    expect(document.documentElement.getAttribute('data-palette')).toBe('graphite');
    // Every built-in card is now unchecked.
    for (const radio of screen.getAllByRole('radio')) {
      if (radio !== card) expect(radio).toHaveAttribute('aria-checked', 'false');
    }
  });

  it('lists an invalid file as plain text, not a selectable card', async () => {
    listUserThemes.mockResolvedValue([INVALID_ENTRY]);
    render(<ThemePicker />);

    expect(await screen.findByText(/broken\.theme\.md/)).toBeInTheDocument();
    expect(screen.getByText(/missing required field/)).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /broken/i })).not.toBeInTheDocument();
  });

  it('degrades to the empty-state line when the command rejects (dev:web has no backend)', async () => {
    listUserThemes.mockRejectedValue('command list_user_themes not found');
    render(<ThemePicker />);

    expect(await screen.findByText('No custom themes yet.')).toBeInTheDocument();
    // The actions still render — reload/open/create are not gated on a backend.
    expect(screen.getByRole('button', { name: 'Open themes folder' })).toBeInTheDocument();
  });

  it('keyboard nav continues from the last built-in card into the first user card', async () => {
    listUserThemes.mockResolvedValue([VALID_ENTRY]);
    render(<ThemePicker />);
    await screen.findByRole('radio', { name: /My Custom Theme/ });

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(THEMES.length + 1);
    const lastBuiltin = radios[THEMES.length - 1];
    const firstUser = radios[THEMES.length];

    lastBuiltin.focus();
    fireEvent.keyDown(lastBuiltin, { key: 'ArrowRight' });
    expect(firstUser).toHaveFocus();
    expect(firstUser).toHaveAttribute('aria-checked', 'true');
  });

  it('Reload surfaces a command failure inline rather than throwing', async () => {
    listUserThemes.mockResolvedValueOnce([]);
    render(<ThemePicker />);
    await waitFor(() => expect(listUserThemes).toHaveBeenCalledTimes(1));

    listUserThemes.mockRejectedValueOnce({ code: 'error.unknown', params: {}, fallback: 'disk read failed' });
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));

    expect(await screen.findByText('disk read failed')).toBeInTheDocument();
  });

  it('Create example theme creates, reloads, and selects the new theme', async () => {
    listUserThemes.mockResolvedValueOnce([]).mockResolvedValueOnce([VALID_ENTRY]);
    createExampleUserTheme.mockResolvedValue('my-theme');
    render(<ThemePicker />);
    await waitFor(() => expect(listUserThemes).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Create example theme' }));

    const card = await screen.findByRole('radio', { name: /My Custom Theme/ });
    expect(card).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem('conduit:v10-user-theme')).toBe('my-theme');
  });

  it('Open themes folder calls the reveal command and reports a failure inline', async () => {
    render(<ThemePicker />);
    revealThemesDir.mockRejectedValueOnce({ code: 'error.unknown', params: {}, fallback: "couldn't open folder" });

    fireEvent.click(screen.getByRole('button', { name: 'Open themes folder' }));

    expect(await screen.findByText("couldn't open folder")).toBeInTheDocument();
    expect(revealThemesDir).toHaveBeenCalledTimes(1);
  });

  it('an unknown-base user theme is listed as invalid with every valid id named', async () => {
    listUserThemes.mockResolvedValue([
      {
        id: 'bad-base',
        fileName: 'bad-base.theme.md',
        theme: { schemaVersion: 1, name: 'Bad Base', extends: 'not-a-real-theme' },
      },
    ]);
    render(<ThemePicker />);

    expect(await screen.findByText(/not-a-real-theme/)).toBeInTheDocument();
    expect(screen.getByText(/conduit-orange-charcoal/)).toBeInTheDocument();
  });

  it('a two-mode palette override on a dark-only base narrows the single-mode badge', async () => {
    listUserThemes.mockResolvedValue([
      {
        id: 'my-theme',
        fileName: 'my-theme.theme.md',
        theme: {
          schemaVersion: 1,
          name: 'Recolored Amber',
          extends: 'amber-terminal',
          palette: { dark: fullPalette() },
        },
      },
    ]);
    render(<ThemePicker />);

    const card = await screen.findByRole('radio', { name: /Recolored Amber/ });
    expect(within(card).getByText('Dark only')).toBeInTheDocument();
  });
});
