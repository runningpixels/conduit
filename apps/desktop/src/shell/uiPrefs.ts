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

const PALETTE_KEY = 'conduit:v9-palette';
const PROVIDER_COLOUR_KEY = 'conduit:v7-provider-colour';
const REDUCE_MOTION_KEY = 'conduit:v7-reduce-motion';
const SHOW_REASONING_KEY = 'conduit:v7-show-reasoning';
const SEND_WITH_KEY = 'conduit:v7-send-with';
const EXPORT_METADATA_KEY = 'conduit:v7-export-metadata';
const EXPANDED_STATUS_KEY = 'conduit:v9-expanded-status';
const MERMAID_SCALE_KEY = 'conduit:v9-mermaid-scale';

export type PalettePref = 'terra' | 'orange-charcoal' | 'orange-dark';
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
  return readPref(PALETTE_KEY, ['terra', 'orange-charcoal', 'orange-dark'], 'orange-charcoal');
}

export function writePalette(value: PalettePref): void {
  writePref(PALETTE_KEY, value);
  applyPalette(value);
}

/** `html[data-palette]` swaps surfaces, hue, and (for the terracotta looks) the prose face. */
export function applyPalette(value: PalettePref): void {
  document.documentElement.setAttribute('data-palette', value);
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
  applyPalette(readPalette());
  applyProviderColour(readProviderColour());
  applyReduceMotion(readReduceMotion());
  applyExpandedStatus(readExpandedStatus());
  applyMermaidScale(readMermaidScale());
}
