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

const PROVIDER_COLOUR_KEY = 'conduit:v7-provider-colour';
const REDUCE_MOTION_KEY = 'conduit:v7-reduce-motion';
const SHOW_REASONING_KEY = 'conduit:v7-show-reasoning';
const SEND_WITH_KEY = 'conduit:v7-send-with';

export type ProviderColourPref = 'on' | 'off';
export type ReduceMotionPref = 'on' | 'off';
export type ShowReasoningPref = 'on' | 'off';
export type SendWithPref = 'enter' | 'cmd-enter';

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

export function readShowReasoning(): ShowReasoningPref {
  return readPref(SHOW_REASONING_KEY, ['on', 'off'], 'off');
}

export function writeShowReasoning(value: ShowReasoningPref): void {
  writePref(SHOW_REASONING_KEY, value);
}

/* ── Send with (composer key) ─────────────────────────────────────────── */

export function readSendWith(): SendWithPref {
  return readPref(SEND_WITH_KEY, ['enter', 'cmd-enter'], 'enter');
}

export function writeSendWith(value: SendWithPref): void {
  writePref(SEND_WITH_KEY, value);
}

/** Apply every document-level pref on boot (idempotent). */
export function applyUiPrefs(): void {
  applyProviderColour(readProviderColour());
  applyReduceMotion(readReduceMotion());
}
