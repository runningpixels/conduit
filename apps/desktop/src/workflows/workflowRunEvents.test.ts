import { describe, expect, it } from 'vitest';
import type { WorkflowRunFinished } from '../ipc/contracts';
import { notificationFor } from './workflowRunEvents';

/// A stand-in `t` that shows which message and values were chosen.
const t = (id: string, values?: Record<string, unknown>) =>
  values ? `${id.split('.').pop()} ${JSON.stringify(values)}` : (id.split('.').pop() as string);

const base: WorkflowRunFinished = {
  workflowId: 'w1',
  workflowName: 'Morning briefing',
  runId: 'r1',
  status: 'completed',
  error: null,
  trigger: 'schedule',
  documents: [],
};

describe('notificationFor', () => {
  it('names the document a run saved', () => {
    const note = notificationFor(
      { ...base, documents: [{ artifactId: 'a1', conversationId: 'c1', title: 'Briefing' }] },
      t,
    );
    expect(note).toEqual({ title: 'Morning briefing', body: 'saved {"title":"Briefing"}' });
  });

  it('says it finished when nothing was saved, and why when it failed', () => {
    expect(notificationFor(base, t)).toEqual({ title: 'Morning briefing', body: 'completed' });
    expect(notificationFor({ ...base, status: 'failed', error: 'site answered 404' }, t)).toEqual({
      title: 'Morning briefing',
      body: 'failed {"error":"site answered 404"}',
    });
  });

  it('marks a catch-up run and stays quiet for a skipped slot', () => {
    expect(notificationFor({ ...base, trigger: 'catch_up' }, t)?.title).toBe('caughtUpTitle {"name":"Morning briefing"}');
    expect(notificationFor({ ...base, status: 'skipped' }, t)).toBeNull();
    expect(notificationFor({ ...base, workflowName: '' }, t)?.title).toBe('unnamed');
  });
});
