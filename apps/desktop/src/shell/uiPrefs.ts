/**
 * V7 renderer-only UI preferences.
 *
 * These are *presentation* preferences, not app settings: they are not part
 * of AppSettings / config-schema (CANONICAL_SCHEMA_VERSION stays 1), so they
 * live in localStorage exactly like the existing layout prefs (conduit:v5-*).
 *
 * Each pref is read/written via a small typed helper and, where it changes
 * document-level styling, applied as an attribute on <html> so the CSS in
 * tokens.css / styles.css can react without React re-rendering.
 */

import {
  CUSTOM_THEME_ID,
  LOOK_IDS,
  PALETTE_IDS,
  modesForPalette,
  themeById,
  themeForPair,
  type LookId,
  type Mode,
  type PaletteId,
} from '../themes/registry';
import {
  readSelectedUserThemeId,
  readUserThemeCache,
  USER_THEME_PREFIX,
} from '../themes/userThemeStorage';

const PALETTE_KEY = 'conduit:v9-palette';
const LOOK_KEY = 'conduit:v10-look';
const PROVIDER_COLOUR_KEY = 'conduit:v7-provider-colour';
const REDUCE_MOTION_KEY = 'conduit:v7-reduce-motion';
const SHOW_REASONING_KEY = 'conduit:v7-show-reasoning';
const SEND_WITH_KEY = 'conduit:v7-send-with';
const EXPORT_METADATA_KEY = 'conduit:v7-export-metadata';
const EXPANDED_STATUS_KEY = 'conduit:v9-expanded-status';
const MERMAID_SCALE_KEY = 'conduit:v9-mermaid-scale';

export type PalettePref = PaletteId;
export type LookPref = LookId;
export type ProviderColourPref = 'on' | 'off';
export type ReduceMotionPref = 'on' | 'off';
export type ShowReasoningPref = 'on' | 'off';
export type SendWithPref = 'enter' | 'cmd-enter';
export type ExportMetadataPref = 'on' | 'off';
export type ExpandedStatusPref = 'on' | 'off';
/** Display scale for Mermaid blob images (viewBox width/height multiplier). */
export type MermaidScalePref = 'compact' | 'default' | 'full';

export const MERMAID_DISPLAY_SCALES: Record<MermaidScalePref, number> = {
  compact: 0.75,
  default: 0.85,
  full: 1,
};

function readPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v != null && (allowed as readonly string[]).includes(v)) return v as T;
  } catch {
    /* storage unavailable */
  }
  return fallback;
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage may be unavailable; fail silently */
  }
}

/* ── Palette ─────────────────────────────────────────────────────────────────────
 * A look, orthogonal to `data-theme`: `orange-charcoal` is the darker
 * near-neutral charcoal with terracotta pinned and serif prose; `orange-dark`
 * is Claude's live canvas (warmer, two steps lighter) with the same terracotta
 * and serif; `terra` is the V9 warm-charcoal register that keeps provider
 * colour as the only hue. Six combinations, since every palette runs in either
 * theme.
 *
 * `orange-charcoal` is the default look. It suspends what V9 §3 called the
 * product's signature — provider identity as the only hue — in favour of one
 * calmer identity out of the box; `terra` stays one selection away for anyone
 * who wants provider colour back, and `orange-dark` for anyone who wants the
 * Claude match.
 *
 * Stored values migrate: `conduit` → `terra` (the rename of the old default
 * look), `claude` → `orange-charcoal` (the rename of this one). Both preserve an
 * explicit choice across the rename rather than silently resetting it — and the
 * `claude` migration matters more than it looks: without it, everyone who had
 * chosen this palette would land back on the fallback, which is now the same
 * look, so the bug would be invisible until they picked `terra`. `orange-dark`
 * is a new look, not a rename of `claude`.
 *
 * Renderer-only for the same reason the prefs below are: AppSettings.theme is a
 * Rust enum crossing the IPC boundary, and a look preset does not need to be.
 */

export function readPalette(): PalettePref {
  try {
    const v = localStorage.getItem(PALETTE_KEY);
    if (v === 'conduit') return 'terra';
    if (v === 'claude') return 'orange-charcoal';
  } catch {
    /* storage unavailable */
  }
  return readPref(PALETTE_KEY, PALETTE_IDS, 'orange-charcoal');
}

export function writePalette(value: PalettePref): void {
  writePref(PALETTE_KEY, value);
  if (!isBrandActive()) applyPalette(value);
  notifyThemeChanged();
}

/** `html[data-palette]` swaps surfaces, hue, and (for the terracotta looks) the prose face. */
export function applyPalette(value: PalettePref): void {
  document.documentElement.setAttribute('data-palette', value);
}

/* ── Look (theming, docs/theming/README.md) ─────────────────────────────────
 * The structural axis beside the palette: type, radii, borders, elevation,
 * motion. `soft` is the product's own look and the default. A look and a
 * palette together are a theme (themes/registry.ts); the two are stored
 * separately so Appearance → Advanced can mix them, and so the palette key
 * keeps meaning exactly what it meant before looks existed (applyBrand.ts
 * restores it on clearBrand). */

/** Fired on `window` whenever the look or palette changes, so the mode can be
 *  re-resolved (a dark-only palette forces dark) and renderers that cannot read
 *  CSS variables (Mermaid, the artifact iframe) can repaint. */
export const THEME_CHANGED_EVENT = 'conduit:theme-changed';

function notifyThemeChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT));
  } catch {
    /* non-browser environments */
  }
}

/** A white-label brand owns the palette while active (applyBrand.ts sets
 *  `data-palette="brand"`); the user's stored palette waits underneath. */
export function isBrandActive(): boolean {
  try {
    return document.documentElement.getAttribute('data-palette') === 'brand';
  } catch {
    return false;
  }
}

export function readLook(): LookPref {
  return readPref(LOOK_KEY, LOOK_IDS, 'soft');
}

export function writeLook(value: LookPref): void {
  writePref(LOOK_KEY, value);
  applyLook(value);
  notifyThemeChanged();
}

/** `html[data-look]` retargets structural tokens and enables the look's sheet. */
export function applyLook(value: LookPref): void {
  document.documentElement.setAttribute('data-look', value);
}

/** The theme the stored look × palette pairing names, or `custom`. Derived,
 *  never stored, so it cannot drift from the two prefs it describes.
 *
 *  A user theme (theming Phase 5) is checked first: its id is stored
 *  separately (`conduit:v10-user-theme`, `themes/userThemeStorage.ts`) from
 *  the look/palette pair, which stay pointed at the theme it extends so a
 *  reader that only knows about built-ins still renders something sane. Only
 *  reported here when the pre-paint cache still names the same id — a
 *  selected-but-now-invalid user theme (its file deleted, its cache cleared)
 *  must fall back to `custom`/the pair, not claim an id `themeById` cannot
 *  resolve; `App.tsx`'s boot reconcile is what actually clears the stale
 *  pref once it can ask Rust. */
export function readThemeId(): string {
  const userId = readSelectedUserThemeId();
  if (userId !== null) {
    const cached = readUserThemeCache();
    if (cached && cached.id === userId) return `${USER_THEME_PREFIX}${userId}`;
  }
  return themeForPair(readLook(), readPalette())?.id ?? CUSTOM_THEME_ID;
}

/** Select a named theme: writes both axes at once and notifies once. */
export function selectTheme(id: string): void {
  const theme = themeById(id);
  if (!theme) return;
  writePref(LOOK_KEY, theme.look);
  writePref(PALETTE_KEY, theme.palette);
  applyLook(theme.look);
  if (!isBrandActive()) applyPalette(theme.palette);
  notifyThemeChanged();
}

/**
 * Modes the active look × palette can render. A brand declares both a dark
 * and a light palette (the brand schema requires it), so it never narrows.
 *
 * A selected user theme (theming Phase 5) answers this itself — its modes
 * are whichever palette modes its file overrides, or its base theme's modes
 * when it overrides none (`themes/userThemes.ts`'s `resolveUserTheme`) — read
 * straight from the pre-paint cache rather than re-resolving, so this stays
 * as cheap as the built-in path and does not need IPC. Falls through to the
 * ordinary look × palette answer once the cache no longer names the selected
 * id, same as `readThemeId` above.
 */
export function supportedModes(): readonly Mode[] {
  if (isBrandActive()) return ['dark', 'light'];
  const userId = readSelectedUserThemeId();
  if (userId !== null) {
    const cached = readUserThemeCache();
    if (cached && cached.id === userId) return cached.modes;
  }
  return modesForPalette(readPalette());
}

/* ── Reading font ────────────────────────────────────────────────────────
 * Overrides the face of assistant prose (--font-prose) regardless of theme.
 * `theme` defers to whatever the look and palette chose — which for the
 * terminal look is mono, and for long answers some people want out of that.
 * Applied as `html[data-reading-font]` (chat.css). */

const READING_FONT_KEY = 'conduit:v10-reading-font';
export type ReadingFontPref = 'theme' | 'sans' | 'serif';

export function readReadingFont(): ReadingFontPref {
  return readPref(READING_FONT_KEY, ['theme', 'sans', 'serif'], 'theme');
}

export function writeReadingFont(value: ReadingFontPref): void {
  writePref(READING_FONT_KEY, value);
  applyReadingFont(value);
}

export function applyReadingFont(value: ReadingFontPref): void {
  document.documentElement.setAttribute('data-reading-font', value);
}

/* ── Provider colour ──────────────────────────────────────────────────── */

export function readProviderColour(): ProviderColourPref {
  return readPref(PROVIDER_COLOUR_KEY, ['on', 'off'], 'on');
}

export function writeProviderColour(value: ProviderColourPref): void {
  writePref(PROVIDER_COLOUR_KEY, value);
  applyProviderColour(value);
}

/** `html[data-provider-colour="off"]` pins --hue to the neutral ink scale. */
export function applyProviderColour(value: ProviderColourPref): void {
  document.documentElement.setAttribute('data-provider-colour', value);
}

/* ── Reduce motion ────────────────────────────────────────────────────── */

export function readReduceMotion(): ReduceMotionPref {
  return readPref(REDUCE_MOTION_KEY, ['on', 'off'], 'off');
}

export function writeReduceMotion(value: ReduceMotionPref): void {
  writePref(REDUCE_MOTION_KEY, value);
  applyReduceMotion(value);
}

/** `html[data-reduce-motion="on"]` collapses durations + stops the caret. */
export function applyReduceMotion(value: ReduceMotionPref): void {
  document.documentElement.setAttribute('data-reduce-motion', value);
}

/* ── Show reasoning (chat default) ────────────────────────────────────── */

/** Fired on `window` when the always-show/always-hide pref changes. */
export const SHOW_REASONING_CHANGED_EVENT = 'conduit:show-reasoning-changed';

export function readShowReasoning(): ShowReasoningPref {
  return readPref(SHOW_REASONING_KEY, ['on', 'off'], 'on');
}

export function writeShowReasoning(value: ShowReasoningPref): void {
  writePref(SHOW_REASONING_KEY, value);
  try {
    window.dispatchEvent(new CustomEvent(SHOW_REASONING_CHANGED_EVENT, { detail: value }));
  } catch {
    /* non-browser / storage-only environments */
  }
}

/* ── Send with (composer key) ─────────────────────────────────────────── */

export function readSendWith(): SendWithPref {
  return readPref(SEND_WITH_KEY, ['enter', 'cmd-enter'], 'enter');
}

export function writeSendWith(value: SendWithPref): void {
  writePref(SEND_WITH_KEY, value);
}

/* ── Export metadata sidecar (document panel ⋯ menu → Save a copy…) ──── */

export function readExportMetadata(): ExportMetadataPref {
  return readPref(EXPORT_METADATA_KEY, ['on', 'off'], 'on');
}

export function writeExportMetadata(value: ExportMetadataPref): void {
  writePref(EXPORT_METADATA_KEY, value);
}

/* ── Live document preview while writing ───────────────────────────────── */

const DOCUMENT_PEEK_KEY = 'conduit:v10-document-peek';
export type DocumentPeekPref = 'on' | 'off';

/** Off by default: the pending panel shows progress, not the document. */
export function readDocumentPeek(): DocumentPeekPref {
  return readPref(DOCUMENT_PEEK_KEY, ['on', 'off'], 'off');
}

export function writeDocumentPeek(value: DocumentPeekPref): void {
  writePref(DOCUMENT_PEEK_KEY, value);
}

/* ── Expanded status line (V9 §2.2 / §10.1) ───────────────────────────────
 * V9 collapses five always-on provenance chips into one muted sentence, and
 * §10.1 names the honest risk: the always-on cost/context readout was the most
 * power-user thing about V8, and some people will miss it at a glance. The
 * spec's own answer is this toggle rather than reverting the strip — same
 * facts, the same line re-inflated, no layout change.
 *
 * Shipped up front instead of after a dogfooding round, because the collapse is
 * the part that needs an escape hatch on day one, not the part that needs
 * proving. Renderer-only, so it lives here rather than in AppSettings. */

export function readExpandedStatus(): ExpandedStatusPref {
  return readPref(EXPANDED_STATUS_KEY, ['on', 'off'], 'off');
}

export function writeExpandedStatus(value: ExpandedStatusPref): void {
  writePref(EXPANDED_STATUS_KEY, value);
  applyExpandedStatus(value);
}

/** `html[data-expanded-status="on"]` widens the status line's register. */
export function applyExpandedStatus(value: ExpandedStatusPref): void {
  document.documentElement.setAttribute('data-expanded-status', value);
}

/* ── Mermaid diagram scale ───────────────────────────────────────────────
 * Mermaid's natural viewBox size reads large next to chat prose. We stamp a
 * display multiplier onto the SVG width/height (not a CSS transform) so the
 * layout box matches what you see. Renderer-only — same rationale as palette. */

export function readMermaidScale(): MermaidScalePref {
  return readPref(MERMAID_SCALE_KEY, ['compact', 'default', 'full'], 'default');
}

export function mermaidScaleFactor(pref: MermaidScalePref = readMermaidScale()): number {
  return MERMAID_DISPLAY_SCALES[pref];
}

export function writeMermaidScale(value: MermaidScalePref): void {
  writePref(MERMAID_SCALE_KEY, value);
  applyMermaidScale(value);
}

/** `html[data-mermaid-scale]` — MermaidBlock observes this to re-blob on change. */
export function applyMermaidScale(value: MermaidScalePref): void {
  document.documentElement.setAttribute('data-mermaid-scale', value);
}

/** Apply every document-level pref on boot (idempotent). */
export function applyUiPrefs(): void {
  applyLook(readLook());
  /* Unconditional, unlike the writers: App's boot calls this before it knows
   * whether the Rust-side brand still exists, then re-applies the brand if it
   * does — so a cached brand that has since been removed is cleared here. */
  applyPalette(readPalette());
  applyReadingFont(readReadingFont());
  applyProviderColour(readProviderColour());
  applyReduceMotion(readReduceMotion());
  applyExpandedStatus(readExpandedStatus());
  applyMermaidScale(readMermaidScale());
}
