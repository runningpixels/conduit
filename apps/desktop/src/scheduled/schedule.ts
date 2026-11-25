/// Helpers for a ScheduleSpec that the Scheduled page, the task dialog, the workflow editor's
/// schedule section and the Agents page's routine rows all share: the default for each kind, and
/// the words that describe one ("Weekdays at 08:00", "Every Monday at 09:00").

import type { Translate } from '../i18n';
import type { ScheduleDay, ScheduleSpec, WorkflowTrigger } from '../ipc/contracts';

/// What a schedule starts as when it is first switched on.
export const DEFAULT_TIME = '08:00';
/// Choices for "every N hours".
export const INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;
/// The days of a week, Monday first (the order the chips show and the backend stores).
export const WEEK_DAYS: readonly ScheduleDay[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/// A schedule that is a time: everything but a trigger, which is polled.
export type TimedSpec = Exclude<ScheduleSpec, { kind: 'trigger' }>;

/// What a task can start from: a kind of time, or a new file / a new post.
export type WhenKind = TimedSpec['kind'] | 'folder' | 'feed';

/// Every kind the When dropdown offers, in order.
export const TIMED_KINDS: readonly TimedSpec['kind'][] = ['daily', 'weekdays', 'weekly', 'monthly', 'interval', 'once'];

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/// `YYYY-MM-DDTHH:MM` of a local date, the form `once` and `<input type="datetime-local">` use.
export function localDateTime(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/// Tomorrow at `time` (`HH:MM`), local: where a new "once" schedule starts.
export function defaultOnceAt(time: string = DEFAULT_TIME, now: Date = new Date()): string {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return `${localDateTime(tomorrow).slice(0, 10)}T${/^\d{2}:\d{2}$/.test(time) ? time : DEFAULT_TIME}`;
}

/// The `HH:MM` a spec runs at, when it has one.
export function timeOf(spec: ScheduleSpec | null | undefined): string | null {
  if (!spec) return null;
  if (spec.kind === 'once') return spec.at.slice(11, 16) || null;
  return 'time' in spec ? spec.time : null;
}

/// A spec of `kind`, carrying over the time of `prev` so switching the kind keeps what was typed.
export function specForKind(kind: TimedSpec['kind'], prev?: ScheduleSpec | null, now: Date = new Date()): TimedSpec {
  const time = timeOf(prev) ?? DEFAULT_TIME;
  switch (kind) {
    case 'daily':
    case 'weekdays':
      return { kind, time };
    case 'weekly':
      return { kind, days: prev?.kind === 'weekly' ? prev.days : ['mon'], time };
    case 'monthly':
      return { kind, day: prev?.kind === 'monthly' ? prev.day : 1, time };
    case 'interval':
      return { kind, hours: prev?.kind === 'interval' ? prev.hours : 4 };
    case 'once':
      return { kind, at: prev?.kind === 'once' ? prev.at : defaultOnceAt(time, now) };
  }
}

/// `spec` with the time set to `time`.
export function withTime(spec: TimedSpec, time: string): TimedSpec {
  if (spec.kind === 'once') return { kind: 'once', at: `${spec.at.slice(0, 10)}T${time}` };
  if (spec.kind === 'interval') return spec;
  return { ...spec, time };
}

/// The day's name in `locale` ("Monday"; `short` gives "Mon").
export function weekdayName(day: ScheduleDay, locale: string, style: 'long' | 'short' = 'long'): string {
  // 2024-01-01 was a Monday, in every time zone's UTC date.
  const index = WEEK_DAYS.indexOf(day);
  return new Intl.DateTimeFormat(locale, { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + index)));
}

/// "Tue, Sep 29, 8:00 AM" for a local `YYYY-MM-DDTHH:MM`.
export function formatOnceAt(at: string, locale: string): string {
  const [date = '', time = '00:00'] = at.split('T');
  const [y = 1970, m = 1, d = 1] = date.split('-').map(Number);
  const [hh = 0, mm = 0] = time.split(':').map(Number);
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(y, m - 1, d, hh, mm));
}

function sameDays(days: readonly ScheduleDay[], expected: readonly ScheduleDay[]): boolean {
  return days.length === expected.length && expected.every((d) => days.includes(d));
}

/// When something runs, in words: "Weekdays at 08:00", "Every Monday and Friday at 09:00", "Monthly on day 1
/// at 08:00", "Every 4 hours", "Once, Tue, Dec 1, 2026, 9:00 AM", "When a new file arrives".
export function describeSchedule(
  spec: ScheduleSpec | null | undefined,
  trigger: WorkflowTrigger | null | undefined,
  t: Translate,
  locale: string,
): string {
  if (spec?.kind === 'trigger' || trigger) {
    return trigger?.kind === 'feed' ? t('shell.agents.routines.onFeed') : t('shell.agents.routines.onFolder');
  }
  switch (spec?.kind) {
    case 'daily':
      return t('shell.agents.routines.dailyAt', { time: spec.time });
    case 'weekdays':
      return t('shell.agents.routines.weekdaysAt', { time: spec.time });
    case 'weekly': {
      if (sameDays(spec.days, WEEK_DAYS)) return t('shell.agents.routines.dailyAt', { time: spec.time });
      if (sameDays(spec.days, WEEK_DAYS.slice(0, 5))) return t('shell.agents.routines.weekdaysAt', { time: spec.time });
      const ordered = WEEK_DAYS.filter((d) => spec.days.includes(d)).map((d) => weekdayName(d, locale));
      const days = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(ordered);
      return t('shell.scheduled.when.weeklyAt', { days, time: spec.time });
    }
    case 'monthly':
      return t('shell.scheduled.when.monthlyAt', { day: spec.day, time: spec.time });
    case 'interval':
      return t('shell.agents.routines.everyHours', { count: spec.hours });
    case 'once':
      return t('shell.scheduled.when.onceAt', { when: formatOnceAt(spec.at, locale) });
    default:
      return t('shell.agents.routines.noSchedule');
  }
}
