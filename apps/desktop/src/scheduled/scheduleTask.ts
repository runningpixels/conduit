/// What the chat tool `schedule_task` is given: the model's arguments checked and turned into a task
/// request and a form draft. Anything wrong comes back as a sentence the model can read and fix
/// ("The time must be HH:MM, 24-hour"), never as a throw. The messages are for the model, so they
/// are English whatever the app's language.

import type { RoutineRequest, ScheduleDay, WorkflowModel } from '../ipc/contracts';
import { TIMED_KINDS, WEEK_DAYS, localDateTime, type TimedSpec } from './schedule';
import { emptyDraft, nameFromTask, type TaskDraft } from './taskForm';

/// A task the model drafted, ready to show in the confirm card.
export interface TaskProposal {
  name: string;
  instructions: string;
  schedule: TimedSpec;
  model: WorkflowModel | null;
  notify: boolean;
}

export type ProposalResult = { ok: true; proposal: TaskProposal } | { ok: false; error: string };

const MAX_HOURS = 24;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(error: string): ProposalResult {
  return { ok: false, error };
}

/// `HH:MM` for "8:00" or "08:00", else null.
function normalTime(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

const TIME_HINT = 'a 24-hour "HH:MM" time in the user\'s local time, such as "08:00" or "17:30"';

/// A weekday from "mon" or "Monday" (any case), else null.
function normalDay(value: unknown): ScheduleDay | null {
  if (typeof value !== 'string') return null;
  const short = value.trim().toLowerCase().slice(0, 3);
  return WEEK_DAYS.find((d) => d === short) ?? null;
}

function checkSchedule(raw: unknown, now: Date): { ok: true; spec: TimedSpec } | { ok: false; error: string } {
  if (!isRecord(raw)) {
    return { ok: false, error: `schedule must be an object such as {"kind":"weekdays","time":"08:00"}. Kinds: ${TIMED_KINDS.join(', ')}.` };
  }
  const kind = raw.kind;
  if (kind === 'trigger') {
    return { ok: false, error: 'Tasks that start when a file or feed item arrives cannot be set up in chat. Use a timed schedule, or tell the user to use the New task form.' };
  }
  if (typeof kind !== 'string' || !(TIMED_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, error: `schedule.kind must be one of: ${TIMED_KINDS.join(', ')}.` };
  }
  switch (kind as TimedSpec['kind']) {
    case 'daily':
    case 'weekdays': {
      const time = normalTime(raw.time);
      if (!time) return { ok: false, error: `schedule.time must be ${TIME_HINT}.` };
      return { ok: true, spec: { kind: kind as 'daily' | 'weekdays', time } };
    }
    case 'weekly': {
      const time = normalTime(raw.time);
      if (!time) return { ok: false, error: `schedule.time must be ${TIME_HINT}.` };
      if (!Array.isArray(raw.days) || raw.days.length === 0) {
        return { ok: false, error: `schedule.days must list at least one day of: ${WEEK_DAYS.join(', ')}.` };
      }
      const days: ScheduleDay[] = [];
      for (const entry of raw.days) {
        const day = normalDay(entry);
        if (!day) return { ok: false, error: `Unknown day ${JSON.stringify(entry)}. Days are: ${WEEK_DAYS.join(', ')}.` };
        if (!days.includes(day)) days.push(day);
      }
      return { ok: true, spec: { kind: 'weekly', days: WEEK_DAYS.filter((d) => days.includes(d)), time } };
    }
    case 'monthly': {
      const time = normalTime(raw.time);
      if (!time) return { ok: false, error: `schedule.time must be ${TIME_HINT}.` };
      const day = raw.day;
      if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 31) {
        return { ok: false, error: 'schedule.day must be a whole number from 1 to 31 (a shorter month runs on its last day).' };
      }
      return { ok: true, spec: { kind: 'monthly', day, time } };
    }
    case 'interval': {
      const hours = raw.hours;
      if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < 1 || hours > MAX_HOURS) {
        return { ok: false, error: `schedule.hours must be a whole number from 1 to ${MAX_HOURS}.` };
      }
      return { ok: true, spec: { kind: 'interval', hours } };
    }
    case 'once': {
      const at = typeof raw.at === 'string' ? raw.at.trim() : '';
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(at);
      const [y, mo, d, h, mi] = m ? m.slice(1).map(Number) : [];
      const real = m ? new Date(y!, mo! - 1, d!, h!, mi!) : null;
      const valid = real !== null && real.getFullYear() === y && real.getMonth() === mo! - 1 && real.getDate() === d && h! < 24 && mi! < 60;
      if (!m || !valid) {
        return { ok: false, error: 'schedule.at must be a local date and time as "YYYY-MM-DDTHH:MM", such as "2026-12-01T09:00". Call current_time if you need today\'s date.' };
      }
      if (at <= localDateTime(now)) {
        return { ok: false, error: `schedule.at ${at} is in the past (it is now ${localDateTime(now)} local time). Pick a later time.` };
      }
      return { ok: true, spec: { kind: 'once', at } };
    }
  }
}

/// The model's arguments to `schedule_task`, checked. `now` is the local time a one-time run must be after.
export function parseScheduleTaskArgs(raw: unknown, now: Date = new Date()): ProposalResult {
  if (!isRecord(raw)) return fail('The arguments must be an object with name, instructions and schedule.');
  const instructions = typeof raw.instructions === 'string' ? raw.instructions.trim() : '';
  if (!instructions) return fail('instructions is required: what the task does each time it runs, written so it can run on its own.');
  const named = typeof raw.name === 'string' ? raw.name.trim() : '';
  const name = named || nameFromTask(instructions);
  if (raw.schedule === undefined || raw.schedule === null) {
    return fail('schedule is required. Ask the user how often and when it should run, then pass e.g. {"kind":"weekdays","time":"08:00"}.');
  }
  const checked = checkSchedule(raw.schedule, now);
  if (!checked.ok) return fail(checked.error);

  let model: WorkflowModel | null = null;
  if (raw.model !== undefined && raw.model !== null) {
    const m = raw.model;
    if (!isRecord(m) || typeof m.provider !== 'string' || typeof m.model !== 'string' || !m.provider.trim() || !m.model.trim()) {
      return fail('model must be {"provider": "...", "model": "..."}, or left out to use the default model.');
    }
    model = { provider: m.provider.trim(), model: m.model.trim() };
  }
  if (raw.notify !== undefined && raw.notify !== null && typeof raw.notify !== 'boolean') {
    return fail('notify must be true or false.');
  }
  return {
    ok: true,
    proposal: { name, instructions, schedule: checked.spec, model, notify: raw.notify === true },
  };
}

/// The same arguments as a JSON string (what the card receives from the backend), checked.
export function parseScheduleTaskJson(json: string, now: Date = new Date()): ProposalResult {
  try {
    return parseScheduleTaskArgs(JSON.parse(json), now);
  } catch {
    return fail('The arguments were not valid JSON.');
  }
}

/// What the confirm card creates: a task for the assistant itself, its result a new chat.
export function proposalRequest(p: TaskProposal): RoutineRequest {
  return {
    agentId: null,
    model: p.model,
    name: p.name,
    task: p.instructions,
    schedule: p.schedule,
    trigger: null,
    notify: p.notify,
    output: 'chat',
    folder: null,
  };
}

/// The task dialog's fields, filled from the proposal ("Edit in form").
export function proposalDraft(p: TaskProposal): TaskDraft {
  return {
    ...emptyDraft(),
    name: p.name,
    task: p.instructions,
    model: p.model,
    when: p.schedule.kind,
    spec: p.schedule,
    notify: p.notify,
  };
}
