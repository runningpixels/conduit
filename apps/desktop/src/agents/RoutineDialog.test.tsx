import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { nameFromTask, RoutineDialog, routineRequest } from './RoutineDialog';

const ipc = vi.hoisted(() => ({
  createRoutine: vi.fn(),
  approveWorkflowPermissions: vi.fn(),
  setWorkflowSchedule: vi.fn(),
  deleteWorkflow: vi.fn(),
  listLibraryAgents: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

const researcher = { id: 'researcher', name: 'Researcher', tools: ['web_search'] };
const NEEDS_OK = {
  workflow: { id: 'wf-1' },
  permissions: {
    required: [{ kind: 'saveDocuments' }, { kind: 'webSearch', backend: 'duckduckgo' }],
    missing: [{ kind: 'saveDocuments' }],
    approvedAt: null,
  },
};

beforeEach(() => {
  ipc.createRoutine.mockResolvedValue(NEEDS_OK);
  ipc.approveWorkflowPermissions.mockResolvedValue({});
  ipc.setWorkflowSchedule.mockResolvedValue(null);
  ipc.deleteWorkflow.mockResolvedValue(undefined);
  ipc.listLibraryAgents.mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

function dialog() {
  return screen.getByRole('dialog', { name: 'Run Researcher on a schedule' });
}

describe('RoutineDialog', () => {
  it('saves the routine, shows what it may do, and turns it on once approved', async () => {
    const onCreated = vi.fn();
    render(<RoutineDialog agent={researcher} onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('What to do each time'), {
      target: { value: 'Brief me on EU energy prices since yesterday' },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(ipc.createRoutine).toHaveBeenCalledWith({
        agentId: 'researcher',
        name: 'Brief me on EU energy prices',
        task: 'Brief me on EU energy prices since yesterday',
        schedule: { kind: 'weekdays', time: '08:00' },
        trigger: null,
        notify: false,
        output: 'document',
        folder: null,
      }),
    );
    expect(await screen.findByText('Let it run on its own?')).toBeInTheDocument();
    expect(screen.getByText('Save documents')).toBeInTheDocument();
    expect(ipc.setWorkflowSchedule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Allow and turn on' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('wf-1'));
    expect(ipc.approveWorkflowPermissions).toHaveBeenCalledWith('wf-1');
    expect(ipc.setWorkflowSchedule).toHaveBeenCalledWith('wf-1', { kind: 'weekdays', time: '08:00' }, true);
  });

  it('removes a saved routine again when the approval is cancelled', async () => {
    const onClose = vi.fn();
    render(<RoutineDialog agent={researcher} task="Check the news" onClose={onClose} onCreated={vi.fn()} />);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
    await screen.findByText('Let it run on its own?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(ipc.deleteWorkflow).toHaveBeenCalledWith('wf-1');
    expect(onClose).toHaveBeenCalled();
  });

  it('starts from the task it is given, named after it, and asks for a task when it is empty', async () => {
    render(<RoutineDialog agent={researcher} task="Summarise my inbox from the last day, briefly." onClose={vi.fn()} onCreated={vi.fn()} />);
    const task = screen.getByLabelText('What to do each time');
    expect(task).toHaveValue('Summarise my inbox from the last day, briefly.');
    expect(screen.getByLabelText('Name')).toHaveValue('Summarise my inbox from the last');
    fireEvent.change(task, { target: { value: '  ' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Say what the agent should do each time.')).toBeInTheDocument();
    expect(ipc.createRoutine).not.toHaveBeenCalled();
  });

  it('runs on a feed, every few hours, or on new files in a chosen folder', async () => {
    ipc.pickWorkspaceFolder.mockResolvedValue('C:\\Inbox');
    render(<RoutineDialog agent={researcher} task="Read it" onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'folder' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Choose a folder first.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    expect(await screen.findByText('C:\\Inbox')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Save as a Markdown file'));
    fireEvent.click(screen.getByLabelText('Also notify me'));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(ipc.createRoutine).toHaveBeenCalledWith(
        expect.objectContaining({
          schedule: { kind: 'trigger' },
          trigger: { kind: 'folder' },
          folder: 'C:\\Inbox',
          output: 'file',
          notify: true,
        }),
      ),
    );
  });

  it('asks for a folder when the agent uses the computer, reading its tools from your agents', async () => {
    ipc.listLibraryAgents.mockResolvedValue([
      { agent: { id: 'builder', name: 'Builder', instructions: 'Build.', tools: ['computer'] } },
    ]);
    render(<RoutineDialog agent={{ id: 'builder', name: 'Builder' }} task="Build" onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(await screen.findByText('This agent uses the computer, so it works in this folder.')).toBeInTheDocument();
  });
});

describe('routineRequest', () => {
  const base = {
    agentId: 'researcher',
    name: '',
    task: 'Watch the feed',
    when: 'feed' as const,
    time: '08:00',
    hours: 4,
    folder: '',
    feedUrl: ' https://example.com/feed ',
    output: 'document' as const,
    notify: false,
  };

  it('makes a feed trigger, and an interval from the hours chosen', () => {
    expect(routineRequest(base)).toMatchObject({
      schedule: { kind: 'trigger' },
      trigger: { kind: 'feed', url: 'https://example.com/feed', everyMinutes: 30 },
      name: 'Watch the feed',
    });
    expect(routineRequest({ ...base, when: 'interval', hours: 6 })).toMatchObject({
      schedule: { kind: 'interval', hours: 6 },
      trigger: null,
    });
  });

  it('names a routine after the first line of its task, shortened', () => {
    expect(nameFromTask('First line\nsecond')).toBe('First line');
    expect(nameFromTask('x'.repeat(100))).toHaveLength(60);
    expect(nameFromTask('Brief me on EU energy prices since yesterday, please.')).toBe('Brief me on EU energy prices');
    expect(nameFromTask('Check the news.')).toBe('Check the news');
  });
});

describe('the approval', () => {
  it('names the agent the routine runs as, not its step', async () => {
    ipc.createRoutine.mockResolvedValue({
      workflow: { id: 'wf-1', definition: { steps: [{ id: 'work', type: 'agent', agent: 'researcher', prompt: 'Go' }] } },
      permissions: {
        required: [{ kind: 'agentTools', stepId: 'work', tools: ['web_search'], label: null, local: null }],
        missing: [{ kind: 'agentTools', stepId: 'work', tools: ['web_search'], label: null, local: null }],
        approvedAt: null,
      },
    });
    render(<RoutineDialog agent={researcher} task="Go" onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/^Let Researcher: /)).toBeInTheDocument();
    expect(screen.queryByText(/step “work”/)).toBeNull();
  });
});
