import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ScheduleSpec, WorkflowPermissions, WorkflowSchedule } from '../ipc/contracts';

const ipc = vi.hoisted(() => ({
  getWorkflowSchedule: vi.fn(),
  setWorkflowSchedule: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
  getStartAtLogin: vi.fn(),
  setStartAtLogin: vi.fn(),
  getWorkflowPermissions: vi.fn(),
  approveWorkflowPermissions: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

import { ScheduleSection } from './ScheduleSection';

beforeEach(() => {
  vi.clearAllMocks();
  ipc.getWorkflowSchedule.mockResolvedValue(null);
  // The tray offer has been answered already: these tests are about the schedule.
  ipc.getSettings.mockResolvedValue({ closeToTray: false, closeToTrayOffered: true });
  ipc.getStartAtLogin.mockResolvedValue(false);
  // Everything approved already, unless a test says otherwise.
  ipc.getWorkflowPermissions.mockResolvedValue({ required: [], missing: [], approvedAt: null });
  ipc.setWorkflowSchedule.mockImplementation(
    async (workflowId: string, spec: ScheduleSpec, enabled: boolean): Promise<WorkflowSchedule> => ({
      workflowId,
      spec,
      enabled,
      nextRunAt: enabled ? '2026-09-30T06:00:00.000Z' : null,
      lastRunAt: null,
    }),
  );
});

describe('ScheduleSection', () => {
  it('switches a schedule on with a sensible default and shows the next run', async () => {
    const onChanged = vi.fn();
    render(<ScheduleSection workflowId="w1" onStatus={vi.fn()} onChanged={onChanged} />);
    const toggle = await screen.findByRole('checkbox', { name: 'Run automatically' });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByRole('combobox', { name: 'How often' })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(ipc.setWorkflowSchedule).toHaveBeenCalledWith('w1', { kind: 'daily', time: '08:00' }, true));
    expect(await screen.findByText(/^Next run: /)).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('changes how often, the hours and the time, and switches off keeping the choice', async () => {
    ipc.getWorkflowSchedule.mockResolvedValue({
      workflowId: 'w1',
      spec: { kind: 'daily', time: '07:15' },
      enabled: true,
      nextRunAt: '2026-09-30T05:15:00.000Z',
      lastRunAt: null,
    });
    render(<ScheduleSection workflowId="w1" onStatus={vi.fn()} />);
    const often = await screen.findByRole('combobox', { name: 'How often' });
    expect(screen.getByLabelText('At')).toHaveValue('07:15');

    fireEvent.change(often, { target: { value: 'weekdays' } });
    await waitFor(() => expect(ipc.setWorkflowSchedule).toHaveBeenLastCalledWith('w1', { kind: 'weekdays', time: '07:15' }, true));

    fireEvent.change(screen.getByLabelText('At'), { target: { value: '09:45' } });
    await waitFor(() => expect(ipc.setWorkflowSchedule).toHaveBeenLastCalledWith('w1', { kind: 'weekdays', time: '09:45' }, true));

    fireEvent.change(screen.getByRole('combobox', { name: 'How often' }), { target: { value: 'interval' } });
    await waitFor(() => expect(ipc.setWorkflowSchedule).toHaveBeenLastCalledWith('w1', { kind: 'interval', hours: 4 }, true));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Every' }), { target: { value: '12' } });
    await waitFor(() => expect(ipc.setWorkflowSchedule).toHaveBeenLastCalledWith('w1', { kind: 'interval', hours: 12 }, true));

    fireEvent.click(screen.getByRole('checkbox', { name: 'Run automatically' }));
    await waitFor(() => expect(ipc.setWorkflowSchedule).toHaveBeenLastCalledWith('w1', { kind: 'interval', hours: 12 }, false));
    await waitFor(() => expect(screen.queryByText(/^Next run: /)).not.toBeInTheDocument());
  });

  it('reports a schedule that could not be saved', async () => {
    ipc.setWorkflowSchedule.mockRejectedValueOnce(new Error('disk full'));
    const onStatus = vi.fn();
    render(<ScheduleSection workflowId="w1" onStatus={onStatus} />);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Run automatically' }));
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith("Couldn't save the schedule: disk full"));
  });
});

const BBC = { kind: 'host', host: 'bbc.com', label: null, local: null } as const;
const OLLAMA = { kind: 'model', provider: 'ollama', label: 'Ollama', local: true } as const;
const SAVE = { kind: 'saveDocuments', label: null, local: null } as const;

describe('ScheduleSection approval', () => {
  it('asks to approve what the workflow may do before turning a schedule on', async () => {
    const needs: WorkflowPermissions = { required: [BBC, OLLAMA, SAVE], missing: [BBC, OLLAMA, SAVE], approvedAt: null };
    ipc.getWorkflowPermissions.mockResolvedValue(needs);
    ipc.approveWorkflowPermissions.mockResolvedValue({ ...needs, missing: [], approvedAt: '2026-09-29T08:00:00Z' });
    render(<ScheduleSection workflowId="w1" onStatus={vi.fn()} />);
    const toggle = await screen.findByRole('checkbox', { name: 'Run automatically' });
    await waitFor(() => expect(ipc.getWorkflowPermissions).toHaveBeenCalledWith('w1'));

    fireEvent.click(toggle);
    const sheet = await screen.findByRole('group', { name: 'Let it run on its own?' });
    expect(sheet).toHaveTextContent('Read pages on bbc.com');
    expect(sheet).toHaveTextContent('Use Ollama, on this computer');
    expect(sheet).toHaveTextContent('Save documents');
    expect(ipc.setWorkflowSchedule).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Allow and turn on' }));
    await waitFor(() => expect(ipc.setWorkflowSchedule).toHaveBeenCalledWith('w1', { kind: 'daily', time: '08:00' }, true));
    expect(ipc.approveWorkflowPermissions).toHaveBeenCalledWith('w1');
    expect(screen.queryByRole('group', { name: 'Let it run on its own?' })).not.toBeInTheDocument();
    expect(await screen.findByText(/^When it runs on its own, it may: Read pages on bbc.com · /)).toBeInTheDocument();
  });

  it('cancelling the approval leaves the schedule off', async () => {
    ipc.getWorkflowPermissions.mockResolvedValue({ required: [SAVE], missing: [SAVE], approvedAt: null });
    render(<ScheduleSection workflowId="w1" onStatus={vi.fn()} />);
    await waitFor(() => expect(ipc.getWorkflowPermissions).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Run automatically' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Let it run on its own?' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Run automatically' })).not.toBeChecked();
    expect(ipc.setWorkflowSchedule).not.toHaveBeenCalled();
    expect(ipc.approveWorkflowPermissions).not.toHaveBeenCalled();
  });

  it('says what an edit added since the approval, and approves it', async () => {
    ipc.getWorkflowSchedule.mockResolvedValue({
      workflowId: 'w1',
      spec: { kind: 'daily', time: '07:15' },
      enabled: true,
      nextRunAt: '2026-09-30T05:15:00.000Z',
      lastRunAt: null,
    });
    const cloud = { kind: 'model', provider: 'openai', label: 'OpenAI', local: false } as const;
    ipc.getWorkflowPermissions.mockResolvedValue({ required: [cloud, SAVE], missing: [cloud], approvedAt: '2026-09-28T08:00:00Z' });
    ipc.approveWorkflowPermissions.mockResolvedValue({ required: [cloud, SAVE], missing: [], approvedAt: '2026-09-29T08:00:00Z' });
    render(<ScheduleSection workflowId="w1" onStatus={vi.fn()} />);
    const more = await screen.findByRole('group', { name: 'It needs your OK for more' });
    expect(more).toHaveTextContent('Send text to OpenAI, online');
    expect(more).not.toHaveTextContent('Save documents');
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'It needs your OK for more' })).not.toBeInTheDocument());
    expect(screen.getByText('When it runs on its own, it may: Send text to OpenAI, online · Save documents')).toBeInTheDocument();
  });
});
