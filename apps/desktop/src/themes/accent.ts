/**
 * The main colour (accent) override — ADR-011's one user-adjustable colour.
 *
 * The user picks one base colour per mode (`AppSettings.accent`). Everything
 * else in the accent family is derived here, against that mode's actual
 * surfaces, so a custom colour can never produce illegible text:
 *
 *   --accent        the base, used for fills and graphics (3:1 on every surface)
 *   --accent-text   the base, lightened (dark) or darkened (light) until it is
 *                   AA-legible as text on every surface
 *   --on-accent     white or near-black, whichever reads better on the base (AA)
 *   --accent-soft   selected fills;  --accent-line  selected borders
 *   --glow-color    the logo halo / ambient glow
 *
 * A colour that cannot meet those floors is refused (`deriveAccent` returns
 * the reason), and the default accent stays.
 *
 * The derived values are set inline on <html>, which outranks both mode
 * blocks in tokens.css; `--hue` and friends are declared as `var(--accent…)`
 * on :root, so they follow. A white-label brand owns the palette while active,
 * so the override stands down for it.
 */
import type { AccentOverride } from '@conduit/config-schema';
import { isBrandActive, THEME_CHANGED_EVENT } from '../shell/uiPrefs';

export type AccentMode = 'dark' | 'light';

/** The design's own accent per mode (tokens.css; tokenContrast.test.ts). */
export const DEFAULT_ACCENT: Record<AccentMode, string> = { dark: '#ff7a59', light: '#4b4ded' };

/** Every surface text can sit on, per mode: --bg, --bg-side, --card, --card-hi.
 *  accent.test.ts checks these against tokens.css so they cannot drift. */
export const ACCENT_SURFACES: Record<AccentMode, readonly string[]> = {
  dark: ['#0b0d12', '#10131a', '#11141b', '#161a23'],
  light: ['#f6f6f8', '#eff0f4', '#ffffff', '#f1f2f5'],
};

/** Curated choices per mode, default first. Each is valid in its mode
 *  (accent.test.ts). Same seven hues in both modes, tuned per mode. */
export const ACCENT_SWATCHES: Record<AccentMode, readonly string[]> = {
  dark: ['#ff7a59', '#8b8dff', '#5ab4ff', '#2fd3b5', '#c08cff', '#f5b53d', '#ff6fae'],
  light: ['#4b4ded', '#c23a1f', '#1672d4', '#0b7a67', '#7a3fd0', '#a15c00', '#c0307a'],
};

const AA = 4.5;
const AA_NON_TEXT = 3;
const HEX6 = /^#[0-9a-f]{6}$/;
const NEAR_BLACK = '#111318';

export interface AccentFamily {
  accent: string;
  accentText: string;
  onAccent: string;
  accentSoft: string;
  accentLine: string;
  glowColor: string;
}

export type AccentVerdict =
  | { ok: true; family: AccentFamily }
  | { ok: false; reason: 'format' | 'lowContrast' };

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(hex: string): number {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `share` of `a` mixed into `b`, in sRGB (what `color-mix(in srgb, …)` does). */
function mix(a: string, b: string, share: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex([0, 1, 2].map((i) => x[i] * share + y[i] * (1 - share)) as [number, number, number]);
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = rgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

function minContrast(colour: string, surfaces: readonly string[]): number {
  return Math.min(...surfaces.map((s) => contrast(colour, s)));
}

/** Derive the accent family for `raw` in `mode`, or say why it is refused. */
export function deriveAccent(raw: string, mode: AccentMode): AccentVerdict {
  const base = raw.trim().toLowerCase();
  if (!HEX6.test(base)) return { ok: false, reason: 'format' };
  const surfaces = ACCENT_SURFACES[mode];
  if (minContrast(base, surfaces) < AA_NON_TEXT) return { ok: false, reason: 'lowContrast' };

  const onAccent = contrast('#ffffff', base) >= contrast(NEAR_BLACK, base) ? '#ffffff' : NEAR_BLACK;
  if (contrast(onAccent, base) < AA) return { ok: false, reason: 'lowContrast' };

  // Walk toward white (dark mode) or black (light mode) until the text form
  // clears AA on every surface. The base already clears 3:1, so this always
  // terminates well before the end of the walk.
  const toward = mode === 'dark' ? '#ffffff' : '#000000';
  let accentText = base;
  for (let step = 1; step <= 20 && minContrast(accentText, surfaces) < AA; step += 1) {
    accentText = mix(toward, base, step * 0.05);
  }

  return {
    ok: true,
    family: {
      accent: base,
      accentText,
      onAccent,
      accentSoft: mode === 'dark' ? rgba(base, 0.14) : mix(base, '#ffffff', 0.1),
      accentLine: mode === 'dark' ? rgba(base, 0.4) : mix(base, '#ffffff', 0.28),
      glowColor: rgba(base, mode === 'dark' ? 0.16 : 0.1),
    },
  };
}

const PROPERTIES: Record<keyof AccentFamily, string> = {
  accent: '--accent',
  accentText: '--accent-text',
  onAccent: '--on-accent',
  accentSoft: '--accent-soft',
  accentLine: '--accent-line',
  glowColor: '--glow-color',
};

const CACHE_KEY = 'conduit:v11-accent';

function clearInline(): void {
  const style = document.documentElement.style;
  for (const prop of Object.values(PROPERTIES)) style.removeProperty(prop);
}

/**
 * Apply `override` for `mode` to <html>, or clear it. Idempotent. Returns the
 * family applied, or null when the default accent is in effect (no override,
 * a refused colour, or an active white-label brand).
 */
export function applyAccent(override: AccentOverride | undefined, mode: AccentMode): AccentFamily | null {
  if (typeof document === 'undefined') return null;
  const before = document.documentElement.style.getPropertyValue('--accent');
  let applied: AccentFamily | null = null;
  const raw = override?.[mode];
  if (!isBrandActive() && raw) {
    const verdict = deriveAccent(raw, mode);
    if (verdict.ok) applied = verdict.family;
  }
  if (applied) {
    const style = document.documentElement.style;
    for (const [key, prop] of Object.entries(PROPERTIES) as [keyof AccentFamily, string][]) {
      style.setProperty(prop, applied[key]);
    }
  } else {
    clearInline();
  }
  try {
    if (override?.dark || override?.light) localStorage.setItem(CACHE_KEY, JSON.stringify(override));
    else localStorage.removeItem(CACHE_KEY);
  } catch {
    /* storage unavailable */
  }
  // Renderers that read resolved tokens (Mermaid) repaint on this event.
  if (document.documentElement.style.getPropertyValue('--accent') !== before) {
    try {
      window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT));
    } catch {
      /* non-browser environments */
    }
  }
  return applied;
}

/** Pre-paint replay (main.tsx): the settings that hold the override arrive
 *  over IPC, after first paint; the cache avoids a frame of the default. */
export function applyCachedAccent(mode: AccentMode): void {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (!cached) return;
    const parsed = JSON.parse(cached) as AccentOverride;
    applyAccent(
      {
        dark: typeof parsed.dark === 'string' ? parsed.dark : undefined,
        light: typeof parsed.light === 'string' ? parsed.light : undefined,
      },
      mode,
    );
  } catch {
    /* a corrupt cache just means the default accent for one frame */
  }
}
