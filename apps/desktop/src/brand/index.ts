/**
 * Product identity, in one place.
 *
 * Every user-visible occurrence of the product name reads from here rather than
 * embedding a literal. This is the seam both white-label modes need:
 *
 *   - runtime branding (Mode A) mutates this singleton at boot, before first
 *     paint, via `setBrand`;
 *   - a packaged rebrand (Mode B) rewrites `./generated.ts`'s three
 *     constants at build time — see that file's module comment for why it,
 *     not this one, is the thing Mode B overwrites.
 *
 * Same seam, two writers, at two different layers: Mode B changes what
 * `DEFAULT_BRAND` *is*; Mode A changes what `current` holds on top of it.
 *
 * A module-level singleton rather than React context, because `main.tsx` needs
 * the name before `createRoot().render()` (the palette comment there explains
 * why the boot effect is too late), and because threading a provider through
 * ~30 call sites to change one string is worse than a module import.
 *
 * Read through the accessors, never by destructuring at import time: a
 * `const { appName } = brand()` at module scope would freeze the default and
 * silently ignore every later `setBrand`.
 */

import { GENERATED_APP_NAME, GENERATED_DISPLAY_NAME, GENERATED_TAGLINE } from './generated';

export interface Brand {
  /** Short product name. Used inline in prose: "Restart Conduit". */
  appName: string;
  /** Full name for headings and about-style surfaces. Often the same. */
  displayName: string;
  /** Composer placeholder. Defaults to `Message <appName>…`. */
  tagline: string;
}

/**
 * The build's own identity, compiled in from `./generated.ts` — Conduit's
 * own name in a stock build, a reseller's in a Mode B one. `setBrand`'s
 * empty-field fallback and `resetBrand` both bottom out here, so "no runtime
 * brand active" means "this build's own baked-in identity", not a second,
 * separately hardcoded "Conduit" fallback that a Mode B build would have to
 * remember to change in two places.
 */
export const DEFAULT_BRAND: Brand = {
  appName: GENERATED_APP_NAME,
  displayName: GENERATED_DISPLAY_NAME,
  tagline: GENERATED_TAGLINE,
};

let current: Brand = DEFAULT_BRAND;

/** The active brand. Call at render time. */
export function brand(): Brand {
  return current;
}

/** Short product name — the common case, so it gets its own accessor. */
export function appName(): string {
  return current.appName;
}

/**
 * Apply a brand. Partial: any field left out falls back to the default, so a
 * config that sets only `appName` still gets a coherent tagline.
 */
export function setBrand(next: Partial<Brand>): void {
  const appNameNext = next.appName?.trim() || DEFAULT_BRAND.appName;
  current = {
    appName: appNameNext,
    displayName: next.displayName?.trim() || appNameNext,
    tagline: next.tagline?.trim() || `Message ${appNameNext}…`,
  };
}

/** Restore the built-in identity. Used by tests and by "reset branding". */
export function resetBrand(): void {
  current = DEFAULT_BRAND;
}
