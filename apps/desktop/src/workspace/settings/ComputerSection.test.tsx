import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppSettings } from '../../ipc/contracts';

const ipc = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  previewCommandRule: vi.fn(),
  listWorkflows: vi.fn(),
  getWorkflow: vi.fn(),
  listBrowsers: vi.fn(),
  resetBrowserProfile: vi.fn(),
}));
vi.mock('../../ipc/client', () => ipc);

import { ComputerSection } from './ComputerSection';

const settings = (workflowComputer?: { enabled: boolean; deny: string[]; browser?: string }) => ({ workflowComputer }) as unknown as AppSettings;

beforeEach(() => {
  vi.resetAllMocks();
  ipc.listWorkflows.mockResolvedValue([]);
  ipc.listBrowsers.mockResolvedValue([
    { id: 'edge', name: 'Microsoft Edge' },
    { id: 'chrome', name: 'Google Chrome' },
  ]);
  ipc.resetBrowserProfile.mockResolvedValue(undefined);
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

  it('calls the global list “Always ask first” and suggests a rule worth asking about', () => {
    render(<ComputerSection settings={settings({ enabled: true, deny: [] })} onUpdate={vi.fn()} />);
    expect(screen.getByRole('group', { name: 'Always ask first (all workflows)' })).toBeInTheDocument();
    expect(screen.getByText(/asks every time in every workflow/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /New rule for/ })).toHaveAttribute('placeholder', 'git push *');
    expect(screen.queryByText(/never run/i)).toBeNull();
  });

  it('lists the workflows that use the computer, with their folders', async () => {
    const agent = { id: 'a', type: 'agent' as const, prompt: 'p', tools: ['computer'] };
    ipc.listWorkflows.mockResolvedValue([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]);
    ipc.getWorkflow.mockImplementation(async (id: string) =>
      id === 'w1'
        ? { id, name: 'Fix the shop', definition: { folder: 'C:/work/demo-shop', steps: [agent] } }
        : id === 'w2'
          ? { id, name: 'Briefing', definition: { steps: [{ id: 't', type: 'template', template: 'x' }] } }
          : { id, name: 'No folder yet', definition: { steps: [agent] } },
    );
    render(<ComputerSection settings={settings({ enabled: true, deny: [] })} onUpdate={vi.fn()} />);
    expect(await screen.findByText('Fix the shop · demo-shop')).toBeInTheDocument();
    expect(screen.getByText('No folder yet · no folder yet')).toBeInTheDocument();
    expect(screen.queryByText(/Briefing/)).toBeNull();
  });

  it('says when no workflow uses the computer', async () => {
    render(<ComputerSection settings={settings({ enabled: true, deny: [] })} onUpdate={vi.fn()} />);
    expect(await screen.findByText('No workflow uses the computer yet.')).toBeInTheDocument();
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

  describe('browser', () => {
    it('offers Automatic and the installed browsers, on Automatic by default', async () => {
      render(<ComputerSection settings={settings({ enabled: true, deny: [] })} onUpdate={vi.fn()} />);
      const select = screen.getByRole('combobox', { name: 'Browser' });
      expect(await screen.findByRole('option', { name: 'Microsoft Edge' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Google Chrome' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'Automatic' })).toBeInTheDocument();
      expect(select).toHaveValue('');
      expect(screen.queryByText(/No browser found/)).toBeNull();
    });

    it('saves the chosen browser with the switch and the rules', async () => {
      render(<ComputerSection settings={settings({ enabled: true, deny: ['rm *'] })} onUpdate={vi.fn()} />);
      await screen.findByRole('option', { name: 'Google Chrome' });
      fireEvent.change(screen.getByRole('combobox', { name: 'Browser' }), { target: { value: 'chrome' } });
      await waitFor(() =>
        expect(ipc.updateSettings).toHaveBeenCalledWith({
          workflowComputer: { enabled: true, deny: ['rm *'], browser: 'chrome' },
        }),
      );
    });

    it('going back to Automatic leaves the browser out', async () => {
      render(<ComputerSection settings={settings({ enabled: true, deny: [], browser: 'edge' })} onUpdate={vi.fn()} />);
      await screen.findByRole('option', { name: 'Microsoft Edge' });
      expect(screen.getByRole('combobox', { name: 'Browser' })).toHaveValue('edge');
      fireEvent.change(screen.getByRole('combobox', { name: 'Browser' }), { target: { value: '' } });
      await waitFor(() =>
        expect(ipc.updateSettings).toHaveBeenCalledWith({ workflowComputer: { enabled: true, deny: [] } }),
      );
    });

    it('keeps the browser when the switch is toggled', async () => {
      render(<ComputerSection settings={settings({ enabled: false, deny: ['rm *'], browser: 'edge' })} onUpdate={vi.fn()} />);
      fireEvent.click(screen.getByRole('checkbox', { name: 'Let workflows use this computer' }));
      await waitFor(() =>
        expect(ipc.updateSettings).toHaveBeenCalledWith({
          workflowComputer: { enabled: true, deny: ['rm *'], browser: 'edge' },
        }),
      );
    });

    it('says which browsers agents need when none is found', async () => {
      ipc.listBrowsers.mockResolvedValue([]);
      render(<ComputerSection settings={settings({ enabled: true, deny: [] })} onUpdate={vi.fn()} />);
      expect(await screen.findByText(/Microsoft Edge, Google Chrome, Brave or Chromium/)).toBeInTheDocument();
    });

    it('resets the profile and says so', async () => {
      render(<ComputerSection settings={settings({ enabled: true, deny: [] })} onUpdate={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Reset browser profile' }));
      expect(await screen.findByText('Browser profile reset.')).toBeInTheDocument();
      expect(ipc.resetBrowserProfile).toHaveBeenCalledTimes(1);
    });

    it('shows the translated error when the profile is in use', async () => {
      ipc.resetBrowserProfile.mockRejectedValue({ code: 'error.browser.inUse', params: {}, fallback: 'in use' });
      render(<ComputerSection settings={settings({ enabled: true, deny: [] })} onUpdate={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Reset browser profile' }));
      expect(await screen.findByText(/being used by a workflow/)).toBeInTheDocument();
    });
  });
});
