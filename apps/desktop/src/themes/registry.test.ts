/**
 * Theme registry guard (theming Phase 2). Structural invariants over
 * `THEMES` itself, plus the two derivation helpers (`modesForPalette`,
 * `themeForPair`) that keep `readThemeId`/`selectTheme` (shell/uiPrefs.ts)
 * honest.
 */
import { describe, expect, it } from 'vitest';
import enMessages from '../i18n/messages/en.json';
import {
  DEFAULT_THEME_ID,
  LOOK_IDS,
  PALETTE_IDS,
  THEMES,
  isLookId,
  isPaletteId,
  modesForPalette,
  themeById,
  themeForPair,
  type PaletteId,
} from './registry';

const en = enMessages as Record<string, string>;
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

describe('THEMES', () => {
  it('has at least one manifest', () => {
    expect(THEMES.length).toBeGreaterThan(0);
  });

  it('has unique ids', () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('DEFAULT_THEME_ID names a real manifest', () => {
    expect(themeById(DEFAULT_THEME_ID)).toBeDefined();
  });

  it('themeById returns undefined for an id no manifest carries', () => {
    expect(themeById('not-a-real-theme-id')).toBeUndefined();
  });

  it('every manifest\'s look is a registered LookId', () => {
    for (const t of THEMES) {
      expect(isLookId(t.look), `${t.id}: look "${t.look}" is not in LOOK_IDS`).toBe(true);
    }
  });

  it('every manifest\'s palette is a registered PaletteId', () => {
    for (const t of THEMES) {
      expect(isPaletteId(t.palette), `${t.id}: palette "${t.palette}" is not in PALETTE_IDS`).toBe(true);
    }
  });

  it('no two manifests share the same look × palette pair', () => {
    const pairs = THEMES.map((t) => `${t.look}::${t.palette}`);
    expect(new Set(pairs).size, 'a pair with two names is ambiguous for readThemeId').toBe(
      pairs.length,
    );
  });

  it('every manifest declares at least one mode, drawn only from dark/light', () => {
    for (const t of THEMES) {
      expect(t.modes.length, `${t.id}: modes must not be empty`).toBeGreaterThan(0);
      for (const m of t.modes) {
        expect(['dark', 'light'], `${t.id}: unknown mode "${m}"`).toContain(m);
      }
      expect(new Set(t.modes).size, `${t.id}: duplicate mode in modes`).toBe(t.modes.length);
    }
  });

  it('every manifest has exactly four valid hex swatches', () => {
    for (const t of THEMES) {
      expect(t.swatches, `${t.id}: swatches`).toHaveLength(4);
      for (const swatch of t.swatches) {
        expect(swatch, `${t.id}: swatch "${swatch}" is not a valid hex colour`).toMatch(HEX);
      }
    }
  });

  it("every manifest's i18nKey has a name and description in en.json", () => {
    // The UI agent lands `settings.appearance.themes.<key>.{name,description}`
    // in a parallel change; until that merges this assertion is expected red
    // (see the desktop AGENTS/PR note), not a bug in this test.
    for (const t of THEMES) {
      const nameKey = `settings.appearance.themes.${t.i18nKey}.name`;
      const descKey = `settings.appearance.themes.${t.i18nKey}.description`;
      expect(en[nameKey], `missing en.json key ${nameKey}`).toBeTruthy();
      expect(en[descKey], `missing en.json key ${descKey}`).toBeTruthy();
    }
  });
});

describe('modesForPalette', () => {
  it('returns both modes for a palette no manifest names', () => {
    expect(modesForPalette('not-a-real-palette' as PaletteId)).toEqual(['dark', 'light']);
  });

  it('matches the union of modes across every manifest naming a given palette', () => {
    // Not every named palette's manifests include a dark mode (`paper` is
    // light-only), so the expectation is the true union over dark/light —
    // never dark-by-default just because a manifest names light too.
    for (const id of PALETTE_IDS) {
      const named = THEMES.filter((t) => t.palette === id);
      if (named.length === 0) continue;
      const expected = (['dark', 'light'] as const).filter((m) => named.some((t) => t.modes.includes(m)));
      expect(modesForPalette(id)).toEqual(expected);
    }
  });

  it('never returns an empty list', () => {
    for (const id of PALETTE_IDS) {
      expect(modesForPalette(id).length).toBeGreaterThan(0);
    }
  });
});

describe('themeForPair', () => {
  it('finds the manifest naming an existing pair', () => {
    for (const t of THEMES) {
      expect(themeForPair(t.look, t.palette)?.id).toBe(t.id);
    }
  });

  it('returns undefined for a pair no manifest names', () => {
    // Cross a real palette with a look id no LOOK_ID actually is, which is
    // exactly "no manifest names this pair" from themeForPair's point of
    // view — true regardless of how many real look × palette pairs exist.
    expect(themeForPair('not-a-real-look' as never, PALETTE_IDS[0])).toBeUndefined();
  });
});

describe('isLookId / isPaletteId', () => {
  it('accept only registered ids', () => {
    for (const id of LOOK_IDS) expect(isLookId(id)).toBe(true);
    for (const id of PALETTE_IDS) expect(isPaletteId(id)).toBe(true);
    expect(isLookId('nope')).toBe(false);
    expect(isPaletteId('nope')).toBe(false);
    expect(isLookId(42)).toBe(false);
    expect(isPaletteId(undefined)).toBe(false);
  });
});
