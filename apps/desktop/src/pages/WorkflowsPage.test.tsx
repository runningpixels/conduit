import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { WorkflowRecord, WorkflowRunDetail, WorkflowSummary } from '../ipc/contracts';
import { STARTER_WORKFLOWS } from '../workflows/starters';
import { WorkflowsPage } from './WorkflowsPage';

const ipc = vi.hoisted(() => ({
  listWorkflows: vi.fn(),
  getWorkflow: vi.fn(),
  createWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  runWorkflow: vi.fn(),
  listWorkflowRuns: vi.fn(),
  getWorkflowRun: vi.fn(),
}));

vi.mock('../ipc/client', () => ipc);

const briefing = STARTER_WORKFLOWS.find((s) => s.id === 'briefing')!;

const record: WorkflowRecord = {
  id: 'w1',
  name: 'Morning briefing',
  description: 'Two sites, one briefing',
  definition: briefing.definition,
  version: 1,
  conversationId: null,
  createdAt: '2026-09-28T08:00:00Z',
  updatedAt: '2026-09-28T08:00:00Z',
};

const summary: WorkflowSummary = {
  id: 'w1',
  name: 'Morning briefing',
  description: null,
  version: 1,
  updatedAt: '2026-09-28T08:00:00Z',
  lastRunStatus: null,
  lastRunAt: null,
};

const finishedRun: WorkflowRunDetail = {
  run: {
    id: 'r1',
    workflowId: 'w1',
    version: 1,
    trigger: 'manual',
    status: 'failed',
    error: 'Step "fetch" failed: the site answered 404',
    startedAt: '2026-09-28T08:00:00Z',
    finishedAt: '2026-09-28T08:00:02Z',
  },
  steps: [
    {
      id: 's1',
      runId: 'r1',
      stepId: 'fetch',
      iteration: null,
      status: 'failed',
      input: { type: 'fetch_page', urls: ['https://example.com'] },
      output: null,
      error: 'the site answered 404',
      startedAt: '2026-09-28T08:00:00Z',
      finishedAt: '2026-09-28T08:00:01Z',
    },
    {
      id: 's2',
      runId: 'r1',
      stepId: 'summary',
      iteration: 0,
      status: 'completed',
      input: { type: 'summarize' },
      output: { text: 'Three stories' },
      error: null,
      startedAt: '2026-09-28T08:00:01Z',
      finishedAt: '2026-09-28T08:00:02Z',
    },
  ],
};

describe('WorkflowsPage', () => {
  beforeEach(() => {
    for (const fn of Object.values(ipc)) fn.mockReset();
    ipc.listWorkflows.mockResolvedValue([summary]);
    ipc.getWorkflow.mockResolvedValue(record);
    ipc.listWorkflowRuns.mockResolvedValue([]);
    ipc.createWorkflow.mockResolvedValue(record);
    ipc.updateWorkflow.mockImplementation(async (_id, name, description, definition) => ({
      ...record,
      name,
      description,
      definition,
      version: 2,
    }));
    ipc.deleteWorkflow.mockResolvedValue(undefined);
    ipc.runWorkflow.mockResolvedValue(finishedRun);
    ipc.getWorkflowRun.mockResolvedValue(finishedRun);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts from a ready-made workflow when there are none', async () => {
    ipc.listWorkflows.mockResolvedValueOnce([]).mockResolvedValue([summary]);
    const onStatus = vi.fn();
    render(<WorkflowsPage onStatus={onStatus} />);
    const empty = (await screen.findByText('No workflows yet')).closest('.page-empty') as HTMLElement;
    const card = within(empty).getByText('Morning briefing').closest('li') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Use this' }));
    await waitFor(() =>
      expect(ipc.createWorkflow).toHaveBeenCalledWith('Morning briefing', expect.any(String), briefing.definition),
    );
    expect(onStatus).toHaveBeenCalledWith('Created Morning briefing');
    expect(await screen.findByRole('heading', { name: 'Morning briefing' })).toBeInTheDocument();
  });

  it('shows the steps in words and runs with the inputs as edited', async () => {
    const onStatus = vi.fn();
    render(<WorkflowsPage onStatus={onStatus} />);
    const steps = await screen.findByRole('region', { name: 'Steps' });
    expect(within(steps).getByText('Fetch 2 pages: [First site], [Second site]')).toBeInTheDocument();
    expect(within(steps).getByText('For each item in steps.fetch.pages:')).toBeInTheDocument();
    expect(within(steps).getByText(/^Ask the model: “List the three most important/)).toBeInTheDocument();
    expect(within(steps).getByText('keeps going if this fails')).toBeInTheDocument();
    expect(within(steps).getByText('Save as a document: “Morning briefing”')).toBeInTheDocument();

    const first = screen.getByRole('textbox', { name: 'First site' });
    expect(first).toHaveValue('https://news.ycombinator.com');
    fireEvent.change(first, { target: { value: 'https://example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() =>
      expect(ipc.runWorkflow).toHaveBeenCalledWith('w1', {
        site_one: 'https://example.com',
        site_two: 'https://www.theverge.com',
      }),
    );

    // The run it just did opens, with each step and the error that ended it.
    const detail = await screen.findByRole('region', { name: 'What this run did' });
    expect(within(detail).getByText('Step "fetch" failed: the site answered 404')).toBeInTheDocument();
    expect(within(detail).getByText('fetch')).toBeInTheDocument();
    expect(within(detail).getByText('summary #1')).toBeInTheDocument();
    expect(within(detail).getByText(/"text": "Three stories"/)).toBeInTheDocument();
    expect(onStatus).toHaveBeenCalledWith('Morning briefing failed. Open the run to see which step.');
  });

  it('opens an earlier run from the history', async () => {
    ipc.listWorkflowRuns.mockResolvedValue([finishedRun.run]);
    render(<WorkflowsPage onStatus={vi.fn()} />);
    const runs = await screen.findByRole('region', { name: 'Recent runs' });
    fireEvent.click(within(runs).getByRole('button', { name: /Failed/ }));
    await waitFor(() => expect(ipc.getWorkflowRun).toHaveBeenCalledWith('r1'));
    expect(await screen.findByRole('region', { name: 'What this run did' })).toBeInTheDocument();
  });

  it('edits the definition as JSON and shows what is wrong with it', async () => {
    render(<WorkflowsPage onStatus={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox', { name: 'Steps (JSON)' });

    fireEvent.change(box, { target: { value: '{ not json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/That isn't valid JSON/);
    expect(ipc.updateWorkflow).not.toHaveBeenCalled();

    ipc.updateWorkflow.mockRejectedValueOnce(new Error('Step "a" reads steps.b.text, which doesn\'t exist at that point.'));
    fireEvent.change(box, { target: { value: '{"steps":[{"id":"a","type":"template","template":"{{steps.b.text}}"}]}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('reads steps.b.text');

    const good = { steps: [{ id: 'a', type: 'template', template: 'hello' }] };
    fireEvent.change(box, { target: { value: JSON.stringify(good) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ipc.updateWorkflow).toHaveBeenLastCalledWith('w1', 'Morning briefing', 'Two sites, one briefing', good));
    expect(await screen.findByText('Put the text together')).toBeInTheDocument();
  });

  it('deletes only after confirmation', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<WorkflowsPage onStatus={vi.fn()} />);
    await screen.findByRole('heading', { name: 'Morning briefing' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(ipc.deleteWorkflow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(ipc.deleteWorkflow).toHaveBeenCalledWith('w1'));
    expect(confirmSpy).toHaveBeenCalledTimes(2);
  });
});
