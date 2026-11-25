import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AskUserBlock } from './AskUserBlock';

const ipc = vi.hoisted(() => ({
  submitAskUser: vi.fn(),
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
  workflow: { id: 'wf-1', definition: { steps: [] } },
  permissions: { required: [{ kind: 'saveDocuments' }], missing: [{ kind: 'saveDocuments' }], approvedAt: null },
};
const ALLOWED = { workflow: { id: 'wf-1', definition: { steps: [] } }, permissions: { required: [], missing: [], approvedAt: null } };

const DRAFT = {
  name: 'Morning news',
  instructions: 'Summarize the top news in my field.',
  schedule: { kind: 'weekdays', time: '08:00' },
};

function renderCard(args: unknown = DRAFT) {
  const onDone = vi.fn();
  render(
    <AskUserBlock
      toolCallId="call-1"
      title="Morning news"
      fields={[{ id: 'draft', prompt: JSON.stringify(args), type: 'schedule_task' }]}
      onDone={onDone}
    />,
  );
  return { onDone };
}

const card = () => screen.getByRole('form', { name: 'Create this scheduled task?' });
const press = (name: string) => fireEvent.click(within(card()).getByRole('button', { name }));

beforeEach(() => {
  ipc.submitAskUser.mockResolvedValue(undefined);
  ipc.createRoutine.mockResolvedValue(ALLOWED);
  ipc.approveWorkflowPermissions.mockResolvedValue({});
  ipc.setWorkflowSchedule.mockResolvedValue({ workflowId: 'wf-1', enabled: true, nextRunAt: '2026-12-02T07:00:00Z' });
  ipc.deleteWorkflow.mockResolvedValue(undefined);
  ipc.listLibraryAgents.mockResolvedValue([]);
});
afterEach(() => vi.clearAllMocks());

describe('the schedule_task confirm card', () => {
  it('shows the draft and creates nothing until Create is pressed', () => {
    renderCard({ ...DRAFT, model: { provider: 'openrouter', model: 'glm' }, notify: true });
    const view = within(card());
    expect(view.getByText('Morning news')).toBeInTheDocument();
    expect(view.getByText('Summarize the top news in my field.')).toBeInTheDocument();
    expect(view.getByText('Weekdays at 08:00')).toBeInTheDocument();
    expect(view.getByText('openrouter / glm')).toBeInTheDocument();
    expect(view.getByText('Also notify me')).toBeInTheDocument();
    expect(ipc.createRoutine).not.toHaveBeenCalled();
    expect(ipc.submitAskUser).not.toHaveBeenCalled();
  });

  it('says the default model when none was named', () => {
    renderCard();
    expect(within(card()).getByText('Default model')).toBeInTheDocument();
  });

  it('Create makes the task, turns it on and tells the model when it runs next', async () => {
    const { onDone } = renderCard();
    press('Create');
    await waitFor(() => expect(ipc.submitAskUser).toHaveBeenCalledTimes(1));
    expect(ipc.createRoutine).toHaveBeenCalledWith({
      agentId: null,
      model: null,
      name: 'Morning news',
      task: 'Summarize the top news in my field.',
      schedule: { kind: 'weekdays', time: '08:00' },
      trigger: null,
      notify: false,
      output: 'chat',
      folder: null,
    });
    expect(ipc.setWorkflowSchedule).toHaveBeenCalledWith('wf-1', { kind: 'weekdays', time: '08:00' }, true);
    expect(ipc.approveWorkflowPermissions).not.toHaveBeenCalled();
    const [id, answer] = ipc.submitAskUser.mock.calls[0]!;
    expect(id).toBe('call-1');
    expect(answer.ok).toBe(true);
    expect(answer.result).toMatch(/^Created "Morning news" \(Weekdays at 08:00\) and turned it on\. It runs next /);
    expect(answer.result).toMatch(/new chat/);
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('shows what the task may do first, and only turns it on once that is approved', async () => {
    ipc.createRoutine.mockResolvedValue(NEEDS_OK);
    renderCard();
    press('Create');
    expect(await screen.findByText('Let it run on its own?')).toBeInTheDocument();
    expect(ipc.setWorkflowSchedule).not.toHaveBeenCalled();
    expect(ipc.submitAskUser).not.toHaveBeenCalled();
    press('Allow and turn on');
    await waitFor(() => expect(ipc.submitAskUser).toHaveBeenCalledTimes(1));
    expect(ipc.approveWorkflowPermissions).toHaveBeenCalledWith('wf-1');
    expect(ipc.setWorkflowSchedule).toHaveBeenCalledWith('wf-1', { kind: 'weekdays', time: '08:00' }, true);
    expect(ipc.submitAskUser.mock.calls[0]![1].result).toMatch(/^Created "Morning news"/);
  });

  it('removes a saved task again when the user does not approve it', async () => {
    ipc.createRoutine.mockResolvedValue(NEEDS_OK);
    renderCard();
    press('Create');
    await screen.findByText('Let it run on its own?');
    press('Cancel');
    await waitFor(() => expect(ipc.submitAskUser).toHaveBeenCalledTimes(1));
    expect(ipc.deleteWorkflow).toHaveBeenCalledWith('wf-1');
    expect(ipc.setWorkflowSchedule).not.toHaveBeenCalled();
    expect(ipc.submitAskUser.mock.calls[0]![1]).toMatchObject({ ok: true, result: expect.stringMatching(/did not approve/) });
  });

  it('Cancel creates nothing and says so', async () => {
    renderCard();
    press('Cancel');
    await waitFor(() => expect(ipc.submitAskUser).toHaveBeenCalledTimes(1));
    expect(ipc.createRoutine).not.toHaveBeenCalled();
    expect(ipc.submitAskUser).toHaveBeenCalledWith('call-1', { ok: true, result: 'The user cancelled; no task was created.' });
  });

  it('Edit in form opens the task form with the draft filled in, and saving there answers the model', async () => {
    renderCard({ ...DRAFT, schedule: { kind: 'weekly', days: ['mon'], time: '09:30' } });
    press('Edit in form');
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    expect(within(dialog).getByLabelText('Name')).toHaveValue('Morning news');
    expect(within(dialog).getByLabelText('Instructions')).toHaveValue('Summarize the top news in my field.');
    expect(within(dialog).getByDisplayValue('09:30')).toBeInTheDocument();
    expect(ipc.submitAskUser).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(ipc.submitAskUser).toHaveBeenCalledTimes(1));
    expect(ipc.createRoutine).toHaveBeenCalledTimes(1);
    expect(ipc.submitAskUser.mock.calls[0]![1].result).toMatch(/finished setting the task up in the form/);
  });

  it('closing the form without saving tells the model nothing was created', async () => {
    renderCard();
    press('Edit in form');
    const dialog = await screen.findByRole('dialog', { name: 'New task' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(ipc.submitAskUser).toHaveBeenCalledTimes(1));
    expect(ipc.createRoutine).not.toHaveBeenCalled();
    expect(ipc.submitAskUser.mock.calls[0]![1]).toMatchObject({ ok: true, result: expect.stringMatching(/without saving; no task was created/) });
  });

  it('tells the model when the app could not create the task', async () => {
    ipc.createRoutine.mockRejectedValue(new Error('Choose a folder first.'));
    renderCard();
    press('Create');
    await waitFor(() => expect(ipc.submitAskUser).toHaveBeenCalledTimes(1));
    expect(ipc.submitAskUser.mock.calls[0]![1]).toEqual({ ok: false, result: 'The task was not created: Choose a folder first.' });
    expect(ipc.setWorkflowSchedule).not.toHaveBeenCalled();
  });

  it('sends a draft with a past one-time run straight back as an error, without showing a card', async () => {
    renderCard({ ...DRAFT, schedule: { kind: 'once', at: '2020-01-01T09:00' } });
    await waitFor(() => expect(ipc.submitAskUser).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('form', { name: 'Create this scheduled task?' })).not.toBeInTheDocument();
    const [id, answer] = ipc.submitAskUser.mock.calls[0]!;
    expect(id).toBe('call-1');
    expect(answer.ok).toBe(false);
    expect(answer.result).toMatch(/^The task was not created\. schedule\.at 2020-01-01T09:00 is in the past/);
    expect(ipc.createRoutine).not.toHaveBeenCalled();
  });

  it('sends back an unknown day and a bad time the same way', async () => {
    renderCard({ ...DRAFT, schedule: { kind: 'weekly', days: ['funday'], time: '09:00' } });
    await waitFor(() => expect(ipc.submitAskUser).toHaveBeenCalledTimes(1));
    expect(ipc.submitAskUser.mock.calls[0]![1].result).toMatch(/Unknown day "funday"/);
  });

  it('still shows an ordinary ask_user form for other fields', () => {
    render(<AskUserBlock toolCallId="c" title="Which one?" fields={[{ id: 'a', prompt: 'Pick', type: 'text' }]} />);
    expect(screen.getByRole('form', { name: 'Which one?' })).toBeInTheDocument();
    expect(ipc.submitAskUser).not.toHaveBeenCalled();
  });
});
