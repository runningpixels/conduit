/**
 * Mode A ("demo brand") apply path — turns a validated `BrandConfig` into
 * live CSS custom properties. See `docs/private/white-label-plan.md` §3–4.
 *
 * ── The security model ──────────────────────────────────────────────────
 * `PALETTE_PROPERTY_MAP` below is a hardcoded allowlist from schema key to
 * CSS custom-property name. Applying a brand means walking that fixed list
 * and calling `documentElement.style.setProperty(prop, value)` for each —
 * never building a CSS string, never injecting a `<style>` tag, never
 * touching `innerHTML`. Property *names* always come from this map, never
 * from the config; property *values* are re-validated against the hex
 * grammar before they ever reach `setProperty`. That is the entire
 * containment story: there is no path by which brand data becomes CSS
 * syntax, because it is never assembled as a string in the first place.
 *
 * `style-src 'unsafe-inline'` is already on for this app (see the plan doc),
 * so CSP would not save a design that built CSS text — the allowlist is load
 * bearing on its own.
 *
 * ── Theme coupling (the subtle part) ────────────────────────────────────
 * Inline styles on `<html>` beat every stylesheet rule, including
 * `[data-theme="light"]`. So applying one palette inline would win in *both*
 * themes and light mode would break. Every entry point here therefore takes
 * the already-resolved theme (`'dark' | 'light'`, from `theme.ts`'s
 * `resolveTheme`) and applies only that theme's palette. Callers are
 * responsible for re-invoking on every theme change — `App.tsx` does this
 * for both the `AppSettings.theme` effect and `watchSystemTheme`'s OS-level
 * callback.
 *
 * ── Palette axis ─────────────────────────────────────────────────────────
 * Setting `data-palette="brand"` on `<html>` while a brand is active means
 * there is no CSS block for that value, so the `orange-charcoal` delta
 * (tokens.css) stops applying and non-brand tokens fall back to `:root` /
 * `[data-theme="light"]` — "the brand replaces the look". Clearing a brand
 * restores whatever palette was already stored in `localStorage` rather than
 * overwriting the user's preference, so it comes back unchanged once
 * branding is turned off again.
 *
 * ── Pre-paint cache ──────────────────────────────────────────────────────
 * IPC is async, so applying a brand only after the boot effect resolves
 * would flash a full frame of the stock look on every launch — the exact
 * failure `main.tsx`'s palette comment already warns about. Every
 * successfully-applied config is cached in `localStorage`; `main.tsx` replays
 * it synchronously, before `createRoot()`. The cache is a paint cache, not a
 * source of truth: it is re-validated against this same allowlist + hex
 * grammar on read, exactly like a value arriving fresh over IPC.
 *
 * ── The cache is a PROJECTION of `BrandConfig`, not the whole thing ─────
 * `writeBrandCache` stores only `schemaVersion`, `identity`, and `palette`
 * (see the `CachedBrand` type below) — never the full `BrandConfig`. Two
 * fields are deliberately dropped at write time, for different reasons:
 *
 *   - `logo` (`brand/logo.ts`) is fetched fresh over IPC on every boot
 *     instead of being folded into this cache, on purpose: a logo can be up
 *     to ~2 MiB (~2.7 MiB base64), which risks blowing `localStorage`'s
 *     small origin-wide quota. A `QuotaExceededError` on a combined write
 *     would take the *palette* write down with it too, reintroducing on
 *     every launch the exact flash this cache exists to prevent — so the
 *     logo simply arrives a frame later than the palette instead. See
 *     `brand/logo.ts`'s module comment for the full reasoning if this
 *     trade-off gets re-litigated later.
 *   - `notes` (the brand.md prose body — design rationale, and what gets
 *     fed back to an LLM revising a theme; see the plan doc §2) has no role
 *     in painting and, unlike the palette, has no size ceiling: it is
 *     free-form Markdown and routinely runs to several KB, sometimes more
 *     for a model-generated brand. Including it would make the *size guard
 *     below* the thing silently breaking the pre-paint cache for verbose
 *     brand files — exactly the failure mode the guard exists to prevent
 *     for a different reason. Dropping it here means the realistic payload
 *     stays ~1-2 KB and `MAX_CACHE_CHARS` should never fire in practice.
 *
 * `readBrandCache` and `applyCachedBrand` return `CachedBrand`, not
 * `BrandConfig` — an honest narrower type, rather than a `BrandConfig` whose
 * `notes`/`logo` are always absent.
 */

import type { BrandConfig, BrandPalette } from '@conduit/config-schema';
import { resetBrand, setBrand } from './index';
import { applyPalette, readPalette } from '../shell/uiPrefs';

/**
 * The pre-paint cache's own shape — deliberately narrower than
 * `BrandConfig`. Only what `applyBrandTheme`/`applyBrandIdentity` need to
 * paint before first render: `schemaVersion` (for the cache's own
 * structural validation), `identity`, and `palette`. `notes` and `logo` are
 * excluded on purpose — see the module comment above — so this type says
 * that honestly instead of reusing `BrandConfig` and leaving those two
 * fields permanently absent in practice.
 */
export interface CachedBrand {
  schemaVersion: BrandConfig['schemaVersion'];
  identity: BrandConfig['identity'];
  palette?: BrandConfig['palette'];
}

/**
 * Schema key → CSS custom-property name. Hardcoded, not derived from the
 * config in any way — that is what keeps a property *name* out of brand
 * data's reach. Deliberately excludes `--hue-a08/a12/a20/a40`: tokens.css
 * :233-236 genuinely derives all four from `var(--hue)` with no
 * `[data-provider]` override, so setting the accent carries those tints for
 * free.
 *
 * `--hue-weak` is NOT in that same boat, despite looking like it belongs
 * with the tints above — see `deriveHueWeak` below for why it needs an
 * explicit derivation step in `applyBrandTheme` instead of "comes free with
 * --hue".
 */
export const PALETTE_PROPERTY_MAP: Readonly<Record<keyof BrandPalette, string>> = {
  bg: '--bg',
  bgSide: '--bg-side',
  card: '--card',
  cardHi: '--card-hi',
  line: '--line',
  lineSoft: '--line-soft',
  lineHi: '--line-hi',
  ink: '--ink',
  ink2: '--ink-2',
  ink3: '--ink-3',
  hue: '--hue',
  hueText: '--hue-text',
  hueSolid: '--hue-solid',
  onHue: '--on-hue',
  ok: '--ok',
  warn: '--warn',
  err: '--err',
  link: '--link',
};

const PALETTE_KEYS = Object.keys(PALETTE_PROPERTY_MAP) as (keyof BrandPalette)[];

/** `#rgb`, `#rrggbb`, or `#rrggbbaa` — v1's entire value grammar. No `url()`,
 * no `var()`, no functional notation, so a brand file cannot express a
 * network fetch even in principle. Rust validates this too; re-checking here
 * is defence in depth for the one input that is *not* freshly Rust-validated
 * on every use — the localStorage cache. */
const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function isValidHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

/**
 * `--hue-weak` is not a `BrandPalette` field — same reasoning as the
 * `--hue-a08/12/20/40` tints, because it has exactly one correct value once
 * an accent is chosen: a wash of it. Unlike those four tints, though,
 * tokens.css does NOT derive `--hue-weak` from `var(--hue)` anywhere that
 * actually applies once a brand is active:
 *
 *   - `:root`'s own value is the literal `transparent`, not a color-mix();
 *   - the `[data-provider="..."]` blocks (tokens.css:381-399) set it from
 *     their own hardcoded provider hex, not `var(--hue)`. This selector
 *     matches ANY element carrying the attribute, not only `<html>` —
 *     `<html>` always carries one (App.tsx:834's provider-tint effect), but
 *     so do several descendants that set their own, independently:
 *     `AssistantMessage.tsx:162`, `ChatView.tsx:1242`,
 *     `ComposerModelPicker.tsx:243`, `Sidebar.tsx:293`. A custom property
 *     re-declared on a descendant wins over whatever an ancestor (or an
 *     inline style on `<html>`, from this very function) says for that same
 *     property on that element — that is ordinary CSS inheritance, not
 *     cascade specificity, so `setProperty` on `<html>` cannot reach those
 *     subtrees on its own no matter what property name or value it uses.
 *     tokens.css:480-537 is what actually closes that gap: a
 *     `data-palette="brand"`-scoped rule (this function sets that attribute
 *     below) forces `--hue`/`--hue-text`/`--hue-solid`/`--hue-weak` to
 *     `inherit` on every `[data-provider]` element, so they chain back up to
 *     whatever `<html>` declares instead of using their own block's literal
 *     value. Without that CSS-side rule, this function's `setProperty` calls
 *     would only ever reach `<html>` itself;
 *   - the one `var()`-based derivation (tokens.css:476) reads
 *     `var(--oc-hue)` inside `html[data-palette="orange-charcoal"]`, a block
 *     `applyBrandTheme`'s own `data-palette="brand"` deliberately disables.
 *
 * Left alone (i.e. without the `inherit` rule above), `--hue-weak` would
 * keep showing whichever provider's wash (or `transparent`, if nothing sets
 * `data-provider`) instead of tracking the brand accent — visible on
 * `::selection`, `.icon-btn.on`, `.pill.local`, `.av-role.bot`, and on every
 * `[data-provider]` descendant (message bubbles, model-picker rows, sidebar
 * chips). So it is computed here and applied directly with `setProperty` on
 * `<html>`, at the same 14% the majority of the provider blocks (and the
 * orange-charcoal block) use, and the CSS-side `inherit` rule carries it the
 * rest of the way down the tree.
 *
 * This deliberately bypasses `isValidHexColor`: a `color-mix()` expression
 * is not hex and never will be, so accepting one here would look like the
 * input grammar had quietly grown a functional-notation escape hatch. It
 * has not — nothing in this module accepts `color-mix()`, `var()`, or any
 * other functional CSS *from the config or the cache*; `hue` is still
 * hex-only, still validated before this function is ever called. This only
 * ever builds the wash from that already-safe hex value, template-style,
 * and only that hex value ever flows into the string. Treat this exception
 * as narrow and specific to a derived *output*, not as precedent for
 * relaxing what config-sourced *input* may contain.
 *
 * (`--hue-weak-solid` is deliberately left untouched: it has no consumers
 * anywhere outside its own definitions in tokens.css, so there is nothing
 * for a brand to override.)
 */
const HUE_WEAK_PROPERTY = '--hue-weak';

function deriveHueWeak(hue: string): string {
  return `color-mix(in srgb, ${hue} 14%, transparent)`;
}

const CACHE_KEY = 'conduit:v1-brand';

/**
 * Set every allowlisted custom property from one palette (one theme's
 * worth). Values that fail the hex grammar are dropped silently rather than
 * applied or thrown — a single bad value in an otherwise-good palette should
 * not break the whole apply, and this is the paint path, not a place to
 * surface errors. Only ever touches the 18 properties in
 * `PALETTE_PROPERTY_MAP`; any other key present on `palette` (from a corrupt
 * cache, say) is ignored because the loop is driven by the allowlist, not by
 * the object's own keys.
 */
export function applyBrandPalette(palette: BrandPalette): void {
  const root = document.documentElement.style;
  for (const key of PALETTE_KEYS) {
    const value = (palette as Partial<Record<keyof BrandPalette, unknown>>)[key];
    if (isValidHexColor(value)) {
      root.setProperty(PALETTE_PROPERTY_MAP[key], value);
    }
  }
}

/**
 * Apply just the theme-dependent part of a brand: the palette for the given
 * resolved theme, plus the `data-palette="brand"` axis. Does not touch
 * identity or the cache — this is what re-runs on every theme change, so it
 * must be cheap and idempotent. A config with no `palette` (an identity-only
 * rebrand) leaves the palette axis alone entirely.
 *
 * Takes `Pick<BrandConfig, 'palette'>` rather than the full `BrandConfig`
 * so it accepts a `CachedBrand` (which has no `notes`/`logo`) as readily as
 * a freshly-loaded `BrandConfig` — this is the function `applyCachedBrand`
 * re-runs against the projected cache.
 */
export function applyBrandTheme(config: Pick<BrandConfig, 'palette'>, theme: 'dark' | 'light'): void {
  if (!config.palette) return;
  const palette = config.palette[theme];
  applyBrandPalette(palette);
  document.documentElement.setAttribute('data-palette', 'brand');

  // Derived output, not a config-sourced value — see deriveHueWeak above.
  // Re-checked independently of applyBrandPalette's internal hex check
  // because that check does not report back which keys it dropped; if hue
  // itself failed validation, --hue-weak must not be left pointing at a
  // stale hue from a previous theme.
  const root = document.documentElement.style;
  if (isValidHexColor(palette.hue)) {
    root.setProperty(HUE_WEAK_PROPERTY, deriveHueWeak(palette.hue));
  } else {
    root.removeProperty(HUE_WEAK_PROPERTY);
  }
}

/**
 * Full apply: identity, the theme-appropriate palette, and the pre-paint
 * cache. This is the entry point for a freshly-loaded (IPC or replayed)
 * config; theme-change re-application should call `applyBrandTheme` instead
 * so it doesn't re-write the cache or the identity singleton on every theme
 * flip.
 */
export function applyBrand(config: BrandConfig, theme: 'dark' | 'light'): void {
  applyBrandTheme(config, theme);
  applyBrandIdentity(config);
  writeBrandCache(config);
}

/** Route a config's naming through the Phase 0 identity singleton, so the
 * ~30 call sites already reading `appName()` / `brand()` pick it up.
 * `Pick<BrandConfig, 'identity'>` for the same reason as `applyBrandTheme`
 * above — accepts both a full `BrandConfig` and a `CachedBrand`. */
function applyBrandIdentity(config: Pick<BrandConfig, 'identity'>): void {
  setBrand({
    appName: config.identity.appName,
    displayName: config.identity.displayName,
    tagline: config.identity.tagline,
  });
}

/**
 * Revert everything `applyBrand` can have set: remove every allowlisted
 * custom property plus the derived `--hue-weak` (back to whatever the
 * stylesheet says), restore the `data-palette` attribute to the user's
 * *stored* preference rather than a hardcoded default (branding must not
 * clobber that preference — it only suspends it while active), reset the
 * identity singleton, and drop the pre-paint cache so the next launch
 * doesn't replay a cleared brand.
 */
export function clearBrand(): void {
  const root = document.documentElement.style;
  for (const key of PALETTE_KEYS) {
    root.removeProperty(PALETTE_PROPERTY_MAP[key]);
  }
  root.removeProperty(HUE_WEAK_PROPERTY);
  applyPalette(readPalette());
  resetBrand();
  clearBrandCache();
}

/**
 * Upper bound, in UTF-16 code units of the serialized JSON, on what may land
 * in the pre-paint cache. A projected `CachedBrand` (`schemaVersion` +
 * identity + an 18-key palette for each of two themes, with `notes` and
 * `logo` already dropped by `writeBrandCache` below) realistically runs
 * ~1-2 KB, so this is a generous multiple — comfortably clear of any
 * legitimate value, but far below `localStorage`'s origin-wide quota. With
 * `notes` excluded from the projection, this guard should never fire in
 * practice; it exists purely as a belt-and-braces backstop for a future
 * field or a corrupt value, which should trip this check rather than risk a
 * `QuotaExceededError` on write (the try/catch below already handles that,
 * but only after the fact).
 */
const MAX_CACHE_CHARS = 16 * 1024;

/**
 * Persist the pre-paint-relevant projection of a validated config —
 * `schemaVersion`, `identity`, `palette` — for the pre-paint boot path.
 * `notes` (brand.md's prose body, which can be many KB — see the module
 * comment) and `logo` (never cached at all) are dropped here, at write
 * time, not merely left unread by consumers downstream: a wordy or
 * model-generated brand file must not be able to blow the size guard below
 * and silently disable the pre-paint cache for that user on every launch.
 *
 * Best-effort: a storage failure (quota, disabled storage) should not break
 * the apply that triggered it, and an oversized *projected* value is
 * dropped before the write is even attempted rather than risking a
 * `QuotaExceededError` that could sink an otherwise-healthy cache entry.
 */
export function writeBrandCache(config: BrandConfig): void {
  try {
    const projected: CachedBrand = {
      schemaVersion: config.schemaVersion,
      identity: config.identity,
      palette: config.palette,
    };
    const serialized = JSON.stringify(projected);
    if (serialized.length > MAX_CACHE_CHARS) return;
    localStorage.setItem(CACHE_KEY, serialized);
  } catch {
    /* storage unavailable; the next launch just misses the pre-paint replay */
  }
}

export function clearBrandCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* storage unavailable */
  }
}

/**
 * Read the cached projection back, treating it as untrusted: it round-trips
 * through JSON in a browser storage API a hostile extension or a hand-edited
 * dev-tools session can write to directly, so it gets the same scrutiny as
 * anything else crossing a trust boundary. Structural checks only reject the
 * whole cache (bad JSON, wrong shape, non-numeric `schemaVersion`, a palette
 * missing a required key); individual out-of-grammar colour *values* are
 * instead dropped one at a time by `applyBrandPalette`'s hex check when the
 * result is applied — the two checks are deliberately layered rather than
 * duplicated, matching what happens to a live IPC-sourced config, which is
 * also only shape-checked here and hex-checked at apply time. Returns `null`
 * on any failure; callers must treat that exactly like "no brand cached".
 *
 * Returns `CachedBrand`, not `BrandConfig`: the cache never held `notes` or
 * `logo` to begin with (`writeBrandCache` drops them before the write), so
 * a caller has no business expecting them here.
 */
export function readBrandCache(): CachedBrand | null {
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

  if (!isPlausibleCachedBrand(parsed)) return null;
  return parsed;
}

function isPlausibleBrandPalette(value: unknown): value is BrandPalette {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<Record<keyof BrandPalette, unknown>>;
  return PALETTE_KEYS.every((key) => typeof record[key] === 'string');
}

/**
 * Structural check for the cache's own projected shape. Deliberately does
 * NOT require the absence of `notes`/`logo` — an extra, ignored key on a
 * hand-edited cache entry is harmless, since nothing downstream reads
 * anything but `schemaVersion`/`identity`/`palette` off the result; only
 * rejecting on a *missing* required key matters here.
 */
function isPlausibleCachedBrand(value: unknown): value is CachedBrand {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<CachedBrand>;

  if (typeof record.schemaVersion !== 'number') return false;

  const identity = record.identity as Partial<BrandConfig['identity']> | undefined;
  if (typeof identity !== 'object' || identity === null) return false;
  if (typeof identity.appName !== 'string' || typeof identity.displayName !== 'string') return false;

  // `palette` is optional (an identity-only rebrand) but if present must be
  // fully shaped for both themes — a half-shaped palette is exactly the
  // "produces unreadable text" hazard the Rust validator's dark/light
  // symmetry check exists to prevent, and this cache bypasses that validator.
  if (record.palette !== undefined) {
    const themes = record.palette as Partial<BrandConfig['palette']>;
    if (typeof themes !== 'object' || themes === null) return false;
    if (!isPlausibleBrandPalette(themes.dark) || !isPlausibleBrandPalette(themes.light)) return false;
  }

  return true;
}

/**
 * The pre-paint boot hook: replay a cached brand (identity + the
 * theme-appropriate palette) before `createRoot()`, mirroring how
 * `main.tsx` replays the palette preference. Does not re-write the cache —
 * it is already the source this read from. Returns the projection that was
 * applied (or `null`) purely so `main.tsx` doesn't need a second import to
 * inspect the outcome.
 */
export function applyCachedBrand(theme: 'dark' | 'light'): CachedBrand | null {
  const config = readBrandCache();
  if (!config) return null;
  applyBrandTheme(config, theme);
  applyBrandIdentity(config);
  return config;
}
