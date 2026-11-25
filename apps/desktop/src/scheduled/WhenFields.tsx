/// The "when" controls shared by the task dialog and the workflow editor's schedule section: a
/// dropdown of kinds (every day, weekdays, chosen days of the week, monthly, every few hours, once,
/// and, in the task dialog, a new file or feed post) and the options of the kind chosen: a time, day
/// chips, a day of the month, an hour count or a date and time.

import { useId } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import type { ScheduleDay } from '../ipc/contracts';
import { INTERVAL_HOURS, TIMED_KINDS, WEEK_DAYS, specForKind, timeOf, weekdayName, withTime, type TimedSpec, type WhenKind } from './schedule';

const KIND_KEYS: Record<WhenKind, string> = {
  daily: 'workspace.workflows.schedule.daily',
  weekdays: 'workspace.workflows.schedule.weekdays',
  weekly: 'shell.scheduled.whenKind.weekly',
  monthly: 'shell.scheduled.whenKind.monthly',
  interval: 'workspace.workflows.schedule.interval',
  once: 'shell.scheduled.whenKind.once',
  folder: 'shell.agents.routines.whenFolder',
  feed: 'shell.agents.routines.whenFeed',
};

const MONTH_DAYS = Array.from({ length: 31 }, (_, i) => i + 1);

export function WhenFields({
  kind,
  spec,
  onKind,
  onSpec,
  triggers = false,
  disabled = false,
  label,
}: {
  /// The kind chosen; a trigger kind (`folder`, `feed`) has no timed options.
  kind: WhenKind;
  /// The timed spec the options edit (kept while a trigger kind is chosen, so switching back keeps it).
  spec: TimedSpec;
  onKind: (kind: WhenKind) => void;
  onSpec: (spec: TimedSpec) => void;
  /// Offer "When a file arrives in a folder" and "When a feed has a new post".
  triggers?: boolean;
  disabled?: boolean;
  /// The dropdown's label; "When" when left out.
  label?: string;
}) {
  const t = useT();
  const fmt = useFormatters();
  const timeId = useId();
  const kinds: readonly WhenKind[] = triggers ? [...TIMED_KINDS, 'folder', 'feed'] : TIMED_KINDS;
  const time = timeOf(spec) ?? '';
  const dayChip = (day: ScheduleDay) => {
    if (spec.kind !== 'weekly') return null;
    const on = spec.days.includes(day);
    return (
      <button
        key={day}
        type="button"
        className="sched-day"
        aria-pressed={on}
        aria-label={weekdayName(day, fmt.locale)}
        disabled={disabled}
        onClick={() => {
          const days = on ? spec.days.filter((d) => d !== day) : [...spec.days, day];
          // At least one day stays on.
          if (days.length > 0) onSpec({ ...spec, days: WEEK_DAYS.filter((d) => days.includes(d)) });
        }}
      >
        {weekdayName(day, fmt.locale, 'short')}
      </button>
    );
  };
  return (
    <div className="sched-when">
      <div className="sched-when-row">
        <label className="wf-field">
          <span>{label ?? t('shell.agents.routines.when')}</span>
          <select
            className="sel"
            value={kind}
            disabled={disabled}
            onChange={(e) => {
              const next = e.target.value as WhenKind;
              onKind(next);
              if (next !== 'folder' && next !== 'feed') onSpec(specForKind(next, spec));
            }}
          >
            {kinds.map((k) => (
              <option key={k} value={k}>
                {t(KIND_KEYS[k])}
              </option>
            ))}
          </select>
        </label>
        {kind === 'monthly' && spec.kind === 'monthly' ? (
          <label className="wf-field">
            <span>{t('shell.scheduled.when.day')}</span>
            <select
              className="sel"
              value={spec.day}
              disabled={disabled}
              onChange={(e) => onSpec({ ...spec, day: Number(e.target.value) })}
            >
              {MONTH_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {kind === 'interval' && spec.kind === 'interval' ? (
          <label className="wf-field">
            <span>{t('workspace.workflows.schedule.every')}</span>
            <select
              className="sel"
              value={spec.hours}
              disabled={disabled}
              onChange={(e) => onSpec({ kind: 'interval', hours: Number(e.target.value) })}
            >
              {INTERVAL_HOURS.map((h) => (
                <option key={h} value={h}>
                  {t('workspace.workflows.schedule.hours', { count: h })}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {kind === 'once' && spec.kind === 'once' ? (
          <label className="wf-field">
            <span>{t('shell.scheduled.when.date')}</span>
            <input
              className="mem-input"
              type="datetime-local"
              value={spec.at}
              disabled={disabled}
              onChange={(e) => {
                if (e.target.value) onSpec({ kind: 'once', at: e.target.value.slice(0, 16) });
              }}
            />
          </label>
        ) : null}
        {kind === 'daily' || kind === 'weekdays' || kind === 'weekly' || kind === 'monthly' ? (
          <label className="wf-field" htmlFor={timeId}>
            <span>{t('workspace.workflows.schedule.at')}</span>
            <input
              id={timeId}
              className="mem-input"
              type="time"
              value={time}
              disabled={disabled}
              onChange={(e) => {
                if (e.target.value) onSpec(withTime(spec, e.target.value));
              }}
            />
          </label>
        ) : null}
      </div>
      {kind === 'weekly' && spec.kind === 'weekly' ? (
        <div className="sched-days" role="group" aria-label={t('shell.scheduled.when.days')}>
          {WEEK_DAYS.map(dayChip)}
        </div>
      ) : null}
    </div>
  );
}
