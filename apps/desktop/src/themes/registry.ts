/**
 * Theme registry — what a user picks in Settings → Appearance.
 *
 * A theme is a named pairing of two orthogonal document attributes plus the
 * handful of behaviours CSS cannot express (docs/theming/README.md):
 *
 *   look     `html[data-look]`     structure: type, radii, borders, elevation,
 *                                  motion, chrome flourishes
 *   palette  `html[data-palette]`  colour: surfaces, ink, status, hue, syntax
 *
 * Mode (dark / light) stays `AppSettings.theme`; a theme only narrows which
 * modes it can render (`modes`). Look and palette can also be mixed freely
 * under Appearance → Advanced, which is why neither axis may declare the
 * other's tokens (lookContract.test.ts).
 *
 * Renderer-only, like the palette preference it grew out of (uiPrefs.ts): a
 * look preset does not need to cross the IPC boundary.
 */

export const LOOK_IDS = ['soft', 'terminal'] as const;
export type LookId = (typeof LOOK_IDS)[number];

export const PALETTE_IDS = ['terra', 'orange-charcoal', 'orange-dark', 'amber'] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];

export type Mode = 'dark' | 'light';

/**
 * How a third-party renderer that cannot read CSS variables gets its colours.
 *   native  the renderer's own dark/light theme (today's behaviour, pixel-stable)
 *   tokens  built from the resolved document tokens (follows any palette)
 */
export type RendererTheming = 'native' | 'tokens';

export interface ThemeManifest {
  id: string;
  /** i18n keys (`settings.appearance.themes.<key>.name` / `.description`). */
  i18nKey: string;
  look: LookId;
  palette: PaletteId;
  /** Modes this theme can render. A dark-only theme forces dark without
   *  touching the user's saved AppSettings.theme. */
  modes: readonly Mode[];
  /** Preview swatches for the picker card: [ground, surface, ink, accent]. */
  swatches: readonly [string, string, string, string];
  mermaid: RendererTheming;
  iframe: RendererTheming;
  /** Credit for a look adapted from another project. */
  inspiredBy?: { name: string; url: string; license: string };
}

export const THEMES: readonly ThemeManifest[] = [
  {
    id: 'conduit-orange-charcoal',
    i18nKey: 'orangeCharcoal',
    look: 'soft',
    palette: 'orange-charcoal',
    modes: ['dark', 'light'],
    swatches: ['#171716', '#222221', '#efece3', '#d97757'],
    mermaid: 'native',
    iframe: 'native',
  },
  {
    id: 'conduit-orange-dark',
    i18nKey: 'orangeDark',
    look: 'soft',
    palette: 'orange-dark',
    modes: ['dark', 'light'],
    swatches: ['#262624', '#30302e', '#faf9f5', '#d97757'],
    mermaid: 'native',
    iframe: 'native',
  },
  {
    id: 'conduit-terra',
    i18nKey: 'terra',
    look: 'soft',
    palette: 'terra',
    modes: ['dark', 'light'],
    // Terra's accent is whichever provider is active; the neutral ink-2 stands in.
    swatches: ['#262624', '#30302e', '#eceae2', '#c4c2ba'],
    mermaid: 'native',
    iframe: 'native',
  },
  {
    id: 'amber-terminal',
    i18nKey: 'amberTerminal',
    look: 'terminal',
    palette: 'amber',
    modes: ['dark'],
    swatches: ['#000000', '#111111', '#d9d9d9', '#ff9900'],
    mermaid: 'tokens',
    iframe: 'tokens',
    inspiredBy: {
      name: 'OpenTerminal',
      url: 'https://github.com/ErTasselli/OpenTerminal',
      license: 'MIT',
    },
  },
];

export const DEFAULT_THEME_ID = 'conduit-orange-charcoal';

/** The pseudo-theme id for an Advanced look × palette pairing no manifest names. */
export const CUSTOM_THEME_ID = 'custom';

export function isLookId(v: unknown): v is LookId {
  return typeof v === 'string' && (LOOK_IDS as readonly string[]).includes(v);
}

export function isPaletteId(v: unknown): v is PaletteId {
  return typeof v === 'string' && (PALETTE_IDS as readonly string[]).includes(v);
}

export function themeById(id: string): ThemeManifest | undefined {
  return THEMES.find((t) => t.id === id);
}

/** The manifest that names exactly this pairing, if any. */
export function themeForPair(look: LookId, palette: PaletteId): ThemeManifest | undefined {
  return THEMES.find((t) => t.look === look && t.palette === palette);
}

/**
 * Modes a look × palette pairing can render. A palette that ships only a dark
 * block (amber) cannot render light no matter which look carries it, so the
 * pairing's modes are the palette's. Palettes no manifest names default to both.
 */
export function modesForPalette(palette: PaletteId): readonly Mode[] {
  const named = THEMES.filter((t) => t.palette === palette);
  if (named.length === 0) return ['dark', 'light'];
  return named.some((t) => t.modes.includes('light')) ? ['dark', 'light'] : ['dark'];
}
