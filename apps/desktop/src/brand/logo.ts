/**
 * Phase 2 — the brand logo. See `docs/private/white-label-plan.md` §4,
 * items 10-13.
 *
 * ── The URI is re-validated, not trusted, on arrival ────────────────────
 * `get_brand_logo` (`ipc/client.ts`) returns a COMPLETE `data:image/...;
 * base64,...` string assembled in Rust from magic bytes, specifically so a
 * hostile MIME can never be smuggled in. But the value still crosses a
 * process boundary to get here, so — exactly like `applyBrand.ts`'s hex-only
 * grammar for palette values — it gets re-checked against a strict pattern
 * before it is ever allowed into an `<img src>`. Anything that fails is
 * dropped in favour of the built-in `BrandMark` glyph, never partially used.
 *
 * ── Why the logo is never cached in localStorage ────────────────────────
 * `applyBrand.ts` caches the validated palette/identity for the pre-paint
 * boot path (`main.tsx` replays it before `createRoot()`). The logo
 * deliberately does NOT get the same treatment:
 *
 *   - a logo can be up to ~2 MiB, ~2.7 MiB once base64-encoded — the
 *     palette cache is a few KB;
 *   - localStorage has a small origin-wide quota, and a write that size can
 *     throw `QuotaExceededError`;
 *   - `writeBrandCache` catches write failures to keep the *palette* apply
 *     from failing — but if the logo shared that same call/key, a failed
 *     logo write would take the whole cache write down with it (or, if
 *     written separately but the localStorage-wide quota is already tight,
 *     could still crowd out the palette write), reintroducing exactly the
 *     launch flash the cache exists to prevent.
 *
 * So the logo is fetched fresh over IPC on every boot, in parallel with
 * `getBrandConfig`, and simply arrives a frame later than the palette. That
 * is an accepted trade-off, not an oversight — if "why isn't the logo
 * cached like everything else?" comes up again, this is the answer.
 *
 * ── Why this never throws ───────────────────────────────────────────────
 * `get_brand_logo` can be unregistered (a fresh Rust build that hasn't
 * landed the command yet) or fail for any other IPC reason. Either case is
 * indistinguishable from "no logo configured" as far as the renderer is
 * concerned: fall back to the built-in mark, don't break the boot sequence
 * that fetches this alongside `getBrandConfig`, `getSettings`, etc.
 */

import { getBrandLogo } from '../ipc/client';

/**
 * `data:image/<png|jpeg|webp|svg+xml>;base64,<payload>` — the exact shape
 * Rust assembles, and the only shape this app will ever put in an `<img
 * src>` for a brand logo. No other scheme (`javascript:`, `http:`, plain
 * `data:text/html`, ...) and no other declared MIME are accepted, regardless
 * of what produced the string.
 */
const LOGO_DATA_URI = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+=*$/;

export function isValidLogoDataUri(value: unknown): value is string {
  return typeof value === 'string' && LOGO_DATA_URI.test(value);
}

/**
 * Fetch and validate the active brand logo for render. Never rejects: an IPC
 * failure (including "command not found") or a malformed/hostile URI both
 * resolve to `null`, which callers treat exactly like "no logo configured"
 * and render the built-in `BrandMark` instead.
 */
export async function fetchBrandLogo(): Promise<string | null> {
  let uri: string | null;
  try {
    uri = await getBrandLogo();
  } catch {
    return null;
  }
  if (uri === null) return null;
  return isValidLogoDataUri(uri) ? uri : null;
}
