import { describe, expect, it } from 'vitest';
import type { WorkflowQuestion } from '../ipc/contracts';
import { choiceStyle } from './WorkflowsPage';

const question = (choices: string[], fallback: string | null): WorkflowQuestion =>
  ({ runId: 'r', workflowId: 'w', workflowName: 'W', stepId: 's', question: 'q', choices, default: fallback, requestedAt: '', expiresAt: '' }) as WorkflowQuestion;

describe('choiceStyle', () => {
  it('makes the non-fallback of two choices the main action', () => {
    const q = question(['Continue', 'Skip this page'], 'Skip this page');
    expect(choiceStyle(q, 'Continue')).toBe('primary');
    expect(choiceStyle(q, 'Skip this page')).toBe('ghost');
  });

  it('leaves other questions even', () => {
    expect(choiceStyle(question(['A', 'B'], null), 'A')).toBe('');
    expect(choiceStyle(question(['A', 'B', 'C'], 'B'), 'A')).toBe('');
    expect(choiceStyle(question(['A', 'B'], 'Z'), 'A')).toBe('');
  });
});
