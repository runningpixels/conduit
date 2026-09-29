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

const REDUCE_MOTION_KEY = 'conduit:v7-reduce-motion';
const SHOW_REASONING_KEY = 'conduit:v7-show-reasoning';
const SEND_WITH_KEY = 'conduit:v7-send-with';
const EXPORT_METADATA_KEY = 'conduit:v7-export-metadata';
const EXPANDED_STATUS_KEY = 'conduit:v9-expanded-status';
const MERMAID_SCALE_KEY = 'conduit:v9-mermaid-scale';

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

/* ── Theme events and white-label detection ───────────────────────────────
 * ADR-011 retired the look × palette themes: the only appearance choices left
 * are the mode (AppSettings.theme, Rust-canonical) and, later, the accent.
 * The event stays for anything that restyles tokens without touching
 * data-theme (a brand, an accent override), so renderers that cannot read CSS
 * variables live (Mermaid, the artifact iframe) can repaint. */
export const THEME_CHANGED_EVENT = 'conduit:theme-changed';

/** A white-label brand owns the palette while active (applyBrand.ts sets
 *  `data-palette="brand"` on <html>); nothing else sets that attribute now. */
export function isBrandActive(): boolean {
  try {
    return document.documentElement.getAttribute('data-palette') === 'brand';
  } catch {
    return false;
  }
}

/* ── One-time migration off the retired theme prefs (ADR-011) ──────────────
 * These keys held the look, the palette, the provider-colour switch, the
 * reading font and the user theme selection. A dark-only palette (Amber
 * Terminal, Green Phosphor) or light-only one (Amber Paper) used to force the
 * mode without writing AppSettings.theme, so someone on Amber Terminal with a
 * saved "light" saw dark. That forced mode is returned so boot can persist it,
 * and the keys are cleared so this runs once. */
const RETIRED_KEYS = [
  'conduit:v9-palette',
  'conduit:v10-look',
  'conduit:v7-provider-colour',
  'conduit:v10-reading-font',
  'conduit:v10-user-theme',
  'conduit:v10-user-theme-cache',
  // The rail is always labeled now (ADR-011 shell).
  'conduit:v11-rail',
] as const;

const DARK_ONLY_PALETTES = ['amber', 'phosphor'];
const LIGHT_ONLY_PALETTES = ['paper'];

/** The mode a retired single-mode theme was forcing, if any. Pure: reads only. */
export function retiredForcedMode(): 'dark' | 'light' | null {
  try {
    const cache = localStorage.getItem('conduit:v10-user-theme-cache');
    if (cache && localStorage.getItem('conduit:v10-user-theme')) {
      const modes = (JSON.parse(cache) as { modes?: unknown }).modes;
      if (Array.isArray(modes) && modes.length === 1 && (modes[0] === 'dark' || modes[0] === 'light')) {
        return modes[0];
      }
    }
    const palette = localStorage.getItem('conduit:v9-palette');
    if (palette && DARK_ONLY_PALETTES.includes(palette)) return 'dark';
    if (palette && LIGHT_ONLY_PALETTES.includes(palette)) return 'light';
  } catch {
    /* storage unavailable, or a corrupt cache: nothing to carry over */
  }
  return null;
}

/** Read the forced mode, then clear every retired key and attribute. Returns
 *  the mode boot should persist to AppSettings.theme, or null. */
export function migrateRetiredThemePrefs(): 'dark' | 'light' | null {
  const forced = retiredForcedMode();
  try {
    for (const key of RETIRED_KEYS) localStorage.removeItem(key);
  } catch {
    /* storage unavailable */
  }
  try {
    const html = document.documentElement;
    for (const attr of ['data-look', 'data-provider-colour', 'data-reading-font', 'data-user-palette', 'data-user-labels', 'data-rail']) {
      html.removeAttribute(attr);
    }
    if (!isBrandActive()) html.removeAttribute('data-palette');
  } catch {
    /* non-browser environments */
  }
  return forced;
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
 * layout box matches what you see. Renderer-only — renderer-only. */

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
  applyReduceMotion(readReduceMotion());
  applyExpandedStatus(readExpandedStatus());
  applyMermaidScale(readMermaidScale());
}

/* ── the model last used with each provider ─────────────────────────────── */

const LAST_MODEL_KEY = 'conduit:v10-last-model-by-provider';

/** The model the user last had selected with `providerId`, if remembered.
 *  Lets a switch back to a provider restore its model instead of taking
 *  whatever the listing happens to put first. */
export function readLastModel(providerId: string): string | undefined {
  try {
    const map = JSON.parse(localStorage.getItem(LAST_MODEL_KEY) ?? '{}') as Record<string, unknown>;
    const id = map[providerId];
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

export function writeLastModel(providerId: string, modelId: string): void {
  if (!providerId || !modelId) return;
  try {
    const map = JSON.parse(localStorage.getItem(LAST_MODEL_KEY) ?? '{}') as Record<string, string>;
    localStorage.setItem(LAST_MODEL_KEY, JSON.stringify({ ...map, [providerId]: modelId }));
  } catch {
    /* storage may be unavailable; forgetting is harmless */
  }
}
