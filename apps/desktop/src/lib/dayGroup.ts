/**
 * Day bucketing for anything that groups by when it happened.
 *
 * Lifted out of `shell/Sidebar.tsx` when the thread gained day separators
 * (V9 §4). Both surfaces have to agree: a conversation filed under "Yesterday"
 * in the sidebar and a separator reading "Aug 7" above the same turns would be
 * two vocabularies for one fact. Keeping one function is cheaper than keeping
 * two in step, and this is a pure date helper with no shell in it — the same
 * reason `contextWindows.ts` and `costTable.ts` live here.
 */

/** Group label: Today / Yesterday / month names (this year) / year. */
export function conversationGroup(iso: string, now: Date = new Date()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'Earlier';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (then >= startOfToday.getTime()) return 'Today';
  if (then >= startOfYesterday.getTime()) return 'Yesterday';
  const d = new Date(then);
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'long' });
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
export function dayRuleLabel(iso: string, now: Date = new Date()): string {
  const group = conversationGroup(iso, now);
  if (group === 'Today' || group === 'Yesterday') return group;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return group;
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}
