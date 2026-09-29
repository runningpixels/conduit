/// A workflow's schedule: run it automatically every day or on weekdays at a
/// time, or every few hours. Changes save as they are made; the backend works
/// out the next run in the user's time zone and wakes the scheduler.

import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { getWorkflowSchedule, setWorkflowSchedule } from '../ipc/client';
import type { ScheduleSpec, WorkflowSchedule } from '../ipc/contracts';

/// What a schedule starts as when it is first switched on.
export const DEFAULT_TIME = '08:00';
export const DEFAULT_SCHEDULE: ScheduleSpec = { kind: 'daily', time: DEFAULT_TIME };
/// Choices for "every N hours".
export const INTERVAL_HOURS = [1, 2, 3, 4, 6, 8, 12, 24] as const;

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}

/// "Tue, Sep 29, 8:00 AM" in the user's locale.
export function formatNextRun(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

export function ScheduleSection({
  workflowId,
  refreshKey,
  onStatus,
  onChanged,
}: {
  workflowId: string;
  /// Changes when a scheduled run finishes, so the next time is re-read.
  refreshKey?: number;
  onStatus: (message: string) => void;
  /// Called after a change is saved (the list shows the next run too).
  onChanged?: () => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const timeId = useId();
  const [schedule, setSchedule] = useState<WorkflowSchedule | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getWorkflowSchedule(workflowId).then(
      (next) => {
        if (cancelled) return;
        setSchedule(next);
        setLoaded(true);
      },
      () => {
        if (!cancelled) setLoaded(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workflowId, refreshKey]);

  const save = async (spec: ScheduleSpec, enabled: boolean) => {
    setSaving(true);
    try {
      const saved = await setWorkflowSchedule(workflowId, spec, enabled);
      setSchedule(saved);
      onChanged?.();
    } catch (e) {
      onStatus(t('workspace.workflows.schedule.saveFailed', { error: errorText(e) }));
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;
  const enabled = schedule?.enabled ?? false;
  const spec = schedule?.spec ?? DEFAULT_SCHEDULE;
  const kind = spec.kind;

  return (
    <section className="grp wf-schedule" aria-label={t('workspace.workflows.schedule.title')}>
      <div className="grp-label">{t('workspace.workflows.schedule.title')}</div>
      <label className="wf-check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => void save(spec, e.target.checked)}
        />
        {t('workspace.workflows.schedule.enabled')}
      </label>
      {enabled ? (
        <>
          <div className="wf-input-row">
            <label className="wf-field">
              <span>{t('workspace.workflows.schedule.often')}</span>
              <select
                className="sel"
                value={kind}
                disabled={saving}
                onChange={(e) => {
                  const next = e.target.value as ScheduleSpec['kind'];
                  const time = spec.kind === 'interval' ? DEFAULT_TIME : spec.time;
                  void save(next === 'interval' ? { kind: 'interval', hours: 4 } : { kind: next, time }, true);
                }}
              >
                <option value="daily">{t('workspace.workflows.schedule.daily')}</option>
                <option value="weekdays">{t('workspace.workflows.schedule.weekdays')}</option>
                <option value="interval">{t('workspace.workflows.schedule.interval')}</option>
              </select>
            </label>
            {spec.kind === 'interval' ? (
              <label className="wf-field">
                <span>{t('workspace.workflows.schedule.every')}</span>
                <select
                  className="sel"
                  value={spec.hours}
                  disabled={saving}
                  onChange={(e) => void save({ kind: 'interval', hours: Number(e.target.value) }, true)}
                >
                  {INTERVAL_HOURS.map((h) => (
                    <option key={h} value={h}>
                      {t('workspace.workflows.schedule.hours', { count: h })}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="wf-field" htmlFor={timeId}>
                <span>{t('workspace.workflows.schedule.at')}</span>
                <input
                  id={timeId}
                  className="mem-input"
                  type="time"
                  value={spec.time}
                  disabled={saving}
                  onChange={(e) => {
                    if (e.target.value) void save({ kind: spec.kind, time: e.target.value }, true);
                  }}
                />
              </label>
            )}
          </div>
          {schedule?.nextRunAt ? (
            <p className="wf-next-run">
              {t('workspace.workflows.schedule.next', { when: formatNextRun(schedule.nextRunAt, fmt.locale) })}
            </p>
          ) : null}
        </>
      ) : null}
      <p className="wf-muted">{t('workspace.workflows.schedule.hint')}</p>
    </section>
  );
}
