/**
 * Day bucketing for anything that groups by when it happened.
 *
 * Lifted out of `shell/Sidebar.tsx` when the thread gained day separators
 * (V9 §4). Both surfaces have to agree: a conversation filed under "Yesterday"
 * in the sidebar and a separator reading "Aug 7" above the same turns would be
 * two vocabularies for one fact. Keeping one function is cheaper than keeping
 * two in step, and this is a pure date helper with no shell in it — the same
 * reason `contextWindows.ts` and `costTable.ts` live here.
 *
 * The labels and the month names are locale-bound (D16), so both public
 * functions take a `FormatContext`. They used to return the English words
 * `Today`/`Yesterday`/`Earlier` and call `toLocaleDateString(undefined, …)`,
 * which follows the OS rather than the language the user chose — so a German
 * user got German month names only if their machine was German, and the three
 * relative labels never translated at all.
 */
import type { FormatContext } from '../i18n/formatters';

/** Group label: Today / Yesterday / month names (this year) / year. */
export function conversationGroup(iso: string, ctx: FormatContext, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return ctx.t('common.time.earlier');
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (then >= startOfToday.getTime()) return ctx.t('common.time.today');
  if (then >= startOfYesterday.getTime()) return ctx.t('common.time.yesterday');
  const d = new Date(then);
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(ctx.locale, { month: 'long' });
  }
  return String(d.getFullYear());
}

/**
 * The calendar day two timestamps fall on, for deciding whether a boundary sits
 * between them. Compared as a local-date key rather than by `conversationGroup`,
 * because that function collapses a whole month into one label — every turn in
 * August would otherwise look like the same day and the separator would never
 * appear inside it.
 */
export function sameCalendarDay(a: string, b: string): boolean {
  const x = new Date(a);
  const y = new Date(b);
  if (Number.isNaN(x.getTime()) || Number.isNaN(y.getTime())) return true;
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

/**
 * The separator's text: the relative label while it is still meaningful, an
 * absolute date once "August" would be ambiguous across days.
 */
export function dayRuleLabel(iso: string, ctx: FormatContext, now: Date = new Date()): string {
  const group = conversationGroup(iso, ctx, now);
  // Compared against the translated labels, not against the English words: the
  // point of the group is that it is already in the reader's language.
  if (group === ctx.t('common.time.today') || group === ctx.t('common.time.yesterday')) {
    return group;
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return group;
  return d.toLocaleDateString(ctx.locale, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
