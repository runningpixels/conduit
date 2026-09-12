/**
 * Locale-aware formatting (D16).
 *
 * Every one of these existed already, hand-rolled and locale-blind: dates and
 * numbers went through `toLocaleDateString()` / `toLocaleString()` with an
 * `undefined` locale, which silently follows the **OS** rather than the
 * language the user chose. A user who picks German in Settings would otherwise
 * still read English month names and US digit grouping, which is a worse bug
 * than untranslated text because it looks deliberate.
 *
 * The units and relative times were worse than locale-blind — they were
 * English constants: `KB`, `2h ago`, `just now`, `Today`. `.toFixed(1)` also
 * hardcodes `.` as the decimal separator, so German saw `2.5 MB` where it
 * wants `2,5 MB`.
 *
 * Two shapes, one implementation:
 *
 *   - pure functions taking `{ locale, t }`, so they stay testable and so the
 *     non-component code that already calls them (`conversationOrganization`)
 *     can keep doing so;
 *   - `useFormatters()`, which binds the active locale and `t` once so call
 *     sites read as `fmt.size(bytes)`.
 *
 * The `Intl` formatters are memoised per locale. Constructing one is
 * expensive enough that doing it per render in a list of conversations is a
 * real cost, and they are immutable, so caching is free.
 */

import { useMemo } from 'react';
import { useIntlSafe, useT, type Translate } from './index';

export interface FormatContext {
  locale: string;
  t: Translate;
}

/* ── memoised Intl instances ──────────────────────────────────────────────── */

const relativeCache = new Map<string, Intl.RelativeTimeFormat>();
const numberCache = new Map<string, Intl.NumberFormat>();
const collatorCache = new Map<string, Intl.Collator>();

function relative(locale: string): Intl.RelativeTimeFormat {
  let f = relativeCache.get(locale);
  if (!f) {
    /* `narrow` because it is what the hand-rolled version produced — English
     * `narrow` is exactly "2h ago" / "5m ago" / "3d ago", so this swap changes
     * nothing for English readers while giving German "vor 2 Std." and
     * Japanese "2時間前" for free. */
    f = new Intl.RelativeTimeFormat(locale, { numeric: 'always', style: 'narrow' });
    relativeCache.set(locale, f);
  }
  return f;
}

function number(locale: string, options: Intl.NumberFormatOptions = {}): Intl.NumberFormat {
  const key = `${locale}:${JSON.stringify(options)}`;
  let f = numberCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, options);
    numberCache.set(key, f);
  }
  return f;
}

export function collator(locale: string): Intl.Collator {
  let c = collatorCache.get(locale);
  if (!c) {
    /* `base` sensitivity so "Ä" sorts with "A" and case does not split a list —
     * matching what the one call site that already passed options asked for,
     * and what every other one meant to. */
    c = new Intl.Collator(locale, { sensitivity: 'base' });
    collatorCache.set(locale, c);
  }
  return c;
}

/* ── sizes ────────────────────────────────────────────────────────────────── */

/**
 * A byte count, in the reader's locale.
 *
 * English moves from `4.2 KB` to `4.2 kB` and `512 B` to `512 byte`: `kB` is
 * the SI spelling and what CLDR produces, and the change is the point — `KB`
 * is not universal and the old `.toFixed(1)` put a `.` in front of every
 * German reader.
 */
export function formatSize(bytes: number | undefined, ctx: FormatContext, fallback = '—'): string {
  if (bytes == null) return fallback;
  const opts: Intl.NumberFormatOptions = {
    style: 'unit',
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  };
  if (bytes < 1024) return number(ctx.locale, { ...opts, unit: 'byte' }).format(bytes);
  if (bytes < 1024 * 1024) {
    return number(ctx.locale, { ...opts, unit: 'kilobyte' }).format(bytes / 1024);
  }
  return number(ctx.locale, { ...opts, unit: 'megabyte' }).format(bytes / (1024 * 1024));
}

/* ── relative time ────────────────────────────────────────────────────────── */

/** Compact relative timestamp: `just now`, `2h ago`, then an absolute date. */
export function formatTimeAgo(iso: string | undefined, ctx: FormatContext): string {
  if (!iso) return ctx.t('common.time.never');
  const then = new Date(iso).getTime();
  const ms = Date.now() - then;
  if (Number.isNaN(ms) || ms < 0) return ctx.t('common.time.justNow');
  const mins = Math.round(ms / 60000);
  if (mins < 1) return ctx.t('common.time.justNow');
  if (mins < 60) return relative(ctx.locale).format(-mins, 'minute');
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return relative(ctx.locale).format(-hrs, 'hour');
  const days = Math.round(hrs / 24);
  if (days < 30) return relative(ctx.locale).format(-days, 'day');
  return new Date(iso).toLocaleDateString(ctx.locale);
}

/**
 * The even shorter form the sidebar uses — no "ago", just the magnitude.
 *
 * Kept separate from `formatTimeAgo` rather than folded into it because the
 * sidebar shows this against every row and has no width for "vor 2 Std.".
 *
 * The thresholds, the flooring, and the handover to an absolute date after a
 * week are all inherited from the `relativeFromIso` this replaced: "412d" is
 * not a useful thing to tell someone about a conversation from last year, and
 * rounding would report a 90-minute-old chat as "2h".
 */
export function formatTimeAgoTerse(iso: string, ctx: FormatContext): string {
  const then = Date.parse(iso);
  // An unparseable timestamp is echoed rather than guessed at, as before.
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return ctx.t('common.time.now');
  const unit = (value: number, u: 'minute' | 'hour' | 'day') =>
    number(ctx.locale, { style: 'unit', unit: u, unitDisplay: 'narrow' }).format(value);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return unit(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, 'hour');
  const days = Math.floor(hours / 24);
  if (days < 7) return unit(days, 'day');
  return new Date(then).toLocaleDateString(ctx.locale);
}

/* ── clock, counts, compact ───────────────────────────────────────────────── */

export function formatWallClock(ms: number, ctx: FormatContext): string {
  return new Date(ms).toLocaleTimeString(ctx.locale, { hour: 'numeric', minute: '2-digit' });
}

export function formatCount(value: number, ctx: FormatContext): string {
  return number(ctx.locale).format(value);
}

/** `200K`, `1M` — for a context window, where the exact digits do not matter. */
export function formatCompact(value: number, ctx: FormatContext): string {
  return number(ctx.locale, { notation: 'compact', maximumFractionDigits: 0 }).format(value);
}

/** A currency amount from a cent count. USD is what the providers bill in. */
export function formatMoney(cents: number, ctx: FormatContext): string {
  return number(ctx.locale, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cents < 100 ? 4 : 2,
  }).format(cents / 100);
}

/* ── the hook ─────────────────────────────────────────────────────────────── */

export interface Formatters {
  size(bytes?: number, fallback?: string): string;
  timeAgo(iso?: string): string;
  timeAgoTerse(iso: string): string;
  wallClock(ms: number): string;
  count(value: number): string;
  compact(value: number): string;
  money(cents: number): string;
  compare(a: string, b: string): number;
  /** The active locale, for the rare call site that needs to pass it on. */
  locale: string;
}

export function useFormatters(): Formatters {
  const intl = useIntlSafe();
  const t = useT();
  const locale = intl.locale;
  return useMemo(() => {
    const ctx: FormatContext = { locale, t };
    const c = collator(locale);
    return {
      size: (bytes, fallback) => formatSize(bytes, ctx, fallback),
      timeAgo: (iso) => formatTimeAgo(iso, ctx),
      timeAgoTerse: (iso) => formatTimeAgoTerse(iso, ctx),
      wallClock: (ms) => formatWallClock(ms, ctx),
      count: (value) => formatCount(value, ctx),
      compact: (value) => formatCompact(value, ctx),
      money: (cents) => formatMoney(cents, ctx),
      compare: (a, b) => c.compare(a, b),
      locale,
    };
  }, [locale, t]);
}
