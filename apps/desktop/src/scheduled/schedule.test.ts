import { describe, expect, it } from 'vitest';
import { enTranslate as t } from '../test/enTranslate';
import { describeSchedule, defaultOnceAt, localDateTime, specForKind, timeOf, withTime } from './schedule';
import { draftFromTask, emptyDraft, taskRequest } from './taskForm';
import { TEMPLATES, draftFromTemplate, templateText } from './templates';
import type { ScheduledItem } from '../ipc/contracts';

describe('describeSchedule', () => {
  const en = (spec: Parameters<typeof describeSchedule>[0], trigger?: Parameters<typeof describeSchedule>[1]) =>
    describeSchedule(spec, trigger ?? null, t, 'en');

  it('describes the time kinds that existed', () => {
    expect(en({ kind: 'daily', time: '08:00' })).toBe('Every day at 08:00');
    expect(en({ kind: 'weekdays', time: '08:00' })).toBe('Weekdays at 08:00');
    expect(en({ kind: 'interval', hours: 4 })).toBe('Every 4 hours');
    expect(en({ kind: 'interval', hours: 1 })).toBe('Every hour');
  });

  it('names the days of a weekly schedule, in week order', () => {
    expect(en({ kind: 'weekly', days: ['mon'], time: '09:00' })).toBe('Every Monday at 09:00');
    expect(en({ kind: 'weekly', days: ['fri', 'mon'], time: '09:00' })).toBe('Every Monday and Friday at 09:00');
    expect(en({ kind: 'weekly', days: ['mon', 'wed', 'fri'], time: '09:00' })).toBe('Every Monday, Wednesday, and Friday at 09:00');
  });

  it('calls Monday to Friday weekdays and all seven days every day', () => {
    expect(en({ kind: 'weekly', days: ['fri', 'thu', 'wed', 'tue', 'mon'], time: '07:00' })).toBe('Weekdays at 07:00');
    expect(en({ kind: 'weekly', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], time: '07:00' })).toBe('Every day at 07:00');
  });

  it('describes monthly and one-time schedules', () => {
    expect(en({ kind: 'monthly', day: 15, time: '10:30' })).toBe('Monthly on day 15 at 10:30');
    expect(en({ kind: 'once', at: '2026-12-01T09:00' })).toMatch(/^Once, .*2026.*9:00/);
  });

  it('describes triggers and a missing schedule', () => {
    expect(en({ kind: 'trigger' }, { kind: 'folder' })).toBe('When a new file arrives');
    expect(en({ kind: 'trigger' }, { kind: 'feed', url: 'https://example.com/feed', everyMinutes: 30 })).toBe(
      'When the feed has a new post',
    );
    expect(en(null)).toBe('No schedule');
  });

  it('writes weekday names in the locale given', () => {
    expect(describeSchedule({ kind: 'weekly', days: ['mon'], time: '09:00' }, null, t, 'de')).toContain('Montag');
  });
});

describe('specForKind', () => {
  const now = new Date(2026, 10, 24, 12, 0);

  it('keeps the time when the kind changes', () => {
    expect(specForKind('weekdays', { kind: 'daily', time: '07:15' })).toEqual({ kind: 'weekdays', time: '07:15' });
    expect(specForKind('weekly', { kind: 'daily', time: '07:15' })).toEqual({ kind: 'weekly', days: ['mon'], time: '07:15' });
    expect(specForKind('monthly', { kind: 'weekdays', time: '06:00' })).toEqual({ kind: 'monthly', day: 1, time: '06:00' });
    expect(specForKind('daily', { kind: 'once', at: '2026-12-01T21:30' })).toEqual({ kind: 'daily', time: '21:30' });
  });

  it('starts an interval at four hours, and a one-time task tomorrow at the time', () => {
    expect(specForKind('interval', { kind: 'daily', time: '08:00' })).toEqual({ kind: 'interval', hours: 4 });
    expect(specForKind('once', { kind: 'daily', time: '09:30' }, now)).toEqual({ kind: 'once', at: '2026-11-25T09:30' });
  });

  it('keeps what a kind already holds', () => {
    expect(specForKind('weekly', { kind: 'weekly', days: ['tue', 'thu'], time: '10:00' })).toEqual({
      kind: 'weekly',
      days: ['tue', 'thu'],
      time: '10:00',
    });
  });

  it('reads and sets the time of every kind that has one', () => {
    expect(timeOf({ kind: 'once', at: '2026-12-01T09:05' })).toBe('09:05');
    expect(timeOf({ kind: 'interval', hours: 2 })).toBeNull();
    expect(withTime({ kind: 'once', at: '2026-12-01T09:05' }, '10:00')).toEqual({ kind: 'once', at: '2026-12-01T10:00' });
    expect(withTime({ kind: 'monthly', day: 3, time: '09:05' }, '10:00')).toEqual({ kind: 'monthly', day: 3, time: '10:00' });
  });

  it('writes a local date and time the way the backend reads it', () => {
    expect(localDateTime(new Date(2026, 0, 5, 7, 4))).toBe('2026-01-05T07:04');
    expect(defaultOnceAt('08:00', new Date(2026, 11, 31, 22, 0))).toBe('2027-01-01T08:00');
  });
});

describe('taskRequest', () => {
  const base = { ...emptyDraft(new Date(2026, 10, 24)), task: '  Brief me on EU energy prices since yesterday  ' };

  it('sends a chat task for the assistant by default, named after its text', () => {
    expect(taskRequest(base)).toEqual({
      agentId: null,
      model: null,
      name: 'Brief me on EU energy prices',
      task: 'Brief me on EU energy prices since yesterday',
      schedule: { kind: 'weekdays', time: '08:00' },
      trigger: null,
      notify: false,
      output: 'chat',
      folder: null,
    });
  });

  it('sends an agent, a model, the output and a folder as chosen', () => {
    const request = taskRequest({
      ...base,
      name: ' Prices ',
      agentId: 'researcher',
      model: { provider: 'openrouter', model: 'glm' },
      output: 'file',
      notify: true,
      folder: ' C:\\Work ',
    });
    expect(request).toMatchObject({
      agentId: 'researcher',
      model: { provider: 'openrouter', model: 'glm' },
      name: 'Prices',
      output: 'file',
      notify: true,
      folder: 'C:\\Work',
    });
  });

  it('sends each kind of when', () => {
    const when = (draft: Partial<typeof base>) => taskRequest({ ...base, ...draft });
    expect(when({ when: 'daily', spec: { kind: 'daily', time: '09:00' } }).schedule).toEqual({ kind: 'daily', time: '09:00' });
    expect(when({ when: 'weekly', spec: { kind: 'weekly', days: ['mon', 'fri'], time: '09:00' } }).schedule).toEqual({
      kind: 'weekly',
      days: ['mon', 'fri'],
      time: '09:00',
    });
    expect(when({ when: 'monthly', spec: { kind: 'monthly', day: 31, time: '09:00' } }).schedule).toEqual({
      kind: 'monthly',
      day: 31,
      time: '09:00',
    });
    expect(when({ when: 'interval', spec: { kind: 'interval', hours: 6 } }).schedule).toEqual({ kind: 'interval', hours: 6 });
    expect(when({ when: 'once', spec: { kind: 'once', at: '2026-12-01T09:00' } }).schedule).toEqual({
      kind: 'once',
      at: '2026-12-01T09:00',
    });
    expect(when({ when: 'folder' })).toMatchObject({ schedule: { kind: 'trigger' }, trigger: { kind: 'folder' } });
    expect(when({ when: 'feed', feedUrl: ' https://example.com/feed ' })).toMatchObject({
      schedule: { kind: 'trigger' },
      trigger: { kind: 'feed', url: 'https://example.com/feed', everyMinutes: 30 },
    });
  });
});

describe('draftFromTask', () => {
  const item: ScheduledItem = {
    workflowId: 'wf-1',
    kind: 'task',
    name: 'Morning news',
    task: 'Summarize the news',
    agentId: null,
    schedule: { kind: 'weekly', days: ['mon'], time: '07:00' },
    trigger: null,
    enabled: true,
    nextRunAt: null,
    lastRunId: null,
    lastRunStatus: null,
    lastRunAt: null,
    lastResultTitle: null,
    lastConversationId: null,
    lastArtifactId: null,
  };

  it('reads the output, notification, model and folder back from the workflow', () => {
    const record = {
      definition: {
        folder: 'C:\\Work',
        steps: [
          { id: 'work', type: 'agent', prompt: 'Summarize the news', model: { provider: 'p', model: 'm' } },
          { id: 'save', type: 'export_file', name: 'n', content: 'c' },
          { id: 'tell', type: 'notify', title: 't' },
        ],
      },
    } as never;
    expect(draftFromTask(item, record)).toMatchObject({
      name: 'Morning news',
      task: 'Summarize the news',
      agentId: '',
      model: { provider: 'p', model: 'm' },
      when: 'weekly',
      spec: { kind: 'weekly', days: ['mon'], time: '07:00' },
      folder: 'C:\\Work',
      output: 'file',
      notify: true,
    });
  });

  it('defaults to a chat, and reads a folder trigger', () => {
    expect(draftFromTask({ ...item, schedule: { kind: 'trigger' }, trigger: { kind: 'folder' } }, null)).toMatchObject({
      when: 'folder',
      output: 'chat',
      notify: false,
    });
  });
});

describe('templates', () => {
  it('has the six templates, each with text, and instructions that need no email or calendar', () => {
    expect(TEMPLATES.map((x) => x.id)).toEqual([
      'dailyBriefing',
      'monitorTopic',
      'weeklyReview',
      'contentIdeas',
      'watchPage',
      'folderDigest',
    ]);
    for (const template of TEMPLATES) {
      const text = templateText(template.id, t);
      expect(text.name).not.toBe('');
      expect(text.description).not.toBe('');
      expect(text.instructions).not.toMatch(/e-?mail|calendar|inbox|slack/i);
    }
  });

  it('fills the dialog with a template’s name, instructions and default time', () => {
    const weekly = TEMPLATES.find((x) => x.id === 'weeklyReview')!;
    expect(draftFromTemplate(weekly, t)).toMatchObject({
      name: 'Weekly review',
      when: 'weekly',
      spec: { kind: 'weekly', days: ['fri'], time: '16:00' },
      output: 'chat',
    });
    const folder = TEMPLATES.find((x) => x.id === 'folderDigest')!;
    expect(draftFromTemplate(folder, t)).toMatchObject({ name: 'Folder digest', when: 'folder' });
  });
});
