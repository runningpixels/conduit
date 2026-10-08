import { describe, expect, it } from 'vitest';
import { makeStatus, toastDismissMs, workflowRunStatus, WORKFLOW_RUN_TOAST_MS } from './statusTypes';

describe('toastDismissMs', () => {
  it('keeps the kind defaults: errors stay, warnings and successes leave', () => {
    expect(toastDismissMs(makeStatus('x', 'error'))).toBeNull();
    expect(toastDismissMs(makeStatus('x', 'warning'))).toBe(6000);
    expect(toastDismissMs(makeStatus('x', 'success'))).toBe(4000);
  });

  it('lets a workflow run toast leave after about 10 s, a failure included', () => {
    const failed = workflowRunStatus('Briefing failed', 'error');
    expect(failed.kind).toBe('error');
    expect(toastDismissMs(failed)).toBe(WORKFLOW_RUN_TOAST_MS);
    expect(WORKFLOW_RUN_TOAST_MS).toBe(10_000);
    expect(toastDismissMs(workflowRunStatus('Briefing finished', 'success'))).toBe(10_000);
  });

  it('never dismisses a toast that offers an action', () => {
    const toast = { ...workflowRunStatus('x', 'error'), action: { label: 'Open', run: () => {} } };
    expect(toastDismissMs(toast)).toBeNull();
  });
});
