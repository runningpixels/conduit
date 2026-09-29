import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ScheduleSpec, WorkflowSchedule } from '../ipc/contracts';

const ipc = vi.hoisted(() => ({ getWorkflowSchedule: vi.fn(), setWorkflowSchedule: vi.fn() }));
vi.mock('../ipc/client', () => ipc);

import { ScheduleSection } from './ScheduleSection';

beforeEach(() => {
  vi.clearAllMocks();
  ipc.getWorkflowSchedule.mockResolvedValue(null);
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
