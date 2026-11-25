import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TaskDialog } from './TaskDialog';
import { emptyDraft, type TaskDraft } from './taskForm';

const ipc = vi.hoisted(() => ({
  createRoutine: vi.fn(),
  updateRoutine: vi.fn(),
  approveWorkflowPermissions: vi.fn(),
  setWorkflowSchedule: vi.fn(),
  deleteWorkflow: vi.fn(),
  listLibraryAgents: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

const NEEDS_OK = {
  workflow: { id: 'wf-1' },
  permissions: {
    required: [{ kind: 'saveDocuments' }],
    missing: [{ kind: 'saveDocuments' }],
    approvedAt: null,
  },
};
const ALLOWED = { workflow: { id: 'wf-1' }, permissions: { required: [], missing: [], approvedAt: null } };

beforeEach(() => {
  ipc.createRoutine.mockResolvedValue(NEEDS_OK);
  ipc.updateRoutine.mockResolvedValue(NEEDS_OK);
  ipc.approveWorkflowPermissions.mockResolvedValue({});
  ipc.setWorkflowSchedule.mockResolvedValue(null);
  ipc.deleteWorkflow.mockResolvedValue(undefined);
  ipc.listLibraryAgents.mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

function dialog() {
  return screen.getByRole('dialog', { name: /task$/ });
}

function renderDialog(draft: Partial<TaskDraft> = {}, props: { editing?: string } = {}) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<TaskDialog draft={{ ...emptyDraft(), task: 'Check the news', ...draft }} onClose={onClose} onSaved={onSaved} {...props} />);
  return { onSaved, onClose };
}

const create = () => fireEvent.click(within(dialog()).getByRole('button', { name: 'Create' }));

describe('TaskDialog', () => {
  it('creates a chat task for the assistant, shows what it may do and turns it on once approved', async () => {
    const { onSaved } = renderDialog({ task: '' });
    fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Brief me on EU energy prices' } });
    expect(screen.getByRole('note')).toHaveTextContent('Runs without you watching, and can only do what you approve next.');
    create();
    await waitFor(() =>
      expect(ipc.createRoutine).toHaveBeenCalledWith({
        agentId: null,
        model: null,
        name: 'Brief me on EU energy prices',
        task: 'Brief me on EU energy prices',
        schedule: { kind: 'weekdays', time: '08:00' },
        trigger: null,
        notify: false,
        output: 'chat',
        folder: null,
      }),
    );
    expect(await screen.findByText('Let it run on its own?')).toBeInTheDocument();
    expect(ipc.setWorkflowSchedule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Allow and turn on' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('wf-1'));
    expect(ipc.approveWorkflowPermissions).toHaveBeenCalledWith('wf-1');
    expect(ipc.setWorkflowSchedule).toHaveBeenCalledWith('wf-1', { kind: 'weekdays', time: '08:00' }, true);
  });

  it('turns it on straight away when nothing needs approval', async () => {
    ipc.createRoutine.mockResolvedValue(ALLOWED);
    const { onSaved } = renderDialog();
    create();
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('wf-1'));
    expect(ipc.approveWorkflowPermissions).not.toHaveBeenCalled();
  });

  it('removes a new task again when the approval is cancelled', async () => {
    const first = renderDialog();
    create();
    await screen.findByText('Let it run on its own?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(ipc.deleteWorkflow).toHaveBeenCalledWith('wf-1');
    expect(first.onClose).toHaveBeenCalled();
  });

  it('rewrites an edited task instead of making a new one', async () => {
    ipc.deleteWorkflow.mockClear();
    const { onClose } = renderDialog({ name: 'Morning news' }, { editing: 'wf-9' });
    expect(screen.getByRole('dialog', { name: 'Edit task' })).toBeInTheDocument();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(ipc.updateRoutine).toHaveBeenCalledWith('wf-9', expect.objectContaining({ name: 'Morning news' })));
    expect(ipc.createRoutine).not.toHaveBeenCalled();
    await screen.findByText('Let it run on its own?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(ipc.deleteWorkflow).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('asks for instructions when they are empty', async () => {
    renderDialog({ task: ' ' });
    create();
    expect(await screen.findByText('Say what the task should do each time.')).toBeInTheDocument();
    expect(ipc.createRoutine).not.toHaveBeenCalled();
  });

  describe('builds the request for each When kind', () => {
    /// Fill in the When controls, create, and return what was sent.
    async function sent(fill: () => void) {
      ipc.createRoutine.mockResolvedValue(ALLOWED);
      renderDialog();
      fill();
      create();
      await waitFor(() => expect(ipc.createRoutine).toHaveBeenCalled());
      return ipc.createRoutine.mock.calls.at(-1)![0];
    }
    const pick = (kind: string) => fireEvent.change(screen.getByLabelText('When'), { target: { value: kind } });

    it('every day, at a time', async () => {
      const request = await sent(() => {
        pick('daily');
        fireEvent.change(screen.getByLabelText('At'), { target: { value: '09:30' } });
      });
      expect(request.schedule).toEqual({ kind: 'daily', time: '09:30' });
    });

    it('chosen days of the week, never none', async () => {
      const request = await sent(() => {
        pick('weekly');
        fireEvent.click(screen.getByRole('button', { name: 'Friday' }));
        // The last day cannot be switched off.
        fireEvent.click(screen.getByRole('button', { name: 'Monday' }));
        fireEvent.click(screen.getByRole('button', { name: 'Friday' }));
        expect(screen.getByRole('button', { name: 'Friday' })).toHaveAttribute('aria-pressed', 'true');
      });
      expect(request.schedule).toEqual({ kind: 'weekly', days: ['fri'], time: '08:00' });
    });

    it('a day of the month', async () => {
      const request = await sent(() => {
        pick('monthly');
        fireEvent.change(screen.getByLabelText('Day of the month'), { target: { value: '15' } });
      });
      expect(request.schedule).toEqual({ kind: 'monthly', day: 15, time: '08:00' });
    });

    it('every few hours', async () => {
      const request = await sent(() => {
        pick('interval');
        fireEvent.change(screen.getByLabelText('Every'), { target: { value: '6' } });
      });
      expect(request.schedule).toEqual({ kind: 'interval', hours: 6 });
    });

    it('once, on a date and time', async () => {
      const request = await sent(() => {
        pick('once');
        fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: '2999-01-02T10:15' } });
      });
      expect(request.schedule).toEqual({ kind: 'once', at: '2999-01-02T10:15' });
    });

    it('a new post in a feed', async () => {
      const request = await sent(() => {
        pick('feed');
        fireEvent.change(screen.getByLabelText('Feed address'), { target: { value: 'https://example.com/feed' } });
      });
      expect(request).toMatchObject({
        schedule: { kind: 'trigger' },
        trigger: { kind: 'feed', url: 'https://example.com/feed', everyMinutes: 30 },
      });
    });
  });

  it('refuses a one-time task in the past', async () => {
    renderDialog({ when: 'once', spec: { kind: 'once', at: '2000-01-01T08:00' } });
    create();
    expect(await screen.findByText('Pick a time in the future.')).toBeInTheDocument();
    expect(ipc.createRoutine).not.toHaveBeenCalled();
  });

  it('needs a folder for a folder trigger, then sends it with the chosen result and notification', async () => {
    ipc.createRoutine.mockResolvedValue(ALLOWED);
    ipc.pickWorkspaceFolder.mockResolvedValue('C:\\Inbox');
    renderDialog({ when: 'folder' });
    create();
    expect(await screen.findByText('Choose a folder first.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder…' }));
    expect(await screen.findByText('C:\\Inbox')).toBeInTheDocument();
    const advanced = screen.getByRole('button', { name: 'Advanced settings' });
    expect(advanced).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(advanced);
    expect(screen.getByLabelText('A chat you can reply to')).toBeChecked();
    fireEvent.click(screen.getByLabelText('Save as a document in Results'));
    fireEvent.click(screen.getByLabelText('Also notify me'));
    create();
    await waitFor(() =>
      expect(ipc.createRoutine).toHaveBeenCalledWith(
        expect.objectContaining({
          schedule: { kind: 'trigger' },
          trigger: { kind: 'folder' },
          folder: 'C:\\Inbox',
          output: 'document',
          notify: true,
        }),
      ),
    );
  });

  it('offers your agents next to the assistant and sends the one picked', async () => {
    ipc.createRoutine.mockResolvedValue(ALLOWED);
    ipc.listLibraryAgents.mockResolvedValue([{ agent: { id: 'researcher', name: 'Researcher', instructions: 'x', tools: [] } }]);
    renderDialog();
    expect(screen.getByLabelText('Agent')).toHaveValue('');
    await screen.findByRole('option', { name: 'Researcher' });
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'researcher' } });
    create();
    await waitFor(() => expect(ipc.createRoutine).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'researcher' })));
  });
});
