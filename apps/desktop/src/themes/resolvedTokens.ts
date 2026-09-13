/**
 * Theming Phase 3 — resolved-token bridge for renderers that cannot read CSS
 * custom properties directly (Mermaid draws into its own SVG document;
 * the HTML artifact iframe is a sandboxed `srcdoc` with no access to the
 * app's stylesheet). Both need the *live* palette as plain strings so they
 * can build their own config/stylesheet from it.
 *
 * ── Security discipline (same as brand/applyBrand.ts) ───────────────────
 * Every value here is interpolated into a Mermaid `themeVariables` object or
 * an iframe `srcdoc` `<style>` block, so an unvalidated value is a CSS/HTML
 * injection vector via `getComputedStyle` — e.g. a value someone wrote
 * straight into an inline style from devtools, or a future look/palette
 * author who slips in a `url(...)`. Colours are checked against a strict hex
 * grammar (`#rgb` / `#rrggbb` only — no functional notation, no alpha) and
 * font stacks against a conservative allow-list grammar; anything that fails
 * is omitted (`undefined`) rather than passed through. This module does not
 * reuse `brand/applyBrand.ts`'s `isValidHexColor`: that grammar also accepts
 * `#rrggbbaa`, one degree looser than what this module wants to allow, so a
 * separate, stricter check is written here rather than widening that one.
 */

import { useEffect, useState } from 'react';
import { themeById, type RendererTheming } from './registry';
import { isBrandActive, readLook, readThemeId, THEME_CHANGED_EVENT } from '../shell/uiPrefs';

export interface ResolvedTokens {
  bg?: string;
  bgSide?: string;
  card?: string;
  cardHi?: string;
  line?: string;
  lineHi?: string;
  ink?: string;
  ink2?: string;
  ink3?: string;
  hue?: string;
  link?: string;
  code?: string;
  ok?: string;
  warn?: string;
  err?: string;
  fontUi?: string;
  fontMono?: string;
}

/** `#rgb` or `#rrggbb` only — no alpha, no functional notation. Stricter than
 * `applyBrand.ts`'s `isValidHexColor` (which also allows `#rrggbbaa`) on
 * purpose: nothing downstream of this module needs alpha. */
const HEX_STRICT = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function isStrictHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_STRICT.test(value.trim());
}

/** One font-stack item: a quoted family name (letters, digits, spaces,
 * hyphens only — no `"` inside, so a value cannot close the quote early) or a
 * bare identifier (letters/hyphens — covers generic keywords like
 * `sans-serif`/`ui-monospace` and unquoted family names like `Menlo`). Either
 * form excludes every character CSS/HTML injection needs: no `(`, `)`, `;`,
 * `{`, `}`, `<`, `>`, `/`, `:`, or whitespace-only runs. */
const QUOTED_FONT_ITEM = /^"[A-Za-z0-9 -]+"$/;
const BARE_FONT_ITEM = /^[A-Za-z-]+$/;
const FONT_STACK_MAX_LENGTH = 300;

export function isValidFontStack(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > FONT_STACK_MAX_LENGTH) return false;
  const items = trimmed.split(',').map((item) => item.trim());
  return items.every((item) => QUOTED_FONT_ITEM.test(item) || BARE_FONT_ITEM.test(item));
}

function readColor(style: CSSStyleDeclaration, prop: string): string | undefined {
  const raw = style.getPropertyValue(prop).trim();
  return isStrictHexColor(raw) ? raw : undefined;
}

function readFont(style: CSSStyleDeclaration, prop: string): string | undefined {
  const raw = style.getPropertyValue(prop).trim();
  return isValidFontStack(raw) ? raw : undefined;
}

/**
 * Read the live document's resolved tokens. Each field is `undefined` when
 * the underlying custom property is unset or fails its grammar check — never
 * a passthrough of unvalidated text. Callers must treat a missing field as
 * "this renderer cannot use tokens theming" for whatever it needed that field
 * for, per `docs/theming/README.md`'s native-fallback rule.
 */
export function readResolvedTokens(): ResolvedTokens {
  if (typeof document === 'undefined' || typeof window === 'undefined') return {};
  const style = window.getComputedStyle(document.documentElement);
  return {
    bg: readColor(style, '--bg'),
    bgSide: readColor(style, '--bg-side'),
    card: readColor(style, '--card'),
    cardHi: readColor(style, '--card-hi'),
    line: readColor(style, '--line'),
    lineHi: readColor(style, '--line-hi'),
    ink: readColor(style, '--ink'),
    ink2: readColor(style, '--ink-2'),
    ink3: readColor(style, '--ink-3'),
    hue: readColor(style, '--hue'),
    link: readColor(style, '--link'),
    code: readColor(style, '--code'),
    ok: readColor(style, '--ok'),
    warn: readColor(style, '--warn'),
    err: readColor(style, '--err'),
    fontUi: readFont(style, '--font-ui'),
    fontMono: readFont(style, '--font-mono'),
  };
}

/**
 * How the given renderer should get its colours right now:
 *   - a brand always wins ('native'): white-labelling replaces the palette
 *     wholesale and Mermaid/iframe should keep rendering with whatever their
 *     own native theme resolves to, not a half-applied brand.
 *   - a named theme (`themes/registry.ts`) says so explicitly per-renderer.
 *   - an Advanced "custom" look × palette pairing (no manifest names it) has
 *     no explicit answer, so it defers to the look: `soft` behaves like
 *     today (native), any other look (currently only `terminal`) opts into
 *     tokens theming, since a structural look this different from `soft` is
 *     exactly the case tokens theming exists for.
 */
export function activeRendererTheming(kind: 'mermaid' | 'iframe'): RendererTheming {
  if (isBrandActive()) return 'native';
  const manifest = themeById(readThemeId());
  if (manifest) return manifest[kind];
  return readLook() === 'soft' ? 'native' : 'tokens';
}

/**
 * A counter that increments whenever the active theme could have changed:
 * `THEME_CHANGED_EVENT` (palette/look writes, `selectTheme`) and `data-theme`
 * attribute mutations on `<html>` (dark/light flips, including a brand's own
 * theme re-application). Renderers that read resolved tokens once per render
 * — Mermaid's blob, the iframe's `srcdoc` — cannot otherwise know their
 * cached output is stale, since neither is driven by React props for colour.
 */
export function useThemeRevision(): number {
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const bump = () => setRevision((r) => r + 1);
    window.addEventListener(THEME_CHANGED_EVENT, bump);
    const el = document.documentElement;
    const observer = new MutationObserver(bump);
    observer.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      window.removeEventListener(THEME_CHANGED_EVENT, bump);
      observer.disconnect();
    };
  }, []);

  return revision;
}
