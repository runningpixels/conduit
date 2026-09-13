/**
 * Theming Phase 5 (user theme files, docs/theming/decisions.md S7) — the
 * storage-only half of user themes: the id of the selected user theme and
 * the pre-paint cache of its resolved shape.
 *
 * Deliberately a leaf module with no dependency on `shell/uiPrefs.ts` or
 * `themes/userThemes.ts`, and no DOM side effects beyond `localStorage`
 * itself. `uiPrefs.ts` needs to know "is a user theme selected, and what
 * modes can it render" for `supportedModes()`/`readThemeId()` — and
 * `userThemes.ts` (which owns applying one to the DOM) already has to import
 * from `uiPrefs.ts` for `isBrandActive`/`applyLook`/`applyPalette`/
 * `readPalette`. Importing `userThemes.ts` back from `uiPrefs.ts` would be a
 * cycle; importing this tiny module instead is not, because this module
 * imports only `themes/registry.ts` (a leaf itself).
 */

import { isLookId, isPaletteId, type LookId, type PaletteId, type Mode } from './registry';
import type { UserThemePalettes, UserThemeStructure } from '@conduit/config-schema';

/** Ids in the picker and in storage are `user:<file stem>`. */
export const USER_THEME_PREFIX = 'user:';

export function isUserThemeId(id: string): boolean {
  return id.startsWith(USER_THEME_PREFIX);
}

export function stripUserThemePrefix(id: string): string {
  return isUserThemeId(id) ? id.slice(USER_THEME_PREFIX.length) : id;
}

const SELECTED_KEY = 'conduit:v10-user-theme';
const CACHE_KEY = 'conduit:v10-user-theme-cache';

/**
 * The pre-paint cache's shape — a projection of `ResolvedUserTheme`
 * (`userThemes.ts`) narrow enough to re-apply the theme before first paint:
 * the base look/palette (for `data-look`/`data-palette`), the raw palette
 * and structure overrides (re-validated at apply, exactly like a brand's
 * cache), and the modes it can render. `name`/`description`/`notes` are
 * excluded on purpose, same reasoning as `CachedBrand` dropping `notes`/
 * `logo`: nothing on the pre-paint path needs them, and `notes` in
 * particular is free-form Markdown with no size ceiling.
 */
export interface CachedUserTheme {
  id: string;
  fileName: string;
  base: { look: LookId; palette: PaletteId };
  palette?: UserThemePalettes;
  structure?: UserThemeStructure;
  modes: readonly Mode[];
}

/** Mirrors `applyBrand.ts`'s `MAX_CACHE_CHARS` — generous multiple of a
 *  realistic payload (two eighteen-key palettes + a handful of enums), far
 *  below localStorage's origin-wide quota. */
const MAX_CACHE_CHARS = 16 * 1024;

export function readSelectedUserThemeId(): string | null {
  try {
    return localStorage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

export function writeSelectedUserThemeId(id: string): void {
  try {
    localStorage.setItem(SELECTED_KEY, id);
  } catch {
    /* storage unavailable */
  }
}

export function clearSelectedUserThemeId(): void {
  try {
    localStorage.removeItem(SELECTED_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function writeUserThemeCache(cached: CachedUserTheme): void {
  try {
    const serialized = JSON.stringify(cached);
    if (serialized.length > MAX_CACHE_CHARS) return;
    localStorage.setItem(CACHE_KEY, serialized);
  } catch {
    /* storage unavailable; the next launch just misses the pre-paint replay */
  }
}

export function clearUserThemeCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* storage unavailable */
  }
}

const MODE_VALUES: readonly Mode[] = ['dark', 'light'];

function isPlausibleModes(value: unknown): value is readonly Mode[] {
  return Array.isArray(value) && value.length > 0 && value.every((m) => MODE_VALUES.includes(m));
}

/**
 * Structural validation only — same layering as `applyBrand.ts`'s
 * `readBrandCache`: this rejects a wrong *shape* (bad JSON, missing base,
 * empty modes); individual colour values are re-validated hex-by-hex at
 * apply time by whatever calls `applyUserTheme` (`userThemes.ts`), and
 * structural fields are re-checked against the enum tables there too. A
 * cache round-trips through a browser storage API a hand-edited devtools
 * session (or a hostile extension) can write to directly, so it gets the
 * same "untrusted until re-validated" treatment as a live IPC value.
 */
export function readUserThemeCache(): CachedUserTheme | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(CACHE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Partial<CachedUserTheme>;

  if (typeof record.id !== 'string' || typeof record.fileName !== 'string') return null;
  const base = record.base as Partial<CachedUserTheme['base']> | undefined;
  if (typeof base !== 'object' || base === null) return null;
  if (!isLookId(base.look) || !isPaletteId(base.palette)) return null;
  if (!isPlausibleModes(record.modes)) return null;

  return {
    id: record.id,
    fileName: record.fileName,
    base: { look: base.look, palette: base.palette },
    palette: record.palette,
    structure: record.structure,
    modes: record.modes,
  };
}
