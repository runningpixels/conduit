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

export const LOOK_IDS = ['soft', 'terminal', 'editorial', 'contrast'] as const;
export type LookId = (typeof LOOK_IDS)[number];

export const PALETTE_IDS = [
  'terra',
  'orange-charcoal',
  'orange-dark',
  'amber',
  'phosphor',
  'paper',
  'graphite',
  'newsprint',
  'contrast',
] as const;
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
  {
    id: 'green-phosphor',
    i18nKey: 'greenPhosphor',
    look: 'terminal',
    palette: 'phosphor',
    modes: ['dark'],
    swatches: ['#020803', '#09140b', '#b6f7c4', '#39ff6a'],
    mermaid: 'tokens',
    iframe: 'tokens',
  },
  {
    id: 'amber-paper',
    i18nKey: 'amberPaper',
    look: 'terminal',
    palette: 'paper',
    modes: ['light'],
    swatches: ['#f4efe3', '#fbf8f0', '#1b1812', '#8a4d00'],
    mermaid: 'tokens',
    iframe: 'tokens',
  },
  {
    id: 'graphite',
    i18nKey: 'graphite',
    look: 'soft',
    palette: 'graphite',
    modes: ['dark', 'light'],
    swatches: ['#1c1c1e', '#252527', '#ededee', '#d4d4d8'],
    mermaid: 'tokens',
    iframe: 'tokens',
  },
  {
    id: 'editorial',
    i18nKey: 'editorial',
    look: 'editorial',
    palette: 'newsprint',
    modes: ['light', 'dark'],
    swatches: ['#f6f3ee', '#fbfaf7', '#1f1c19', '#a3222b'],
    mermaid: 'tokens',
    iframe: 'tokens',
  },
  {
    id: 'high-contrast',
    i18nKey: 'highContrast',
    look: 'contrast',
    palette: 'contrast',
    modes: ['dark', 'light'],
    swatches: ['#000000', '#0a0a0a', '#ffffff', '#ffd400'],
    mermaid: 'tokens',
    iframe: 'tokens',
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
 * Modes a look × palette pairing can render. A palette designed for one mode
 * (amber and phosphor are dark, paper is light) cannot render the other no
 * matter which look carries it, so a pairing's modes are the union of the
 * modes its palette's manifests declare. Palettes no manifest names default
 * to both.
 */
export function modesForPalette(palette: PaletteId): readonly Mode[] {
  const named = THEMES.filter((t) => t.palette === palette);
  if (named.length === 0) return ['dark', 'light'];
  const union = (['dark', 'light'] as const).filter((m) => named.some((t) => t.modes.includes(m)));
  return union;
}
