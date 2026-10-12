import { beforeAll, describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { WorkflowDefinition, WorkflowRunDetail, WorkflowRunStep } from '../../ipc/contracts';
import { STARTER_WORKFLOWS } from '../starters';
import { WorkflowCanvas } from './WorkflowCanvas';
import { installReactFlowStubs } from '../../test/reactFlowStubs';

beforeAll(installReactFlowStubs);

const briefing = STARTER_WORKFLOWS.find((s) => s.id === 'briefing')!.definition as WorkflowDefinition;

function row(stepId: string, status: WorkflowRunStep['status'], iteration: number | null = null): WorkflowRunStep {
  return { id: `${stepId}-${iteration}`, runId: 'r', stepId, iteration, status, input: { url: 'https://example.com' }, output: { text: 'hello' }, error: null, startedAt: '2026-10-12T08:00:00Z', finishedAt: '2026-10-12T08:00:02Z' } as WorkflowRunStep;
}

const node = (id: string) => document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;

describe('WorkflowCanvas', () => {
  it('draws the start node, each step, and a frame for the loop', () => {
    render(<WorkflowCanvas definition={briefing} />);
    expect(within(node('__start')).getByText('Start')).toBeTruthy();
    expect(within(node('fetch')).getByText('Fetch pages')).toBeTruthy();
    expect(within(node('read')).getByText('Repeat for each')).toBeTruthy();
    expect(within(node('article')).getByText('Fetch pages')).toBeTruthy();
    expect(within(node('save')).getByText('Save a document')).toBeTruthy();
  });

  it('shows what a selected step uses, and asks for a run to show more', () => {
    render(<WorkflowCanvas definition={briefing} />);
    expect(screen.getByText(/Select a step to see what it does/)).toBeTruthy();
    fireEvent.click(node('write'));
    const inspector = screen.getByRole('complementary', { name: 'Step details' });
    expect(within(inspector).getByText('Uses')).toBeTruthy();
    expect(within(inspector).getByText('read (items)')).toBeTruthy();
    expect(within(inspector).getByText('Used by')).toBeTruthy();
    expect(within(inspector).getByText('save (text)')).toBeTruthy();
    expect(within(inspector).getByText("Open a run to see this step's input and output.")).toBeTruthy();
  });

  it('marks each step with its status in a run, and counts loop items', () => {
    const detail: WorkflowRunDetail = {
      run: { id: 'r', workflowId: 'w', status: 'running' } as WorkflowRunDetail['run'],
      steps: [row('fetch', 'completed'), row('pick', 'completed'), row('read', 'running'), row('article', 'completed', 0), row('article', 'running', 1)],
    };
    render(<WorkflowCanvas definition={briefing} run={detail} />);
    expect(within(node('fetch')).getByText('Finished')).toBeTruthy();
    expect(within(node('article')).getByText('Running…')).toBeTruthy();
    expect(within(node('article')).getByText('2 items so far')).toBeTruthy();
    expect(node('write').querySelector('[data-status="idle"]')).not.toBeNull();

    fireEvent.click(node('article'));
    const inspector = screen.getByRole('complementary', { name: 'Step details' });
    expect(within(inspector).getByText('Item 1')).toBeTruthy();
    expect(within(inspector).getByText('Item 2')).toBeTruthy();
  });

  it('shows the step a paused run waits at', () => {
    const detail: WorkflowRunDetail = { run: { id: 'r', workflowId: 'w', status: 'paused' } as WorkflowRunDetail['run'], steps: [row('fetch', 'completed')] };
    render(<WorkflowCanvas definition={briefing} run={detail} waitingStepId="pick" />);
    expect(within(node('pick')).getByText('Waiting for you')).toBeTruthy();
  });

  it('marks the steps the checker has problems with', () => {
    render(<WorkflowCanvas definition={briefing} problems={['Step "gist": the prompt is empty.']} />);
    expect(node('gist').querySelector('.has-problem')).not.toBeNull();
    expect(node('fetch').querySelector('.has-problem')).toBeNull();
  });

  it('dims a step a run did not take and says so, and labels the arms of a branch', () => {
    const def: WorkflowDefinition = {
      steps: [
        { id: 'if', type: 'branch', value: '{{inputs.x}}', is: 'empty' },
        { id: 'yes', type: 'template', template: 'y', after: ['if.yes'] },
        { id: 'no', type: 'template', template: 'n', after: ['if.no'] },
      ],
    };
    const detail: WorkflowRunDetail = {
      run: { id: 'r', workflowId: 'w', status: 'completed' } as WorkflowRunDetail['run'],
      steps: [row('if', 'completed'), row('yes', 'completed'), row('no', 'not_taken')],
    };
    render(<WorkflowCanvas definition={def} run={detail} />);
    expect(within(node('no')).getByText('Not taken')).toBeTruthy();
    expect(node('no').querySelector('[data-status="not_taken"]')).not.toBeNull();
    expect(within(node('if')).getByText('If… otherwise')).toBeTruthy();
  });
});
