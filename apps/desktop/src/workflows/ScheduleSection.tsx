/// A workflow's schedule: run it automatically every day or on weekdays at a
/// time, or every few hours. Changes save as they are made; the backend works
/// out the next run in the user's time zone and wakes the scheduler.
///
/// Nobody watches a scheduled run, so turning a schedule on first shows
/// everything the workflow will be allowed to do and asks the user to approve
/// it. When an edit later needs more, the section says what and offers to
/// approve it; until then a scheduled run pauses and asks.

import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import {
  approveWorkflowPermissions,
  getWorkflowPermissions,
  getWorkflowSchedule,
  setWorkflowSchedule,
} from '../ipc/client';
import type { ScheduleSpec, WorkflowPermissions, WorkflowPermissionView, WorkflowSchedule } from '../ipc/contracts';
import { BackgroundSection } from './BackgroundSection';
import { permissionText } from './permissionText';

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

function PermissionList({ items }: { items: WorkflowPermissionView[] }) {
  const t = useT();
  return (
    <ul className="wf-permission-list">
      {items.map((p) => (
        <li key={JSON.stringify(p)}>{permissionText(p, t)}</li>
      ))}
    </ul>
  );
}

export function ScheduleSection({
  workflowId,
  refreshKey,
  definitionVersion,
  onStatus,
  onChanged,
}: {
  workflowId: string;
  /// Changes when a scheduled run finishes, so the next time is re-read.
  refreshKey?: number;
  /// The workflow's version: an edit can change what it needs approved.
  definitionVersion?: number;
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
  /// `null` when it couldn't be read: turning on then goes ahead, and a
  /// scheduled run still asks before doing anything unapproved.
  const [permissions, setPermissions] = useState<WorkflowPermissions | null>(null);
  /// Turning the schedule on, waiting for the user to approve what it may do.
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getWorkflowPermissions(workflowId).then(
      (next) => {
        if (!cancelled) setPermissions(next);
      },
      () => {
        if (!cancelled) setPermissions(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workflowId, refreshKey, definitionVersion]);

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

  /// Approve what the workflow needs now; `true` when that worked.
  const approve = async (): Promise<boolean> => {
    setSaving(true);
    try {
      setPermissions(await approveWorkflowPermissions(workflowId));
      return true;
    } catch (e) {
      onStatus(t('workspace.workflows.permissions.approveFailed', { error: errorText(e) }));
      return false;
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;
  const enabled = schedule?.enabled ?? false;
  const spec = schedule?.spec ?? DEFAULT_SCHEDULE;
  const kind = spec.kind;
  const missing = permissions?.missing ?? [];

  return (
    <section className="grp wf-schedule" aria-label={t('workspace.workflows.schedule.title')}>
      <div className="grp-label">{t('workspace.workflows.schedule.title')}</div>
      <label className="wf-check">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => {
            if (e.target.checked && missing.length > 0) setApproving(true);
            else void save(spec, e.target.checked);
          }}
        />
        {t('workspace.workflows.schedule.enabled')}
      </label>
      {approving && permissions ? (
        <div className="wf-offer" role="group" aria-label={t('workspace.workflows.permissions.approveTitle')}>
          <b>{t('workspace.workflows.permissions.approveTitle')}</b>
          <p className="wf-muted">{t('workspace.workflows.permissions.approveBody')}</p>
          <PermissionList items={permissions.required} />
          <div className="wf-offer-actions">
            <button
              type="button"
              className="btn primary"
              disabled={saving}
              onClick={async () => {
                if (await approve()) {
                  setApproving(false);
                  await save(spec, true);
                }
              }}
            >
              {t('workspace.workflows.permissions.approveAndTurnOn')}
            </button>
            <button type="button" className="btn" disabled={saving} onClick={() => setApproving(false)}>
              {t('common.actions.cancel')}
            </button>
          </div>
        </div>
      ) : null}
      {enabled && missing.length > 0 ? (
        <div className="wf-offer" role="group" aria-label={t('workspace.workflows.permissions.moreTitle')}>
          <b>{t('workspace.workflows.permissions.moreTitle')}</b>
          <PermissionList items={missing} />
          <p className="wf-muted">{t('workspace.workflows.permissions.moreBody')}</p>
          <div className="wf-offer-actions">
            <button type="button" className="btn primary" disabled={saving} onClick={() => void approve()}>
              {t('workspace.workflows.permissions.approve')}
            </button>
          </div>
        </div>
      ) : null}
      {enabled && missing.length === 0 && permissions && permissions.required.length > 0 ? (
        <p className="wf-muted wf-allowed">
          {t('workspace.workflows.permissions.allowed', {
            list: permissions.required.map((p) => permissionText(p, t)).join(' · '),
          })}
        </p>
      ) : null}
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
      <BackgroundSection scheduleEnabled={enabled} onStatus={onStatus} />
    </section>
  );
}
