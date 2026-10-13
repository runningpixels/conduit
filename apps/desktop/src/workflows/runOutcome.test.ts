import { describe, expect, it } from 'vitest';

import type { WorkflowRunDetail, WorkflowRunStep } from '../ipc/contracts';
import { nothingNewStop } from './runOutcome';

function row(stepId: string, type: string, output: Record<string, unknown>): WorkflowRunStep {
  return { id: stepId, runId: 'r', stepId, iteration: null, status: 'completed', input: { type }, output, error: null, startedAt: '2026-10-12T10:00:00Z', finishedAt: '2026-10-12T10:00:01Z' } as WorkflowRunStep;
}

function detail(steps: WorkflowRunStep[], outcome: string | null = null): WorkflowRunDetail {
  return { run: { id: 'r', workflowId: 'w', status: 'completed', outcome, outcomeStep: null } as WorkflowRunDetail['run'], steps };
}

describe('nothingNewStop', () => {
  it('names the condition that did not pass', () => {
    expect(nothingNewStop(detail([row('check', 'condition', { passed: false })]))).toEqual({ stepId: 'check' });
  });

  it('is null when an If… otherwise went its no way: the run carried on', () => {
    const steps = [row('pick', 'branch', { passed: false, arm: 'no', text: 'no' }), row('after', 'template', { text: 'x' })];
    expect(nothingNewStop(detail(steps))).toBeNull();
  });

  it('still reads the run outcome when one is recorded', () => {
    expect(nothingNewStop(detail([], 'nothing_new'))).toEqual({ stepId: null });
  });
});
