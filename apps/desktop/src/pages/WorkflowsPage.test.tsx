import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  validateWorkflow: vi.fn(),
  getWorkflowSchedule: vi.fn(),
  setWorkflowSchedule: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getStartAtLogin: vi.fn(),
  setStartAtLogin: vi.fn(),
  stopWorkflowRun: vi.fn(),
  getWorkflowPermissions: vi.fn(),
  approveWorkflowPermissions: vi.fn(),
  listWorkflowReviews: vi.fn(),
  answerWorkflowReview: vi.fn(),
  rerunWorkflowFrom: vi.fn(),
  listWorkflowQuestions: vi.fn(),
  answerWorkflowQuestion: vi.fn(),
  listProviderDescriptors: vi.fn(),
  draftWorkflow: vi.fn(),
  draftWorkflowFromChat: vi.fn(),
  listDecks: vi.fn(),
  listDrafts: vi.fn(),
  restoreDeckSnapshot: vi.fn(),
  restoreDraftSnapshot: vi.fn(),
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
  nextRunAt: null,
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
    ipc.getSettings.mockRejectedValue(new Error('not in tests'));
    ipc.getStartAtLogin.mockRejectedValue(new Error('not in tests'));
    ipc.getWorkflowPermissions.mockResolvedValue({ required: [], missing: [], approvedAt: null });
    ipc.listWorkflowReviews.mockResolvedValue([]);
    ipc.listWorkflowQuestions.mockResolvedValue([]);
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
    ipc.validateWorkflow.mockResolvedValue([]);
    ipc.getWorkflowSchedule.mockResolvedValue(null);
    ipc.listProviderDescriptors.mockResolvedValue([{ id: 'openrouter', displayName: 'OpenRouter' }]);
    ipc.listDecks.mockResolvedValue([]);
    ipc.listDrafts.mockResolvedValue([]);
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

  it('opens a starter that changes a deck in the editor, flagged, instead of saving it empty', async () => {
    ipc.listWorkflows.mockResolvedValue([]);
    render(<WorkflowsPage onStatus={vi.fn()} />);
    const empty = (await screen.findByText('No workflows yet')).closest('.page-empty') as HTMLElement;
    const card = within(empty).getByText('Weekly numbers deck').closest('li') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: 'Use this' }));
    expect(await screen.findByText('Choose the deck this step updates.')).toBeInTheDocument();
    expect(ipc.createWorkflow).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('Weekly numbers deck')).toBeInTheDocument();
    // The backend says what it thinks of the empty deck, as for any other problem.
    await waitFor(() => expect(ipc.validateWorkflow).toHaveBeenCalled());
    const sent = ipc.validateWorkflow.mock.calls.at(-1)?.[0] as { steps: { type: string; deck?: string }[] };
    expect(sent.steps.at(-1)).toMatchObject({ type: 'edit_deck', deck: '' });
  });

  describe('describe a workflow', () => {
    const drafted = {
      name: 'Deck refresh',
      description: 'Updates the numbers',
      definition: STARTER_WORKFLOWS.find((s) => s.id === 'weekly-numbers-deck')!.definition,
      problems: ['Choose the deck this step updates.'],
      attempts: 2,
      notes: ['Pick the deck to update', 'Choose the CSV address'],
    };

    it('opens the draft in the editor, unsaved, with notes and problems', async () => {
      ipc.draftWorkflow.mockResolvedValue(drafted);
      ipc.validateWorkflow.mockResolvedValue(drafted.problems);
      render(<WorkflowsPage onStatus={vi.fn()} startNew />);
      const box = await screen.findByLabelText('Describe a workflow');
      const button = screen.getByRole('button', { name: 'Draft it' });
      expect(button).toBeDisabled();
      fireEvent.change(box, { target: { value: ' update my deck from a CSV ' } });
      fireEvent.click(button);
      expect(ipc.draftWorkflow).toHaveBeenCalledWith('update my deck from a CSV');
      expect(await screen.findByDisplayValue('Deck refresh')).toBeInTheDocument();
      const notes = screen.getByRole('group', { name: 'Still to fill in before you save' });
      expect(within(notes).getAllByRole('checkbox')).toHaveLength(2);
      expect(within(notes).getByText('Pick the deck to update')).toBeInTheDocument();
      expect(screen.getAllByText('Choose the deck this step updates.').length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      // Never saved on its own.
      expect(ipc.createWorkflow).not.toHaveBeenCalled();
    });

    it('Cancel ignores the answer and leaves the page usable', async () => {
      let resolve!: (value: typeof drafted) => void;
      ipc.draftWorkflow.mockReturnValue(new Promise((r) => (resolve = r)));
      render(<WorkflowsPage onStatus={vi.fn()} startNew />);
      fireEvent.change(await screen.findByLabelText('Describe a workflow'), { target: { value: 'anything' } });
      fireEvent.click(screen.getByRole('button', { name: 'Draft it' }));
      expect(await screen.findByText('Drafting your workflow…')).toBeInTheDocument();
      fireEvent.click(
        within(screen.getByText('Drafting your workflow…').parentElement!).getByRole('button', { name: 'Cancel' }),
      );
      expect(screen.queryByText('Drafting your workflow…')).not.toBeInTheDocument();
      await act(async () => {
        resolve(drafted);
      });
      expect(screen.queryByDisplayValue('Deck refresh')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Draft it' })).toBeInTheDocument();
    });

    it('shows a failure in place and keeps the text', async () => {
      ipc.draftWorkflow.mockRejectedValue({ message: "The model didn't return a workflow." });
      render(<WorkflowsPage onStatus={vi.fn()} startNew />);
      fireEvent.change(await screen.findByLabelText('Describe a workflow'), { target: { value: 'something' } });
      fireEvent.click(screen.getByRole('button', { name: 'Draft it' }));
      expect(await screen.findByRole('alert')).toHaveTextContent("The model didn't return a workflow.");
      expect(screen.getByLabelText('Describe a workflow')).toHaveValue('something');
    });

    it('drafts from a chat when asked to, and from a description (Home) once per request', async () => {
      ipc.draftWorkflowFromChat.mockResolvedValue(drafted);
      const { unmount } = render(
        <WorkflowsPage onStatus={vi.fn()} draftRequest={{ nonce: 1, conversationId: 'conv-1' }} />,
      );
      expect(await screen.findByDisplayValue('Deck refresh')).toBeInTheDocument();
      expect(ipc.draftWorkflowFromChat).toHaveBeenCalledTimes(1);
      expect(ipc.draftWorkflowFromChat).toHaveBeenCalledWith('conv-1', undefined);
      unmount();
      ipc.draftWorkflow.mockResolvedValue(drafted);
      render(<WorkflowsPage onStatus={vi.fn()} draftRequest={{ nonce: 2, description: 'every monday, fetch a page' }} />);
      expect(await screen.findByDisplayValue('Deck refresh')).toBeInTheDocument();
      expect(ipc.draftWorkflow).toHaveBeenCalledWith('every monday, fetch a page');
    });
  });

  it('reads a deck or draft update on the collapsed row and opens the document', async () => {
    const deckStep = {
      ...finishedRun.steps[1],
      id: 's5',
      stepId: 'deck',
      iteration: null,
      status: 'completed' as const,
      error: null,
      output: {
        deckId: 'deck-1',
        title: 'Q3 numbers',
        changed: ['s1', 's3'],
        skippedPinned: [],
        reply: 'Updated the chart.',
        layoutChecked: false,
        model: { provider: 'openrouter', model: 'deepseek/flash' },
      },
    };
    const draftStep = {
      ...deckStep,
      id: 's6',
      stepId: 'report',
      output: { draftId: 'draft-1', title: 'Report', changed: [], skippedPinned: [], reply: 'Nothing to add.' },
    };
    const done: WorkflowRunDetail = {
      run: { ...finishedRun.run, status: 'completed', error: null },
      steps: [deckStep, draftStep],
    };
    ipc.listWorkflowRuns.mockResolvedValue([done.run]);
    ipc.getWorkflowRun.mockResolvedValue(done);
    const onOpenDeck = vi.fn();
    const onOpenDraft = vi.fn();
    render(<WorkflowsPage onStatus={vi.fn()} onOpenDeck={onOpenDeck} onOpenDraft={onOpenDraft} />);
    const runs = await screen.findByRole('region', { name: 'Recent runs' });
    fireEvent.click(within(runs).getByRole('button', { name: /Finished/ }));
    const detail = await screen.findByRole('region', { name: 'What this run did' });
    expect(detail).toHaveTextContent('Changed 2 slides');
    expect(detail).toHaveTextContent('Layout is checked when you next open the deck.');
    expect(detail).toHaveTextContent('No changes');
    expect(detail).toHaveTextContent('deepseek/flash');
    fireEvent.click(within(detail).getByRole('button', { name: 'Open deck' }));
    expect(onOpenDeck).toHaveBeenCalledWith('deck-1');
    fireEvent.click(within(detail).getByRole('button', { name: 'Open draft' }));
    expect(onOpenDraft).toHaveBeenCalledWith('draft-1');
    // "No changes" carries no layout note: only the deck row has one.
    expect(screen.getAllByText('Layout is checked when you next open the deck.')).toHaveLength(1);
  });

  it('undoes a deck update after asking, once, and says what happened', async () => {
    const deckStep = {
      ...finishedRun.steps[1],
      id: 's5',
      stepId: 'deck',
      iteration: null,
      status: 'completed' as const,
      error: null,
      output: { deckId: 'deck-9', title: 'Q3 numbers', changed: ['s1'], skippedPinned: [], reply: 'Done.', beforeSnapshotId: 'snap-before' },
    };
    const done: WorkflowRunDetail = { run: { ...finishedRun.run, status: 'completed', error: null }, steps: [deckStep] };
    ipc.listWorkflowRuns.mockResolvedValue([done.run]);
    ipc.getWorkflowRun.mockResolvedValue(done);
    ipc.restoreDeckSnapshot.mockResolvedValue({ id: 'deck-9' });
    const onRestoreDocument = vi.fn().mockResolvedValue(undefined);
    render(<WorkflowsPage onStatus={vi.fn()} onRestoreDocument={onRestoreDocument} />);
    const runs = await screen.findByRole('region', { name: 'Recent runs' });
    fireEvent.click(within(runs).getByRole('button', { name: /Finished/ }));
    const detail = await screen.findByRole('region', { name: 'What this run did' });
    fireEvent.click(within(detail).getByRole('button', { name: 'Undo this update' }));
    // Nothing happens until it is confirmed.
    const confirm = within(detail).getByRole('group', { name: 'Put the deck back the way it was before this update?' });
    expect(onRestoreDocument).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(onRestoreDocument).not.toHaveBeenCalled();
    fireEvent.click(within(detail).getByRole('button', { name: 'Undo this update' }));
    fireEvent.click(within(detail).getByRole('button', { name: 'Undo update' }));
    await waitFor(() => expect(onRestoreDocument).toHaveBeenCalledWith('deck', 'deck-9', 'snap-before'));
    const used = await within(detail).findByRole('button', { name: 'Update undone' });
    expect(used).toBeDisabled();
  });

  it('restores the entry directly when the page is not wired to the shell, and reports a failure', async () => {
    const draftStep = {
      ...finishedRun.steps[1],
      id: 's6',
      stepId: 'report',
      iteration: null,
      status: 'completed' as const,
      error: null,
      output: { draftId: 'draft-7', title: 'Report', changed: ['b1'], changedSections: ['This week'], skippedPinned: [], reply: 'Added.', beforeSnapshotId: 'snap-d' },
    };
    const done: WorkflowRunDetail = { run: { ...finishedRun.run, status: 'completed', error: null }, steps: [draftStep] };
    ipc.listWorkflowRuns.mockResolvedValue([done.run]);
    ipc.getWorkflowRun.mockResolvedValue(done);
    ipc.restoreDraftSnapshot.mockRejectedValueOnce(new Error('Version not found'));
    render(<WorkflowsPage onStatus={vi.fn()} />);
    const runs = await screen.findByRole('region', { name: 'Recent runs' });
    fireEvent.click(within(runs).getByRole('button', { name: /Finished/ }));
    const detail = await screen.findByRole('region', { name: 'What this run did' });
    expect(detail).toHaveTextContent('Changed 1 section');
    fireEvent.click(within(detail).getByRole('button', { name: 'Undo this update' }));
    fireEvent.click(within(detail).getByRole('button', { name: 'Undo update' }));
    expect(await within(detail).findByRole('alert')).toHaveTextContent("Couldn't undo the update: Version not found");
    expect(ipc.restoreDraftSnapshot).toHaveBeenCalledWith('draft-7', 'snap-d');
    // Still available after a failure.
    fireEvent.click(within(detail).getByRole('button', { name: 'Undo update' }));
    await waitFor(() => expect(ipc.restoreDraftSnapshot).toHaveBeenCalledTimes(2));
  });

  it('offers no undo for runs that did not record the earlier version', async () => {
    const deckStep = {
      ...finishedRun.steps[1],
      id: 's5',
      stepId: 'deck',
      iteration: null,
      status: 'completed' as const,
      error: null,
      output: { deckId: 'deck-1', title: 'Old run', changed: ['s1'], skippedPinned: [], reply: 'Done.' },
    };
    const done: WorkflowRunDetail = { run: { ...finishedRun.run, status: 'completed', error: null }, steps: [deckStep] };
    ipc.listWorkflowRuns.mockResolvedValue([done.run]);
    ipc.getWorkflowRun.mockResolvedValue(done);
    render(<WorkflowsPage onStatus={vi.fn()} />);
    const runs = await screen.findByRole('region', { name: 'Recent runs' });
    fireEvent.click(within(runs).getByRole('button', { name: /Finished/ }));
    const detail = await screen.findByRole('region', { name: 'What this run did' });
    expect(detail).toHaveTextContent('Changed 1 slide');
    expect(within(detail).queryByRole('button', { name: 'Undo this update' })).toBeNull();
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
    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ brief: 'Morning briefing failed. Open the run to see which step.', kind: 'error', dismissMs: 10_000 }),
    );
  });

  it('stacks the describe box above the starter cards in the empty state', async () => {
    ipc.listWorkflows.mockResolvedValueOnce([]).mockResolvedValue([summary]);
    render(<WorkflowsPage onStatus={vi.fn()} />);
    const empty = (await screen.findByText('No workflows yet')).closest('.page-empty') as HTMLElement;
    const action = empty.querySelector('.page-empty-action') as HTMLElement;
    expect(action).toHaveClass('wf-empty-action');
    const describeBox = action.querySelector('.wf-describe') as HTMLElement;
    const cards = action.querySelector('.wf-starters') as HTMLElement;
    expect(describeBox.compareDocumentPosition(cards) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens a document the run saved', async () => {
    const withSave: WorkflowRunDetail = {
      run: { ...finishedRun.run, status: 'completed', error: null },
      steps: [
        {
          ...finishedRun.steps[1],
          id: 's3',
          stepId: 'save',
          iteration: null,
          output: { artifactId: 'a1', title: 'Morning briefing', conversationId: 'c1' },
        },
      ],
    };
    ipc.runWorkflow.mockResolvedValueOnce(withSave);
    const onOpenDocument = vi.fn();
    render(<WorkflowsPage onStatus={vi.fn()} onOpenDocument={onOpenDocument} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    const detail = await screen.findByRole('region', { name: 'What this run did' });
    fireEvent.click(within(detail).getByRole('button', { name: 'Open “Morning briefing”' }));
    expect(onOpenDocument).toHaveBeenCalledWith('c1', 'a1');
  });

  it('stops a run in progress, and says it stopped', async () => {
    let finish: (detail: WorkflowRunDetail) => void = () => {};
    ipc.runWorkflow.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    ipc.stopWorkflowRun.mockResolvedValue(true);
    const onStatus = vi.fn();
    render(<WorkflowsPage onStatus={onStatus} />);
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Run now' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(ipc.stopWorkflowRun).toHaveBeenCalledWith('w1'));
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();

    finish({
      ...finishedRun,
      run: { ...finishedRun.run, status: 'stopped', error: 'Stopped before it finished.' },
    });
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ brief: 'Morning briefing stopped', dismissMs: 10_000 })));
    expect(screen.queryByRole('button', { name: /^Stop/ })).not.toBeInTheDocument();
    const detail = await screen.findByRole('region', { name: 'What this run did' });
    expect(within(detail).getByText(/^Stopped/)).toBeInTheDocument();
    expect(within(detail).queryByText('Stopped before it finished.')).not.toBeInTheDocument();
  });

  it('shows what a paused scheduled run waits for, and answers it', async () => {
    const review = {
      runId: 'r9',
      workflowId: 'w1',
      workflowName: 'Morning briefing',
      stepId: 'fetch',
      permission: { kind: 'host', host: 'bbc.com', label: null, local: null },
      url: 'https://bbc.com/news',
      requestedAt: '2026-09-29T06:00:00.000Z',
      expiresAt: '2026-09-30T06:00:00.000Z',
    } as const;
    ipc.listWorkflowReviews.mockResolvedValueOnce([review]).mockResolvedValue([]);
    ipc.answerWorkflowReview.mockResolvedValue(true);
    render(<WorkflowsPage onStatus={vi.fn()} />);
    const panel = await screen.findByRole('group', { name: 'Waiting for you' });
    expect(panel).toHaveTextContent('It wants to read pages on bbc.com.');
    expect(panel).toHaveTextContent(/If nobody answers by /);
    fireEvent.click(within(panel).getByRole('button', { name: 'Always allow' }));
    await waitFor(() => expect(ipc.answerWorkflowReview).toHaveBeenCalledWith('r9', 'alwaysAllow'));
    expect(screen.queryByRole('group', { name: 'Waiting for you' })).not.toBeInTheDocument();
  });

  it('reruns an earlier run from a top-level step', async () => {
    ipc.listWorkflowRuns.mockResolvedValue([finishedRun.run]);
    const rerun: WorkflowRunDetail = {
      run: { ...finishedRun.run, id: 'r2', trigger: 'rerun', status: 'completed', error: null },
      steps: [{ ...finishedRun.steps[0], id: 's9', runId: 'r2', status: 'reused', error: null, output: { text: 'x' } }],
    };
    ipc.rerunWorkflowFrom.mockResolvedValue(rerun);
    const onStatus = vi.fn();
    render(<WorkflowsPage onStatus={onStatus} />);
    const runs = await screen.findByRole('region', { name: 'Recent runs' });
    fireEvent.click(within(runs).getByRole('button', { name: /Failed/ }));
    const detail = await screen.findByRole('region', { name: 'What this run did' });
    // Offered on top-level steps only, not on a loop's iterations.
    const buttons = within(detail).getAllByRole('button', { name: /^Rerun from step / });
    expect(buttons).toHaveLength(1);
    fireEvent.click(within(detail).getByRole('button', { name: 'Rerun from step fetch, reusing the steps before it' }));
    await waitFor(() => expect(ipc.rerunWorkflowFrom).toHaveBeenCalledWith('r1', 'fetch'));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ brief: 'Morning briefing finished', dismissMs: 10_000 })));
    const after = await screen.findByRole('region', { name: 'What this run did' });
    expect(within(after).getByText('Reused')).toBeInTheDocument();
  });

  it('shows the model a step used, and why it was not the chosen one', async () => {
    const done: WorkflowRunDetail = {
      run: { ...finishedRun.run, status: 'completed', error: null },
      steps: [
        {
          ...finishedRun.steps[1],
          iteration: null,
          output: {
            text: 'Three stories',
            model: { provider: 'openrouter', model: 'deepseek/flash' },
            modelNote: "Anthropic isn't set up any more, so the chat model was used.",
          },
        },
        { ...finishedRun.steps[0], id: 's3', status: 'completed', error: null, output: { text: 'page' } },
      ],
    };
    ipc.listWorkflowRuns.mockResolvedValue([done.run]);
    ipc.getWorkflowRun.mockResolvedValue(done);
    render(<WorkflowsPage onStatus={vi.fn()} />);
    const runs = await screen.findByRole('region', { name: 'Recent runs' });
    fireEvent.click(within(runs).getByRole('button', { name: /Finished/ }));
    const detail = await screen.findByRole('region', { name: 'What this run did' });
    await waitFor(() => expect(detail).toHaveTextContent('Used deepseek/flash (OpenRouter).'));
    expect(detail).toHaveTextContent("Anthropic isn't set up any more, so the chat model was used.");
    // Steps that recorded no model show no model line.
    expect(detail.querySelectorAll('.wf-model-used')).toHaveLength(1);
    // The model also shows on the collapsed step row.
    const chips = detail.querySelectorAll('.wf-step-model');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent('deepseek/flash');
  });

  it('calls a step that was allowed to fail "Skipped", not "Failed"', async () => {
    const done: WorkflowRunDetail = {
      run: { ...finishedRun.run, status: 'completed', error: null },
      steps: [{ ...finishedRun.steps[0], status: 'skipped', error: 'There was nothing to summarize: the input came out empty.' }],
    };
    ipc.listWorkflowRuns.mockResolvedValue([done.run]);
    ipc.getWorkflowRun.mockResolvedValue(done);
    render(<WorkflowsPage onStatus={vi.fn()} />);
    const runs = await screen.findByRole('region', { name: 'Recent runs' });
    fireEvent.click(within(runs).getByRole('button', { name: /Finished/ }));
    const detail = await screen.findByRole('region', { name: 'What this run did' });
    expect(within(detail).getByText('Skipped')).toBeInTheDocument();
    expect(within(detail).queryByText('Failed')).not.toBeInTheDocument();
    expect(detail).toHaveTextContent('There was nothing to summarize');
  });

  it('reads "Nothing new" in the run list and detail for a run a condition stopped', async () => {
    const done: WorkflowRunDetail = {
      run: { ...finishedRun.run, status: 'completed', error: null, outcome: 'nothing_new', outcomeStep: 'check' },
      steps: [
        {
          ...finishedRun.steps[0],
          stepId: 'check',
          status: 'completed',
          error: null,
          output: { passed: false, is: 'changed', text: 'Same as the last run.' },
        },
      ],
    };
    ipc.listWorkflowRuns.mockResolvedValue([done.run]);
    ipc.getWorkflowRun.mockResolvedValue(done);
    render(<WorkflowsPage onStatus={vi.fn()} />);
    const runs = await screen.findByRole('region', { name: 'Recent runs' });
    fireEvent.click(within(runs).getByRole('button', { name: /Nothing new/ }));
    const detail = await screen.findByRole('region', { name: 'What this run did' });
    expect(detail).toHaveTextContent('Nothing new — stopped at check');
    expect(detail).toHaveTextContent('Same as the last run.');
  });

  it('finds the stopping condition from the steps when the run has no outcome field', async () => {
    const done: WorkflowRunDetail = {
      run: { ...finishedRun.run, status: 'completed', error: null },
      steps: [
        { ...finishedRun.steps[0], stepId: 'check', status: 'completed', error: null, output: { passed: false, text: 'x' } },
      ],
    };
    ipc.listWorkflowRuns.mockResolvedValue([done.run]);
    ipc.getWorkflowRun.mockResolvedValue(done);
    render(<WorkflowsPage onStatus={vi.fn()} />);
    const runs = await screen.findByRole('region', { name: 'Recent runs' });
    fireEvent.click(within(runs).getByRole('button', { name: /Finished/ }));
    const detail = await screen.findByRole('region', { name: 'What this run did' });
    expect(detail).toHaveTextContent('Nothing new — stopped at check');
  });

  it('answers a question with a choice, or with typed text', async () => {
    const base = {
      runId: 'r7',
      workflowId: 'w1',
      workflowName: 'Morning briefing',
      stepId: 'ask',
      requestedAt: '2026-09-29T06:00:00.000Z',
      expiresAt: '2026-09-30T06:00:00.000Z',
    };
    ipc.listWorkflowQuestions
      .mockResolvedValueOnce([{ ...base, question: 'Which topic?', choices: ['Rust', 'Go'], default: 'Rust' }])
      .mockResolvedValue([]);
    ipc.answerWorkflowQuestion.mockResolvedValue(true);
    const { unmount } = render(<WorkflowsPage onStatus={vi.fn()} />);
    const panel = await screen.findByRole('group', { name: 'Waiting for you' });
    expect(panel).toHaveTextContent('Which topic?');
    expect(panel).toHaveTextContent(/the answer is “Rust”/);
    fireEvent.click(within(panel).getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(ipc.answerWorkflowQuestion).toHaveBeenCalledWith('r7', 'Go'));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Waiting for you' })).not.toBeInTheDocument());
    unmount();

    ipc.listWorkflowQuestions
      .mockResolvedValueOnce([{ ...base, question: 'Anything to add?', choices: [], default: null }])
      .mockResolvedValue([]);
    render(<WorkflowsPage onStatus={vi.fn()} />);
    const typed = await screen.findByRole('group', { name: 'Waiting for you' });
    const send = within(typed).getByRole('button', { name: 'Send answer' });
    expect(send).toBeDisabled();
    fireEvent.change(within(typed).getByRole('textbox', { name: 'Your answer' }), { target: { value: 'Cover Go too' } });
    fireEvent.click(send);
    await waitFor(() => expect(ipc.answerWorkflowQuestion).toHaveBeenLastCalledWith('r7', 'Cover Go too'));
  });

  it('shows when a scheduled workflow runs next, in the list', async () => {
    ipc.listWorkflows.mockResolvedValue([{ ...summary, nextRunAt: '2026-09-30T06:00:00.000Z' }]);
    render(<WorkflowsPage onStatus={vi.fn()} />);
    expect(await screen.findByText(/^Next: /)).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: 'Schedule' })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'Edit as JSON' }));
    const box = screen.getByRole('textbox', { name: 'Steps (JSON)' });
    const save = () => screen.getByRole('button', { name: 'Save' });

    // Unreadable JSON is reported as you type, and saving waits for a fix.
    fireEvent.change(box, { target: { value: '{ not json' } });
    expect(await screen.findByText(/^Line 1, column 3: expected a quoted name/)).toBeInTheDocument();
    expect(save()).toBeDisabled();

    // The backend's validation is shown too.
    ipc.validateWorkflow.mockResolvedValueOnce(['Step "a" reads steps.b.text, which doesn\'t exist at that point.']);
    fireEvent.change(box, { target: { value: '{"steps":[{"id":"a","type":"template","template":"{{steps.b.text}}"}]}' } });
    expect(await screen.findByText(/reads steps.b.text/)).toBeInTheDocument();
    expect(save()).toBeDisabled();

    const good = { steps: [{ id: 'a', type: 'template', template: 'hello' }] };
    fireEvent.change(box, { target: { value: JSON.stringify(good) } });
    await waitFor(() => expect(save()).toBeEnabled());
    fireEvent.click(save());
    await waitFor(() => expect(ipc.updateWorkflow).toHaveBeenLastCalledWith('w1', 'Morning briefing', 'Two sites, one briefing', good));
    expect(await screen.findByText('Put the text together')).toBeInTheDocument();
  });

  it('switches between the step editor and JSON without losing edits', async () => {
    render(<WorkflowsPage onStatus={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Name of value 1' }), { target: { value: 'Main site' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit as JSON' }));
    const box = screen.getByRole('textbox', { name: 'Steps (JSON)' }) as HTMLTextAreaElement;
    expect(box.value).toContain('"label": "Main site"');
    fireEvent.change(box, { target: { value: box.value.replace('Main site', 'Front page') } });
    fireEvent.click(screen.getByRole('button', { name: 'Back to the step editor' }));
    expect(screen.getByRole('textbox', { name: 'Name of value 1' })).toHaveValue('Front page');
  });

  it('builds a new workflow from scratch in the step editor', async () => {
    ipc.listWorkflows.mockResolvedValueOnce([]).mockResolvedValue([summary]);
    const onStatus = vi.fn();
    render(<WorkflowsPage onStatus={onStatus} />);
    const empty = (await screen.findByText('No workflows yet')).closest('.page-empty') as HTMLElement;
    fireEvent.click(within(empty).getByRole('button', { name: 'Build it' }));

    // It starts with one empty fetch step; saving waits until it is valid.
    ipc.validateWorkflow.mockResolvedValue(['Step "fetch" has no pages to fetch.']);
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Read one page' } });
    expect(await screen.findByText('Step "fetch" has no pages to fetch.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    ipc.validateWorkflow.mockResolvedValue([]);
    const page1 = screen.getByRole('textbox', { name: 'Page 1' });
    page1.textContent = 'https://example.com';
    fireEvent.input(page1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(ipc.createWorkflow).toHaveBeenCalledWith('Read one page', null, {
        inputs: [],
        steps: [{ id: 'fetch', type: 'fetch_page', urls: ['https://example.com'] }],
      }),
    );
    expect(onStatus).toHaveBeenCalledWith('Created Morning briefing');
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
  describe('opened from Home', () => {
    const other: WorkflowSummary = { ...summary, id: 'w2', name: 'Topic watch' };
    const otherRecord: WorkflowRecord = { ...record, id: 'w2', name: 'Topic watch', description: null };
    const question = {
      runId: 'r7',
      workflowId: 'w2',
      workflowName: 'Topic watch',
      stepId: 'ask',
      question: 'Which topic?',
      choices: [],
      default: null,
      requestedAt: '2026-09-29T06:00:00.000Z',
      expiresAt: '2026-09-30T06:00:00.000Z',
    };

    beforeEach(() => {
      ipc.listWorkflows.mockResolvedValue([summary, other]);
      ipc.getWorkflow.mockImplementation(async (id: string) => (id === 'w2' ? otherRecord : record));
      ipc.listWorkflowQuestions.mockResolvedValue([question]);
    });

    it('selects the workflow that is waiting, not the first one', async () => {
      render(<WorkflowsPage onStatus={vi.fn()} focus={{ workflowId: 'w2', runId: 'r7' }} />);
      expect(await screen.findByRole('heading', { name: 'Topic watch' })).toBeInTheDocument();
      expect(ipc.getWorkflow).not.toHaveBeenCalledWith('w1');
      expect(await screen.findByRole('group', { name: 'Waiting for you' })).toHaveTextContent('Which topic?');
    });

    it('brings the waiting panel into view', async () => {
      const scroll = vi.fn();
      Element.prototype.scrollIntoView = scroll;
      render(<WorkflowsPage onStatus={vi.fn()} focus={{ workflowId: 'w2', runId: 'r7' }} />);
      await screen.findByRole('group', { name: 'Waiting for you' });
      await waitFor(() => expect(scroll).toHaveBeenCalled());
      expect((scroll.mock.contexts[0] as HTMLElement).dataset.runId).toBe('r7');
    });

    it('keeps the first workflow when nothing is asked for', async () => {
      render(<WorkflowsPage onStatus={vi.fn()} />);
      expect(await screen.findByRole('heading', { name: 'Morning briefing' })).toBeInTheDocument();
    });
  });

  it('keeps an over-long answer, and says why it was refused', async () => {
    const question = {
      runId: 'r7',
      workflowId: 'w1',
      workflowName: 'Morning briefing',
      stepId: 'ask',
      question: 'Anything to add?',
      choices: [],
      default: null,
      requestedAt: '2026-09-29T06:00:00.000Z',
      expiresAt: '2026-09-30T06:00:00.000Z',
    };
    ipc.listWorkflowQuestions.mockResolvedValue([question]);
    ipc.answerWorkflowQuestion.mockRejectedValueOnce(new Error('The answer is too long (2001 characters; the limit is 2000).'));
    render(<WorkflowsPage onStatus={vi.fn()} />);
    const panel = await screen.findByRole('group', { name: 'Waiting for you' });
    const box = within(panel).getByRole('textbox', { name: 'Your answer' });
    expect(box).toHaveAttribute('maxlength', '2000');
    expect(within(panel).queryByText(/characters$/)).not.toBeInTheDocument();
    const text = 'x'.repeat(1900);
    fireEvent.change(box, { target: { value: text } });
    expect(within(panel).getByText('1900 / 2000 characters')).toBeInTheDocument();

    fireEvent.click(within(panel).getByRole('button', { name: 'Send answer' }));
    const alert = await within(panel).findByRole('alert');
    expect(alert).toHaveTextContent('The answer is too long');
    // Still here, with the text, ready to be shortened and sent again.
    expect(screen.getByRole('group', { name: 'Waiting for you' })).toBe(panel);
    expect(box).toHaveValue(text);
    expect(within(panel).getByRole('button', { name: 'Send answer' })).toBeEnabled();

    ipc.answerWorkflowQuestion.mockResolvedValueOnce(true);
    ipc.listWorkflowQuestions.mockResolvedValue([]);
    fireEvent.change(box, { target: { value: 'short' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send answer' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Waiting for you' })).not.toBeInTheDocument());
  });

  it('keeps a review on screen when the answer is refused', async () => {
    const review = {
      runId: 'r9',
      workflowId: 'w1',
      workflowName: 'Morning briefing',
      stepId: 'fetch',
      permission: { kind: 'host', host: 'bbc.com', label: null, local: null },
      url: 'https://bbc.com/news',
      requestedAt: '2026-09-29T06:00:00.000Z',
      expiresAt: '2026-09-30T06:00:00.000Z',
    } as const;
    ipc.listWorkflowReviews.mockResolvedValue([review]);
    ipc.answerWorkflowReview.mockRejectedValueOnce(new Error('database is locked'));
    render(<WorkflowsPage onStatus={vi.fn()} />);
    const panel = await screen.findByRole('group', { name: 'Waiting for you' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Allow once' }));
    expect(await within(panel).findByRole('alert')).toHaveTextContent('database is locked');
    expect(within(panel).getByRole('button', { name: 'Allow once' })).toBeEnabled();
  });

  describe('a run that is still going', () => {
    const live = { ...finishedRun.run, id: 'r5', status: 'running' as const, error: null, finishedAt: null };
    const liveDetail: WorkflowRunDetail = { run: live, steps: [] };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('is picked up from the backend: Run now is off, Stop is on, the run is shown', async () => {
      ipc.listWorkflowRuns.mockResolvedValue([live]);
      ipc.getWorkflowRun.mockResolvedValue(liveDetail);
      render(<WorkflowsPage onStatus={vi.fn()} />);
      expect(await screen.findByRole('button', { name: 'Running…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled();
      expect(await screen.findByRole('region', { name: 'What this run did' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    });

    it('follows the run until it ends, then offers Run now again', async () => {
      ipc.listWorkflowRuns.mockResolvedValue([live]);
      ipc.getWorkflowRun.mockResolvedValue(liveDetail);
      render(<WorkflowsPage onStatus={vi.fn()} />);
      await screen.findByRole('button', { name: 'Running…' });
      await screen.findByRole('region', { name: 'What this run did' });

      const done = { ...live, status: 'completed' as const, finishedAt: '2026-09-28T08:00:09Z' };
      ipc.listWorkflowRuns.mockResolvedValue([done]);
      ipc.getWorkflowRun.mockResolvedValue({ run: done, steps: [] });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2100);
      });
      expect(await screen.findByRole('button', { name: 'Run now' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'What this run did' })).toHaveTextContent('Finished');
    });

    it('treats a run paused for approval as still going', async () => {
      ipc.listWorkflowRuns.mockResolvedValue([{ ...live, status: 'paused' as const }]);
      render(<WorkflowsPage onStatus={vi.fn()} />);
      // The button says it is waiting, not running.
      expect(await screen.findByRole('button', { name: 'Waiting for you' })).toBeDisabled();
    });

    it('ignores a live run of another workflow', async () => {
      ipc.listWorkflowRuns.mockResolvedValue([{ ...live, workflowId: 'other' }]);
      render(<WorkflowsPage onStatus={vi.fn()} />);
      expect(await screen.findByRole('button', { name: 'Run now' })).toBeEnabled();
    });
  });
});
