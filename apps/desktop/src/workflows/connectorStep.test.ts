import { describe, expect, it } from 'vitest';
import type { WorkflowReview, WorkflowStep } from '../ipc/contracts';
import { describeStep } from './describeStep';
import { newStep, stepOutputs, stepTypesFor } from './editorModel';
import { permissionText, reviewText } from './permissionText';
import { connectorStepSummary } from './stepSummary';

const t = (id: string, values?: Record<string, unknown>) => `${id.split('.').pop()} ${JSON.stringify(values)}`;

const step: WorkflowStep = {
  id: 'issues',
  type: 'connector_tool',
  connector: 'gh',
  tool: 'list_issues',
  arguments: { repo: '{{inputs.repo}}' },
};

describe('connector step', () => {
  it('starts empty and is offered at the top level and in a loop', () => {
    expect(newStep('connector_tool', new Set())).toMatchObject({ id: 'connector', connector: '', tool: '', arguments: {} });
    expect(stepTypesFor(false)).toContain('connector_tool');
    expect(stepTypesFor(true)).toContain('connector_tool');
    expect(stepOutputs(step).map((o) => o.field)).toEqual(['text', 'data']);
  });

  it('describes itself with the connector name, or its id', () => {
    expect(describeStep(step, t, {}, { gh: 'Issues' })).toBe('connectorTool {"tool":"list_issues","connector":"Issues"}');
    expect(describeStep(step, t)).toBe('connectorTool {"tool":"list_issues","connector":"gh"}');
    expect(describeStep({ ...step, connector: '', tool: '' } as WorkflowStep, t)).toBe('connectorToolEmpty undefined');
  });

  it('names the permission and the review', () => {
    const p = { kind: 'connector', connectorId: 'gh', name: 'Issues', tool: 'list_issues', label: null, local: null } as const;
    expect(permissionText(p, t)).toBe('connector {"tool":"list_issues","connector":"Issues"}');
    const review = { runId: 'r', permission: p, url: null } as unknown as WorkflowReview;
    expect(reviewText(review, t)).toBe('connector {"tool":"list_issues","connector":"Issues"}');
  });

  it('summarizes a run row by first line of text, or the item count', () => {
    const base = { tool: 'list_issues', isError: false, connector: { id: 'gh', name: 'Issues' } };
    expect(connectorStepSummary({ output: { ...base, text: '\n  3 open issues\nmore', data: null } }, t)).toBe('3 open issues');
    expect(connectorStepSummary({ output: { ...base, text: '[1,2]', data: [1, 2] } }, t)).toBe('connectorItems {"count":2}');
    expect(connectorStepSummary({ output: { ...base, text: 'x'.repeat(200), data: null } }, t)).toHaveLength(80);
    expect(connectorStepSummary({ output: { text: 'plain' } }, t)).toBeNull();
    expect(connectorStepSummary({ output: null }, t)).toBeNull();
  });
});
