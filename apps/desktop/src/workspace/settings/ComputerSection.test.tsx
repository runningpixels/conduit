import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings } from '../../ipc/contracts';

const ipc = vi.hoisted(() => ({ updateSettings: vi.fn(), previewCommandRule: vi.fn() }));
vi.mock('../../ipc/client', () => ipc);

import { ComputerSection } from './ComputerSection';

const settings = (workflowComputer?: { enabled: boolean; deny: string[] }) => ({ workflowComputer }) as unknown as AppSettings;

beforeEach(() => {
  vi.resetAllMocks();
  ipc.previewCommandRule.mockResolvedValue({ error: null, covers: ['rm -rf x'], doesNotCover: ['rm file'] });
  ipc.updateSettings.mockImplementation(async (patch: Partial<AppSettings>) => patch as AppSettings);
});

describe('ComputerSection', () => {
  it('explains the limits and is off when nothing is saved', () => {
    render(<ComputerSection settings={settings()} onUpdate={vi.fn()} />);
    expect(screen.getByRole('checkbox', { name: 'Let workflows use this computer' })).not.toBeChecked();
    expect(screen.getByText('Agents work in a workflow’s folder.')).toBeInTheDocument();
    expect(screen.getByText('Commands ask first, unless a rule allows them.')).toBeInTheDocument();
    expect(screen.getByText(/Some commands always ask/)).toBeInTheDocument();
    expect(screen.getByText(/kept inside the workflow’s folder/)).toBeInTheDocument();
  });

  it('turns the switch on and keeps the deny rules', async () => {
    const onUpdate = vi.fn();
    render(<ComputerSection settings={settings({ enabled: false, deny: ['rm *'] })} onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Let workflows use this computer' }));
    await waitFor(() =>
      expect(ipc.updateSettings).toHaveBeenCalledWith({ workflowComputer: { enabled: true, deny: ['rm *'] } }),
    );
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
  });

  it('previews a deny rule while typing, then adds it', async () => {
    render(<ComputerSection settings={settings({ enabled: true, deny: [] })} onUpdate={vi.fn()} />);
    const box = screen.getByRole('textbox', { name: /New rule for/ });
    fireEvent.change(box, { target: { value: 'rm -rf *' } });
    expect(await screen.findByText('rm -rf x')).toBeInTheDocument();
    expect(screen.getByText('rm file')).toBeInTheDocument();
    expect(ipc.previewCommandRule).toHaveBeenCalledWith('rm -rf *');
    fireEvent.click(screen.getByRole('button', { name: /Add a rule to/ }));
    await waitFor(() =>
      expect(ipc.updateSettings).toHaveBeenCalledWith({ workflowComputer: { enabled: true, deny: ['rm -rf *'] } }),
    );
  });

  it('shows an unparseable rule inline and will not add it', async () => {
    ipc.previewCommandRule.mockResolvedValue({ error: 'A * may only end a rule', covers: [], doesNotCover: [] });
    render(<ComputerSection settings={settings({ enabled: true, deny: [] })} onUpdate={vi.fn()} />);
    fireEvent.change(screen.getByRole('textbox', { name: /New rule for/ }), { target: { value: 'a * b' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('A * may only end a rule');
    expect(screen.getByRole('button', { name: /Add a rule to/ })).toBeDisabled();
  });

  it('shows the backend error when a save is refused, and keeps the typed rule', async () => {
    ipc.updateSettings.mockRejectedValue({ message: 'Rule "x" does not parse' });
    render(<ComputerSection settings={settings({ enabled: true, deny: [] })} onUpdate={vi.fn()} />);
    const box = screen.getByRole('textbox', { name: /New rule for/ });
    fireEvent.change(box, { target: { value: 'x' } });
    await screen.findByText('rm -rf x');
    fireEvent.click(screen.getByRole('button', { name: /Add a rule to/ }));
    expect(await screen.findByText('Rule "x" does not parse')).toBeInTheDocument();
    expect(box).toHaveValue('x');
  });

  it('removes a rule', async () => {
    render(<ComputerSection settings={settings({ enabled: true, deny: ['rm *', 'sudo *'] })} onUpdate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove the rule rm *' }));
    await waitFor(() =>
      expect(ipc.updateSettings).toHaveBeenCalledWith({ workflowComputer: { enabled: true, deny: ['sudo *'] } }),
    );
  });
});
