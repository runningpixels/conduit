import { describe, expect, it } from 'vitest';
import { parseScheduleTaskArgs, parseScheduleTaskJson, proposalDraft, proposalRequest } from './scheduleTask';

// Tuesday 2026-12-01, 10:00 local.
const NOW = new Date(2026, 11, 1, 10, 0);
const base = { name: 'Morning news', instructions: 'Summarize the top news in my field.' };

function ok(schedule: unknown, extra: Record<string, unknown> = {}) {
  const result = parseScheduleTaskArgs({ ...base, schedule, ...extra }, NOW);
  if (!result.ok) throw new Error(result.error);
  return result.proposal;
}

function error(args: unknown): string {
  const result = parseScheduleTaskArgs(args, NOW);
  if (result.ok) throw new Error('expected an error');
  return result.error;
}

describe('parseScheduleTaskArgs', () => {
  it('accepts each timed kind', () => {
    expect(ok({ kind: 'daily', time: '08:00' }).schedule).toEqual({ kind: 'daily', time: '08:00' });
    expect(ok({ kind: 'weekdays', time: '07:30' }).schedule).toEqual({ kind: 'weekdays', time: '07:30' });
    expect(ok({ kind: 'weekly', days: ['fri', 'mon'], time: '16:00' }).schedule).toEqual({
      kind: 'weekly',
      days: ['mon', 'fri'],
      time: '16:00',
    });
    expect(ok({ kind: 'monthly', day: 31, time: '09:00' }).schedule).toEqual({ kind: 'monthly', day: 31, time: '09:00' });
    expect(ok({ kind: 'interval', hours: 4 }).schedule).toEqual({ kind: 'interval', hours: 4 });
    expect(ok({ kind: 'once', at: '2026-12-02T09:00' }).schedule).toEqual({ kind: 'once', at: '2026-12-02T09:00' });
  });

  it('is forgiving about "8:00" and day names', () => {
    expect(ok({ kind: 'daily', time: '8:05' }).schedule).toEqual({ kind: 'daily', time: '08:05' });
    expect(ok({ kind: 'weekly', days: ['Monday', 'WED', 'monday'], time: '09:00' }).schedule).toEqual({
      kind: 'weekly',
      days: ['mon', 'wed'],
      time: '09:00',
    });
  });

  it('names the task from its instructions when the model gave no name, and defaults model and notify', () => {
    const result = parseScheduleTaskArgs({ instructions: 'Check the weather in Oslo.', schedule: { kind: 'daily', time: '07:00' } }, NOW);
    expect(result).toMatchObject({ ok: true, proposal: { name: 'Check the weather in Oslo', model: null, notify: false } });
  });

  it('keeps a model and notify', () => {
    const proposal = ok({ kind: 'daily', time: '08:00' }, { model: { provider: 'openrouter', model: 'x/y' }, notify: true });
    expect(proposal.model).toEqual({ provider: 'openrouter', model: 'x/y' });
    expect(proposal.notify).toBe(true);
  });

  it('rejects a bad time with a message that says what is accepted', () => {
    expect(error({ ...base, schedule: { kind: 'daily', time: '25:00' } })).toMatch(/HH:MM/);
    expect(error({ ...base, schedule: { kind: 'weekdays', time: '8pm' } })).toMatch(/24-hour/);
    expect(error({ ...base, schedule: { kind: 'weekdays' } })).toMatch(/schedule\.time/);
  });

  it('rejects an unknown day, an empty day list and a bad day of the month', () => {
    expect(error({ ...base, schedule: { kind: 'weekly', days: ['mon', 'someday'], time: '09:00' } })).toMatch(/Unknown day "someday"/);
    expect(error({ ...base, schedule: { kind: 'weekly', days: [], time: '09:00' } })).toMatch(/at least one day/);
    expect(error({ ...base, schedule: { kind: 'monthly', day: 32, time: '09:00' } })).toMatch(/1 to 31/);
    expect(error({ ...base, schedule: { kind: 'monthly', day: 1.5, time: '09:00' } })).toMatch(/1 to 31/);
  });

  it('rejects interval hours outside 1 to 24', () => {
    expect(error({ ...base, schedule: { kind: 'interval', hours: 0 } })).toMatch(/1 to 24/);
    expect(error({ ...base, schedule: { kind: 'interval', hours: 48 } })).toMatch(/1 to 24/);
    expect(error({ ...base, schedule: { kind: 'interval', hours: '4' } })).toMatch(/1 to 24/);
  });

  it('rejects a one-time run in the past, or one that is not a real local date and time', () => {
    expect(error({ ...base, schedule: { kind: 'once', at: '2026-12-01T09:00' } })).toMatch(/in the past/);
    expect(error({ ...base, schedule: { kind: 'once', at: '2026-12-01T10:00' } })).toMatch(/in the past/);
    expect(error({ ...base, schedule: { kind: 'once', at: 'tomorrow at 9' } })).toMatch(/YYYY-MM-DDTHH:MM/);
    expect(error({ ...base, schedule: { kind: 'once', at: '2026-02-30T09:00' } })).toMatch(/YYYY-MM-DDTHH:MM/);
    expect(error({ ...base, schedule: { kind: 'once', at: '2026-12-02T24:00' } })).toMatch(/YYYY-MM-DDTHH:MM/);
  });

  it('refuses a trigger and an unknown kind, and says what to do instead', () => {
    expect(error({ ...base, schedule: { kind: 'trigger' } })).toMatch(/cannot be set up in chat/);
    expect(error({ ...base, schedule: { kind: 'hourly' } })).toMatch(/must be one of: daily, weekdays, weekly, monthly, interval, once/);
    expect(error({ ...base, schedule: 'every day' })).toMatch(/must be an object/);
  });

  it('requires instructions and a schedule', () => {
    expect(error({ name: 'x', schedule: { kind: 'daily', time: '08:00' } })).toMatch(/instructions is required/);
    expect(error({ ...base })).toMatch(/schedule is required/);
    expect(error(null)).toMatch(/must be an object/);
  });

  it('rejects a malformed model or notify', () => {
    expect(error({ ...base, schedule: { kind: 'daily', time: '08:00' }, model: 'gpt' })).toMatch(/provider/);
    expect(error({ ...base, schedule: { kind: 'daily', time: '08:00' }, model: { provider: 'a' } })).toMatch(/provider/);
    expect(error({ ...base, schedule: { kind: 'daily', time: '08:00' }, notify: 'yes' })).toMatch(/notify/);
  });

  it('reads arguments given as JSON, and reports JSON that does not parse', () => {
    const json = JSON.stringify({ ...base, schedule: { kind: 'daily', time: '08:00' } });
    expect(parseScheduleTaskJson(json, NOW)).toMatchObject({ ok: true });
    expect(parseScheduleTaskJson('{nope', NOW)).toEqual({ ok: false, error: 'The arguments were not valid JSON.' });
  });
});

describe('what a proposal becomes', () => {
  const proposal = ok({ kind: 'weekly', days: ['mon'], time: '09:00' }, { notify: true, model: { provider: 'p', model: 'm' } });

  it('is a chat task for the assistant itself', () => {
    expect(proposalRequest(proposal)).toEqual({
      agentId: null,
      model: { provider: 'p', model: 'm' },
      name: 'Morning news',
      task: 'Summarize the top news in my field.',
      schedule: { kind: 'weekly', days: ['mon'], time: '09:00' },
      trigger: null,
      notify: true,
      output: 'chat',
      folder: null,
    });
  });

  it('fills the form', () => {
    expect(proposalDraft(proposal)).toMatchObject({
      name: 'Morning news',
      task: 'Summarize the top news in my field.',
      when: 'weekly',
      spec: { kind: 'weekly', days: ['mon'], time: '09:00' },
      model: { provider: 'p', model: 'm' },
      notify: true,
      agentId: '',
      output: 'chat',
    });
  });
});
