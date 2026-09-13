/**
 * Theming Phase 5 (user theme files, docs/theming/decisions.md S7) —
 * resolving a validated `UserTheme` (Rust-parsed `<id>.theme.md`) against the
 * built-in registry, and applying it to the DOM.
 *
 * ── Security model (S7: reuse the brand pipeline, no new attack surface) ──
 * Exactly like `brand/applyBrand.ts`: colour values only ever reach the DOM
 * through `documentElement.style.setProperty` on the fixed
 * `PALETTE_PROPERTY_MAP` allowlist, re-validated against the hex grammar
 * here even though Rust already validated the file — the pre-paint cache is
 * not Rust-validated on every read, so it gets the same defence-in-depth
 * re-check a live IPC value gets. Structural choices (`UserThemeStructure`)
 * are a **closed enum**, not free text: every field is looked up in a fixed
 * table below and only the table's own token names/values ever reach
 * `setProperty`. A theme file can therefore never express a CSS value it
 * did not enumerate, and never build CSS text.
 *
 * `notes`/`name`/`description` are rendered as plain text only (React
 * escapes them) wherever the picker shows them — never as HTML, and never
 * used to build a string this module hands to `setProperty` or `innerHTML`.
 *
 * ── Module layout (why this isn't in `shell/uiPrefs.ts`) ────────────────
 * `uiPrefs.ts`'s `supportedModes()`/`readThemeId()` need to know "is a user
 * theme selected, and what modes can it render" — cheaply, with no IPC. This
 * module needs `uiPrefs.ts`'s `applyLook`/`applyPalette`/`isBrandActive`/
 * `readReadingFont`/`selectTheme`. Importing this (heavier) module back into
 * `uiPrefs.ts` would be circular, so the storage-only pieces both sides need
 * live in the leaf module `themes/userThemeStorage.ts` instead: `uiPrefs.ts`
 * imports only that, and this module imports both it and `uiPrefs.ts`,
 * one-directionally.
 */

import type {
  BrandPalette,
  UserThemeEntry,
  UserThemePalettes,
  UserThemeStructure,
} from '@conduit/config-schema';
import {
  DEFAULT_THEME_ID,
  THEMES,
  themeById,
  themeForPair,
  type LookId,
  type Mode,
  type PaletteId,
  type ThemeManifest,
} from './registry';
import {
  clearSelectedUserThemeId,
  clearUserThemeCache,
  readSelectedUserThemeId,
  readUserThemeCache,
  stripUserThemePrefix,
  writeSelectedUserThemeId,
  writeUserThemeCache,
  USER_THEME_PREFIX,
  type CachedUserTheme,
} from './userThemeStorage';
import { applyLook, applyPalette, isBrandActive, readReadingFont, selectTheme, THEME_CHANGED_EVENT } from '../shell/uiPrefs';
import { deriveHueWeak, HUE_WEAK_PROPERTY, isValidHexColor, PALETTE_PROPERTY_MAP } from '../brand/applyBrand';
import type { Translate } from '../i18n';

export { USER_THEME_PREFIX, isUserThemeId, stripUserThemePrefix } from './userThemeStorage';

/** A validated user theme resolved against the built-in registry — the
 *  picker's card data and everything `applyUserTheme`-adjacent needs. */
export interface ResolvedUserTheme {
  /** `user:<file stem>` — what the picker and `readThemeId()` use. */
  id: string;
  fileName: string;
  /** Plain text; render with `{name}`, never `dangerouslySetInnerHTML`. */
  name: string;
  description?: string;
  base: ThemeManifest;
  /** The base theme's look/palette — what gets applied to `data-look`/
   *  `data-palette` (`applyUserTheme`'s job, not this type's). */
  look: LookId;
  palette: PaletteId;
  modes: readonly Mode[];
  swatches: readonly [string, string, string, string];
  mermaid: 'tokens';
  iframe: 'tokens';
  /** The raw colour/structure overrides from the file, kept around so
   *  `selectUserTheme`/the cache writer don't need to re-parse anything. */
  paletteOverride?: UserThemePalettes;
  structure?: UserThemeStructure;
}

/** A user theme file that failed to resolve — either Rust rejected it
 *  outright (`entry.error`) or its `extends` names no known base theme. */
export interface UserThemeInvalid {
  id: string;
  fileName: string;
  /** Plain text, already localized where this module generated it itself;
   *  Rust's own `error` strings are English (D9 has not converted this
   *  command yet) and are passed through unchanged. Never HTML. */
  error: string;
}

export type UserThemeResolution = ResolvedUserTheme | UserThemeInvalid;

export function isResolvedUserTheme(r: UserThemeResolution): r is ResolvedUserTheme {
  return !('error' in r);
}

const MODE_VALUES: readonly Mode[] = ['dark', 'light'];

/**
 * Resolve one `list_user_themes` entry against the registry.
 *
 *   - Rust already rejected the file (`entry.theme` absent) → pass its
 *     `error` through as-is.
 *   - `extends` names no built-in theme → a localized error naming every
 *     valid base id, so the author can fix it without reading source.
 *   - Otherwise: modes/swatches come from the first palette mode the file
 *     overrides, if any, else from the base theme; look/palette (for
 *     `data-look`/`data-palette`) are always the base's — a user theme
 *     recolors/restructures a base, it does not pick a different structural
 *     axis pairing.
 */
export function resolveUserTheme(entry: UserThemeEntry, t: Translate): UserThemeResolution {
  const theme = entry.theme;
  if (!theme) {
    return {
      id: entry.id,
      fileName: entry.fileName,
      error: entry.error ?? t('settings.appearance.userThemes.error.unknown'),
    };
  }

  const base = themeById(theme.extends);
  if (!base) {
    return {
      id: entry.id,
      fileName: entry.fileName,
      error: t('settings.appearance.userThemes.error.unknownBase', {
        base: theme.extends,
        list: THEMES.map((m) => m.id).join(', '),
      }),
    };
  }

  let modes: readonly Mode[] = base.modes;
  let swatches: readonly [string, string, string, string] = base.swatches;
  if (theme.palette) {
    const present = MODE_VALUES.filter((m) => theme.palette?.[m] !== undefined);
    if (present.length > 0) {
      modes = present;
      const first = theme.palette[present[0]];
      if (first) swatches = [first.bg, first.card, first.ink, first.hue];
    }
  }

  return {
    id: `${USER_THEME_PREFIX}${entry.id}`,
    fileName: entry.fileName,
    name: theme.name,
    description: theme.description,
    base,
    look: base.look,
    palette: base.palette,
    modes,
    swatches,
    mermaid: 'tokens',
    iframe: 'tokens',
    paletteOverride: theme.palette,
    structure: theme.structure,
  };
}

// ── The structure table (docs/theming/decisions.md S7) ─────────────────────
// The ONLY source of structural values a user theme file can produce. Every
// enum value maps to a fixed set of token/value pairs; nothing here is ever
// built from the file's own text.

const CORNERS_TABLE: Record<string, Record<string, string>> = {
  square: {
    '--r-1': '0', '--r-2': '0', '--r-3': '0', '--r-4': '0',
    '--r-xs': '0', '--r-sm': '0', '--r': '0', '--r-lg': '0', '--r-xl': '0',
    '--r-pill': '0',
  },
  subtle: {
    '--r-xs': '2px', '--r-sm': '4px', '--r': '6px', '--r-lg': '8px', '--r-xl': '10px',
    '--r-1': '1px', '--r-2': '1px', '--r-3': '2px', '--r-4': '2px',
  },
  // The :root defaults (tokens.css) — set explicitly rather than left
  // unset, so a user theme extending a non-`rounded` base (e.g. Amber
  // Terminal, whose `terminal` look zeroes every radius) still gets rounded
  // corners rather than inheriting the base look's own values.
  rounded: {
    '--r-xs': '5px', '--r-sm': '8px', '--r': '12px', '--r-lg': '16px', '--r-xl': '22px',
  },
  soft: {
    '--r-xs': '8px', '--r-sm': '12px', '--r': '16px', '--r-lg': '20px', '--r-xl': '28px',
  },
};

/** `sans`/`serif`/`mono` → the bundled face. Shared by `uiFont` (--font-ui)
 *  and `readingFont` (--font-prose, see the reading-font gate below). */
const FACE_VAR: Record<string, string> = {
  sans: 'var(--face-sans)',
  serif: 'var(--face-serif)',
  mono: 'var(--font-mono)',
};

const LABELS_TABLE: Record<string, { props: Record<string, string>; attr?: string }> = {
  plain: { props: { '--label-case': 'none' } },
  uppercase: { props: { '--label-case': 'uppercase' } },
  // `--label-case` still goes to `none` (small-caps is a font feature, not a
  // text-transform); the attribute drives the scoped rule in tokens.css.
  'small-caps': { props: { '--label-case': 'none' }, attr: 'small-caps' },
};

const SHADOWS_TABLE: Record<string, Record<string, string>> = {
  none: {
    '--lift': '0 0 transparent',
    '--soft-lift': '0 0 transparent',
    '--shadow': '0 0 transparent',
    '--elevation-1': '0 0 transparent',
    '--elevation-2': '0 0 transparent',
    '--elevation-3': '0 0 transparent',
    '--glow': '0 0 transparent',
  },
  // 'soft' leaves whatever the base theme's look already declared.
  soft: {},
};

const MOTION_TABLE: Record<string, Record<string, string>> = {
  none: {
    '--tap': '0s',
    '--cu-tap': '0s',
    '--duration-instant': '0ms',
    '--duration-fast': '0ms',
    '--duration-normal': '0ms',
    '--duration-slow': '0ms',
    '--dur-menu': '0s',
    '--dur-scrim': '0s',
    '--dur-panel-slide': '0s',
    '--dur-tool-expand': '0s',
    '--dur-collapse': '0s',
    '--dur-provider-rule': '0s',
  },
  // 'standard' leaves whatever the base theme's look already declared.
  standard: {},
};

const ICON_STROKE_TABLE: Record<string, string> = {
  thin: '1.3',
  regular: '1.7',
  bold: '2.2',
};

// ── DOM application ──────────────────────────────────────────────────────

/** Every custom property / attribute the last `applyUserTheme`-family call
 *  set, so `clearUserTheme()` can remove exactly those — and nothing a brand
 *  set, since palette is skipped entirely while a brand is active (S6). */
const trackedProps = new Set<string>();
const trackedAttrs = new Set<string>();

function setProp(name: string, value: string): void {
  document.documentElement.style.setProperty(name, value);
  trackedProps.add(name);
}

function setAttr(name: string, value: string): void {
  document.documentElement.setAttribute(name, value);
  trackedAttrs.add(name);
}

/** Remove every property/attribute the active user theme set. Does not
 *  touch `data-look`/`data-palette` (shared with the built-in axes — the
 *  next theme, built-in or user, sets those itself) or anything a brand
 *  owns (brand and user-theme palettes are mutually exclusive at apply
 *  time, so their tracked sets never overlap). */
export function clearUserTheme(): void {
  const style = document.documentElement.style;
  for (const prop of trackedProps) style.removeProperty(prop);
  trackedProps.clear();
  for (const attr of trackedAttrs) document.documentElement.removeAttribute(attr);
  trackedAttrs.clear();
}

/** Full teardown for "switch away from user themes entirely": the DOM
 *  state `clearUserTheme()` owns, plus the persisted selection and cache.
 *  Built-in `selectTheme`/Advanced's `writeLook`/`writePalette` call this
 *  before applying their own choice. */
export function clearUserThemeSelection(): void {
  clearUserTheme();
  clearSelectedUserThemeId();
  clearUserThemeCache();
}

const PALETTE_KEYS = Object.keys(PALETTE_PROPERTY_MAP) as (keyof BrandPalette)[];

/** Same allowlist + hex re-check as `applyBrand.ts`'s `applyBrandPalette`,
 *  but tracking every property it touches instead of leaving that to a
 *  brand's own (untracked) lifecycle. */
function applyTrackedPalette(palette: BrandPalette): void {
  for (const key of PALETTE_KEYS) {
    const value = (palette as Partial<Record<keyof BrandPalette, unknown>>)[key];
    if (isValidHexColor(value)) setProp(PALETTE_PROPERTY_MAP[key], value);
  }
  // Derived output, not config-sourced — see applyBrand.ts's deriveHueWeak.
  if (isValidHexColor(palette.hue)) {
    setProp(HUE_WEAK_PROPERTY, deriveHueWeak(palette.hue));
  }
}

/**
 * The table entry for `key`, only if it is one of the table's own keys.
 * Structure normally arrives Rust-validated, but the pre-paint cache is
 * localStorage and could hold anything; a lookup must never reach
 * `Object.prototype` (`constructor`, `__proto__`) or return `undefined` into
 * `setProperty`.
 */
function pick<T>(table: Record<string, T>, key: unknown): T | undefined {
  return typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;
}

function applyStructure(structure: UserThemeStructure | undefined): void {
  if (!structure) return;
  const corners = pick(CORNERS_TABLE, structure.corners);
  if (corners) {
    for (const [prop, value] of Object.entries(corners)) setProp(prop, value);
  }
  const uiFace = pick(FACE_VAR, structure.uiFont);
  if (uiFace) setProp('--font-ui', uiFace);
  // The Reading font preference (Appearance) must still win over a theme's
  // own choice: it is applied via `html:root[data-reading-font]` in
  // chat.css, and an inline style on <html> beats every stylesheet rule
  // regardless of specificity. So --font-prose is only set inline while the
  // preference itself defers to the theme ('theme', uiPrefs.ts).
  const readingFace = pick(FACE_VAR, structure.readingFont);
  if (readingFace && readReadingFont() === 'theme') setProp('--font-prose', readingFace);
  const labels = pick(LABELS_TABLE, structure.labels);
  if (labels) {
    for (const [prop, value] of Object.entries(labels.props)) setProp(prop, value);
    if (labels.attr) setAttr('data-user-labels', labels.attr);
  }
  const shadows = pick(SHADOWS_TABLE, structure.shadows);
  if (shadows) {
    for (const [prop, value] of Object.entries(shadows)) setProp(prop, value);
  }
  const motion = pick(MOTION_TABLE, structure.motion);
  if (motion) {
    for (const [prop, value] of Object.entries(motion)) setProp(prop, value);
  }
  const stroke = pick(ICON_STROKE_TABLE, structure.iconStroke);
  if (stroke) setProp('--icon-stroke', stroke);
}

/** The minimal shape `applyUserThemeDom` needs — satisfied by both a full
 *  `ResolvedUserTheme` and the narrower object `applyCachedUserTheme`
 *  rebuilds from `CachedUserTheme`. */
interface ApplyableUserTheme {
  look: LookId;
  palette: PaletteId;
  paletteOverride?: UserThemePalettes;
  structure?: UserThemeStructure;
}

function applyUserThemeDom(theme: ApplyableUserTheme, mode: Mode): void {
  clearUserTheme();
  applyLook(theme.look);
  // S6, reused: a brand locks the palette. Skipped entirely (not just the
  // hex loop) so `data-user-palette` is never set without a palette having
  // actually been applied — see the tokens.css rule it gates.
  if (!isBrandActive()) {
    applyPalette(theme.palette);
    const palette = theme.paletteOverride?.[mode];
    if (palette) {
      applyTrackedPalette(palette);
      setAttr('data-user-palette', '1');
    }
  }
  applyStructure(theme.structure);
}

function toCachedUserTheme(resolved: ResolvedUserTheme): CachedUserTheme {
  return {
    id: stripUserThemePrefix(resolved.id),
    fileName: resolved.fileName,
    base: { look: resolved.look, palette: resolved.palette },
    palette: resolved.paletteOverride,
    structure: resolved.structure,
    modes: resolved.modes,
  };
}

/** Best-effort mode for the *initial* paint of a freshly-selected user
 *  theme, read off the `data-theme` attribute App.tsx's theme effect keeps
 *  current. Any mismatch (e.g. the new theme narrows the renderable modes)
 *  self-corrects on the very next commit: `notifyThemeChanged` below drives
 *  App's `settings.theme` effect to re-resolve, which re-fires the
 *  `effectiveTheme` effect that calls `applyCachedUserTheme` with the
 *  correctly-resolved mode. Callers that already know the resolved mode
 *  (`main.tsx`'s pre-paint boot, App's reconcile) pass it explicitly instead
 *  via `applyCachedUserTheme`. */
function fallbackEffectiveMode(): Mode {
  try {
    return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function notifyThemeChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT));
  } catch {
    /* non-browser environments */
  }
}

/**
 * Select a resolved user theme: persist its id + a pre-paint cache
 * projection, apply it to the DOM, and notify like the built-in
 * `selectTheme`. Callers (the picker) already have a `ResolvedUserTheme`
 * from rendering the card — this never re-resolves or re-validates it.
 */
export function selectUserTheme(resolved: ResolvedUserTheme): void {
  writeSelectedUserThemeId(stripUserThemePrefix(resolved.id));
  writeUserThemeCache(toCachedUserTheme(resolved));
  applyUserThemeDom(resolved, fallbackEffectiveMode());
  notifyThemeChanged();
}

/**
 * The pre-paint boot hook (`main.tsx`) and the effective-mode-change
 * re-apply (`App.tsx`, mirroring `applyBrandTheme` on `effectiveTheme`):
 * read the cache, apply it for `mode` if it still names the selected id,
 * and return it (or `null`) so callers don't need a second read to know
 * whether anything was applied. Storage-only — never touches IPC.
 */
export function applyCachedUserTheme(mode: Mode): CachedUserTheme | null {
  const selectedId = readSelectedUserThemeId();
  if (selectedId === null) return null;
  const cached = readUserThemeCache();
  if (!cached || cached.id !== selectedId) return null;
  applyUserThemeDom(
    { look: cached.base.look, palette: cached.base.palette, paletteOverride: cached.palette, structure: cached.structure },
    mode,
  );
  return cached;
}

export interface UserThemeReconcileResult {
  /** True when the previously-selected user theme could not be re-resolved
   *  this boot (its file went missing, or was edited into invalidity) and
   *  was cleared in favour of its base theme — App should toast this. */
  cleared: boolean;
  /** Set together with `cleared`: the built-in theme id the selection fell
   *  back to, and the file name that was dropped. */
  fallbackThemeId?: string;
  fileName?: string;
}

/**
 * App's boot-time reconcile: after `list_user_themes` resolves, re-resolve
 * whichever entry the persisted selection points at.
 *
 *   - no user theme selected → nothing to do.
 *   - the entry is gone or no longer resolves → clear the selection, fall
 *     back to the cached base theme's id (`selectTheme`, uiPrefs.ts) so the
 *     built-in axes end up in a named state rather than merely "whatever
 *     was last applied", and report it so App can show a toast.
 *   - still valid → rewrite the cache (the file may have changed) and
 *     re-apply for `mode`.
 */
export function reconcileUserThemes(
  entries: readonly UserThemeEntry[],
  mode: Mode,
  t: Translate,
): UserThemeReconcileResult {
  const selectedId = readSelectedUserThemeId();
  if (selectedId === null) return { cleared: false };

  const cached = readUserThemeCache();
  const entry = entries.find((e) => e.id === selectedId);
  const resolution = entry ? resolveUserTheme(entry, t) : undefined;

  if (!resolution || !isResolvedUserTheme(resolution)) {
    const fallbackThemeId =
      (cached && themeForPair(cached.base.look, cached.base.palette)?.id) ?? DEFAULT_THEME_ID;
    const fileName = entry?.fileName ?? cached?.fileName ?? selectedId;
    clearUserThemeSelection();
    selectTheme(fallbackThemeId);
    return { cleared: true, fallbackThemeId, fileName };
  }

  writeUserThemeCache(toCachedUserTheme(resolution));
  applyUserThemeDom(resolution, mode);
  return { cleared: false };
}
