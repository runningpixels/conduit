import { describe, expect, it } from 'vitest';
import type { WorkflowRunOutput } from '../ipc/contracts';
import { isUnread, otherOutputs, primaryOutput } from './results';

const out = (title: string, extra: Partial<WorkflowRunOutput> = {}): WorkflowRunOutput => ({
  kind: 'document',
  title,
  stepId: title,
  ...extra,
});

describe('primaryOutput', () => {
  it('is the last output that is new', () => {
    const run = { outputs: [out('a'), out('b'), out('c', { unchanged: true })] };
    expect(primaryOutput(run)?.title).toBe('b');
  });

  it('falls back to the last output when every one was kept', () => {
    const run = { outputs: [out('a', { unchanged: true }), out('b', { unchanged: true })] };
    expect(primaryOutput(run)?.title).toBe('b');
  });

  it('is null for a run with nothing saved', () => {
    expect(primaryOutput({ outputs: [] })).toBeNull();
    expect(primaryOutput({ outputs: null })).toBeNull();
    expect(primaryOutput({})).toBeNull();
  });
});

describe('otherOutputs', () => {
  it('lists the outputs besides the primary one', () => {
    const run = { outputs: [out('a'), out('b'), out('c', { unchanged: true })] };
    expect(otherOutputs(run).map((o) => o.title)).toEqual(['a', 'c']);
  });
});

describe('isUnread', () => {
  it('is true until the run has a seen time', () => {
    expect(isUnread({ seenAt: null })).toBe(true);
    expect(isUnread({})).toBe(true);
    expect(isUnread({ seenAt: '2026-10-11T08:00:00Z' })).toBe(false);
  });
});
