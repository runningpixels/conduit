import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ScheduledItem } from '../ipc/contracts';
import { ScheduledPage } from './ScheduledPage';

const ipc = vi.hoisted(() => ({
  listScheduled: vi.fn(),
  getWorkflow: vi.fn(),
  runWorkflow: vi.fn(),
  deleteWorkflow: vi.fn(),
  setWorkflowSchedule: vi.fn(),
  createRoutine: vi.fn(),
  updateRoutine: vi.fn(),
  approveWorkflowPermissions: vi.fn(),
  listLibraryAgents: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

const base: ScheduledItem = {
  workflowId: 'x',
  kind: 'task',
  name: 'x',
  task: null,
  agentId: null,
  schedule: null,
  trigger: null,
  enabled: true,
  nextRunAt: null,
  lastRunId: null,
  lastRunStatus: null,
  lastRunAt: null,
  lastResultTitle: null,
  lastConversationId: null,
  lastArtifactId: null,
};

const TASK: ScheduledItem = {
  ...base,
  workflowId: 'wf-task',
  kind: 'task',
  name: 'Morning news',
  task: 'Summarize the news',
  schedule: { kind: 'weekly', days: ['mon'], time: '07:00' },
  nextRunAt: '2026-12-07T06:00:00Z',
  lastRunId: 'run-1',
  lastRunStatus: 'completed',
  lastRunAt: new Date().toISOString(),
  lastResultTitle: 'Morning news — 2026-11-30',
  lastConversationId: 'chat-1',
};
const ROUTINE: ScheduledItem = {
  ...base,
  workflowId: 'wf-routine',
  kind: 'routine',
  name: 'Research digest',
  task: 'Collect the papers',
  agentId: 'researcher',
  schedule: { kind: 'interval', hours: 4 },
  enabled: false,
  lastRunId: 'run-2',
  lastRunStatus: 'failed',
  lastRunAt: new Date().toISOString(),
};
const WORKFLOW: ScheduledItem = {
  ...base,
  workflowId: 'wf-flow',
  kind: 'workflow',
  name: 'Release watcher',
  schedule: { kind: 'trigger' },
  trigger: { kind: 'folder' },
  lastRunId: 'run-3',
  lastRunStatus: 'completed',
  lastRunAt: new Date().toISOString(),
  lastArtifactId: 'art-1',
};

function renderPage() {
  const props = { onOpenWorkflow: vi.fn(), onOpenConversation: vi.fn(), onRunDone: vi.fn() };
  render(<ScheduledPage {...props} />);
  return props;
}

beforeEach(() => {
  ipc.listScheduled.mockResolvedValue([]);
  ipc.getWorkflow.mockResolvedValue({ id: 'wf-task', name: 'Morning news', definition: { steps: [] } });
  ipc.runWorkflow.mockResolvedValue({});
  ipc.deleteWorkflow.mockResolvedValue(undefined);
  ipc.setWorkflowSchedule.mockResolvedValue(null);
  ipc.listLibraryAgents.mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

describe('ScheduledPage', () => {
  it('shows the empty state with the templates below it when nothing is scheduled', async () => {
    renderPage();
    expect(await screen.findByText('No scheduled tasks yet.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Scheduled tasks' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set up manually' })).toBeInTheDocument();
    const grid = screen.getByRole('list', { name: 'Templates' });
    const names = within(grid)
      .getAllByRole('button')
      .map((b) => within(b).getByText(/./, { selector: '.sched-template-name' }).textContent);
    expect(names).toEqual(['Daily briefing', 'Monitor a topic', 'Weekly review', 'Content ideas', 'Watch a page', 'Folder digest']);
    // A description and a clock line on each.
    expect(within(grid).getByText('The top news in your field, every weekday morning.')).toBeInTheDocument();
    expect(within(grid).getByText('Weekdays at 08:00')).toBeInTheDocument();
    expect(within(grid).getByText('When a new file arrives')).toBeInTheDocument();
  });

  it('lists a task, an agent routine and a workflow with when they run and how the last run went', async () => {
    ipc.listScheduled.mockResolvedValue([TASK, ROUTINE, WORKFLOW]);
    renderPage();
    const list = await screen.findByRole('list', { name: 'Yours' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    // The next run comes first, then the rest by name.
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['task', 'workflow', 'routine']);

    const task = rows[0]!;
    expect(within(task).getByText('Morning news')).toBeInTheDocument();
    expect(within(task).getByText('Task')).toBeInTheDocument();
    expect(within(task).getByText(/Every Monday at 07:00 · next /)).toBeInTheDocument();
    expect(within(task).getByText(/^Last: Morning news — 2026-11-30, /)).toBeInTheDocument();

    const workflow = rows[1]!;
    expect(within(workflow).getByText('Workflow')).toBeInTheDocument();
    expect(within(workflow).getByText('When a new file arrives · on')).toBeInTheDocument();

    const routine = rows[2]!;
    expect(within(routine).getByText('Agent')).toBeInTheDocument();
    expect(within(routine).getByText('Every 4 hours · paused')).toBeInTheDocument();
    expect(within(routine).getByText(/^Last run failed /)).toBeInTheDocument();
    expect(within(routine).getByRole('button', { name: 'Resume Research digest' })).toBeInTheDocument();
  });

  it('opens a saved chat from Open result, and a document through the workflow’s results', async () => {
    ipc.listScheduled.mockResolvedValue([TASK, WORKFLOW]);
    const props = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Open the latest result of Morning news' }));
    expect(props.onOpenConversation).toHaveBeenCalledWith('chat-1');
    fireEvent.click(screen.getByRole('button', { name: 'Open the latest result of Release watcher' }));
    expect(props.onOpenWorkflow).toHaveBeenCalledWith('wf-flow', 'run-3');
  });

  it('runs, pauses and deletes a task', async () => {
    ipc.listScheduled.mockResolvedValue([TASK]);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const props = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Run Morning news now' }));
    await waitFor(() => expect(ipc.runWorkflow).toHaveBeenCalledWith('wf-task', {}));
    // The run may have saved a chat: the app re-reads its history.
    await waitFor(() => expect(props.onRunDone).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Pause Morning news' }));
    await waitFor(() =>
      expect(ipc.setWorkflowSchedule).toHaveBeenCalledWith('wf-task', { kind: 'weekly', days: ['mon'], time: '07:00' }, false),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete Morning news' }));
    await waitFor(() => expect(ipc.deleteWorkflow).toHaveBeenCalledWith('wf-task'));
  });

  it('edits a task in the dialog and a workflow in the editor', async () => {
    ipc.listScheduled.mockResolvedValue([TASK, WORKFLOW]);
    const props = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Release watcher' }));
    expect(props.onOpenWorkflow).toHaveBeenCalledWith('wf-flow');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Morning news' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit task' });
    expect(within(dialog).getByLabelText('Instructions')).toHaveValue('Summarize the news');
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Morning news');
    expect(within(dialog).getByLabelText('When')).toHaveValue('weekly');
  });

  it('filters by kind and searches by name', async () => {
    ipc.listScheduled.mockResolvedValue([TASK, ROUTINE, WORKFLOW]);
    renderPage();
    await screen.findByRole('list', { name: 'Yours' });
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'routine' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('Research digest')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'release' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Search tasks'), { target: { value: 'nothing like it' } });
    expect(screen.getByText('No tasks match your search.')).toBeInTheDocument();
  });

  it('opens the task dialog filled in from a template', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Weekly review/ }));
    const dialog = screen.getByRole('dialog', { name: 'New task' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Weekly review');
    expect((within(dialog).getByLabelText('Instructions') as HTMLTextAreaElement).value).toContain(
      'Search the web for what happened this week',
    );
    expect(within(dialog).getByLabelText('When')).toHaveValue('weekly');
    expect(within(dialog).getByLabelText('At')).toHaveValue('16:00');
    expect(within(dialog).getByRole('button', { name: 'Friday' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the templates on their own tab when tasks exist', async () => {
    ipc.listScheduled.mockResolvedValue([TASK]);
    renderPage();
    await screen.findByRole('list', { name: 'Yours' });
    fireEvent.click(screen.getByRole('tab', { name: 'Templates' }));
    expect(screen.getByRole('list', { name: 'Templates' })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Yours' })).not.toBeInTheDocument();
  });

  it('creates a task from "New task" and goes back to the list', async () => {
    ipc.createRoutine.mockResolvedValue({ workflow: { id: 'wf-new' }, permissions: { required: [], missing: [], approvedAt: null } });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
    const dialog = screen.getByRole('dialog', { name: 'New task' });
    fireEvent.change(within(dialog).getByLabelText('Instructions'), { target: { value: 'Check the news' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(ipc.setWorkflowSchedule).toHaveBeenCalledWith('wf-new', { kind: 'weekdays', time: '08:00' }, true));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  describe('New task menu', () => {
    function renderWithChat() {
      const props = { onOpenWorkflow: vi.fn(), onOpenConversation: vi.fn(), onSetUpInChat: vi.fn() };
      render(<ScheduledPage {...props} />);
      return props;
    }

    it('is a plain button without a way to open a chat', async () => {
      renderPage();
      const button = await screen.findByRole('button', { name: 'New task' });
      expect(button).not.toHaveAttribute('aria-haspopup');
    });

    it('offers New task and Set up in chat', async () => {
      renderWithChat();
      const trigger = await screen.findByRole('button', { name: /^New task/ });
      expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
      fireEvent.click(trigger);
      const menu = screen.getByRole('menu', { name: 'New task' });
      expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['New task', 'Set up in chat']);
    });

    it('New task opens the form', async () => {
      renderWithChat();
      fireEvent.click(await screen.findByRole('button', { name: /^New task/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'New task' }));
      expect(screen.getByRole('dialog', { name: 'New task' })).toBeInTheDocument();
    });

    it('Set up in chat sends the starter message to a new chat', async () => {
      const props = renderWithChat();
      fireEvent.click(await screen.findByRole('button', { name: /^New task/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Set up in chat' }));
      expect(props.onSetUpInChat).toHaveBeenCalledWith(
        'Help me set up a scheduled task. Ask me what it should do, how often it should run, and when, then create it.',
      );
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('the form links to the chat setup, and following it closes the form without creating anything', async () => {
      const props = renderWithChat();
      fireEvent.click(await screen.findByRole('button', { name: /^New task/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'New task' }));
      const dialog = screen.getByRole('dialog', { name: 'New task' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Set up in chat instead' }));
      expect(props.onSetUpInChat).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(ipc.createRoutine).not.toHaveBeenCalled();
    });

    it('the form has no chat link when the page cannot open a chat', async () => {
      renderPage();
      fireEvent.click(await screen.findByRole('button', { name: 'New task' }));
      expect(screen.queryByRole('button', { name: 'Set up in chat instead' })).not.toBeInTheDocument();
    });
  });
});
