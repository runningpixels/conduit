import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { WorkflowAction, WorkflowQuestion, WorkflowReview } from '../ipc/contracts';
import { InboxPage } from './InboxPage';

const ipc = vi.hoisted(() => ({
  listWorkflowActions: vi.fn(),
  listWorkflowQuestions: vi.fn(),
  listWorkflowReviews: vi.fn(),
  answerWorkflowAction: vi.fn(),
  answerWorkflowQuestion: vi.fn(),
  answerWorkflowReview: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

const action: WorkflowAction = {
  runId: 'ra',
  workflowId: 'wa',
  workflowName: 'Standup post',
  stepId: 's1',
  connectorId: 'slack',
  connectorName: 'Slack',
  tool: 'post_message',
  description: null,
  arguments: { text: 'Hi' },
  inputSchema: {},
  sensitive: false,
  requestedAt: '2026-10-12T08:00:00Z',
  expiresAt: '2026-10-13T08:00:00Z',
};
const question: WorkflowQuestion = {
  runId: 'rq',
  workflowId: 'wq',
  workflowName: 'Weekly plan',
  stepId: 's2',
  question: 'Which project first?',
  choices: ['Alpha', 'Beta'],
  default: null,
  requestedAt: '2026-10-12T07:00:00Z',
  expiresAt: '2026-10-13T07:00:00Z',
};
const review: WorkflowReview = {
  runId: 'rr',
  workflowId: 'wr',
  workflowName: 'News digest',
  stepId: 's3',
  permission: { kind: 'host', host: 'bbc.com', label: null, local: null },
  url: null,
  requestedAt: '2026-10-12T09:00:00Z',
  expiresAt: '2026-10-13T09:00:00Z',
};

beforeEach(() => {
  for (const fn of Object.values(ipc)) fn.mockReset();
  ipc.listWorkflowActions.mockResolvedValue([]);
  ipc.listWorkflowQuestions.mockResolvedValue([]);
  ipc.listWorkflowReviews.mockResolvedValue([]);
});

describe('InboxPage', () => {
  it('says nothing is waiting', async () => {
    render(<InboxPage onStatus={vi.fn()} onOpenWorkflow={vi.fn()} />);
    expect(await screen.findByText('Nothing is waiting for you')).toBeInTheDocument();
    expect(screen.getByText(/it waits here/)).toBeInTheDocument();
  });

  it('lists actions, questions and requests, oldest first, and opens a workflow', async () => {
    ipc.listWorkflowActions.mockResolvedValue([action]);
    ipc.listWorkflowQuestions.mockResolvedValue([question]);
    ipc.listWorkflowReviews.mockResolvedValue([review]);
    const onOpenWorkflow = vi.fn();
    render(<InboxPage onStatus={vi.fn()} onOpenWorkflow={onOpenWorkflow} />);
    const list = await screen.findByRole('list', { name: 'Waiting for you' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('.inbox-item-workflow')?.textContent)).toEqual([
      'Weekly plan',
      'Standup post',
      'News digest',
    ]);
    expect(within(rows[0]).getByText('Which project first?')).toBeInTheDocument();
    expect(within(rows[1]).getByText('“post_message” in Slack')).toBeInTheDocument();
    expect(within(rows[2]).getByText('It wants to read pages on bbc.com.')).toBeInTheDocument();
    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Open Standup post' }));
    expect(onOpenWorkflow).toHaveBeenCalledWith('wa', 'ra');
  });

  it('removes an item once it is answered', async () => {
    ipc.listWorkflowActions.mockResolvedValueOnce([action]).mockResolvedValue([]);
    ipc.answerWorkflowAction.mockResolvedValue(true);
    render(<InboxPage onStatus={vi.fn()} onOpenWorkflow={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('ra', 's1', { send: true }));
    expect(await screen.findByText('Nothing is waiting for you')).toBeInTheDocument();
  });

  it('answers a permission request', async () => {
    ipc.listWorkflowReviews.mockResolvedValueOnce([review]).mockResolvedValue([]);
    ipc.answerWorkflowReview.mockResolvedValue(true);
    render(<InboxPage onStatus={vi.fn()} onOpenWorkflow={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Allow once' }));
    await waitFor(() => expect(ipc.answerWorkflowReview).toHaveBeenCalledWith('rr', 'allowOnce', 's3'));
    expect(await screen.findByText('Nothing is waiting for you')).toBeInTheDocument();
  });

  it('answers a question', async () => {
    ipc.listWorkflowQuestions.mockResolvedValueOnce([question]).mockResolvedValue([]);
    ipc.answerWorkflowQuestion.mockResolvedValue(true);
    render(<InboxPage onStatus={vi.fn()} onOpenWorkflow={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Beta' }));
    await waitFor(() => expect(ipc.answerWorkflowQuestion).toHaveBeenCalledWith('rq', 'Beta', 's2'));
    expect(await screen.findByText('Nothing is waiting for you')).toBeInTheDocument();
  });
});
