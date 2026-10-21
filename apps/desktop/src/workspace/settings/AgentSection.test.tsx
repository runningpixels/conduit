import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AgentSection } from './AgentSection';
import { listLibraryAgents } from '../../ipc/client';
import type { AppSettings } from '../../ipc/contracts';

vi.mock('../../ipc/client', () => ({ listLibraryAgents: vi.fn().mockResolvedValue([]) }));

function settingsWith(agent: AppSettings['agent']): AppSettings {
  return { agent } as AppSettings;
}

describe('AgentSection finish-after-document-write toggle', () => {
  it('is on when the setting has never been saved', () => {
    render(<AgentSection settings={settingsWith({ maxSteps: 25, wallClockBudgetSecs: 300 })} onUpdate={vi.fn()} onStatus={vi.fn()} />);
    expect(screen.getByLabelText(/Finish after writing a document/)).toBeChecked();
  });

  it('saves the choice with the other guardrails', () => {
    const onUpdate = vi.fn();
    render(<AgentSection settings={settingsWith({ maxSteps: 25, wallClockBudgetSecs: 300 })} onUpdate={onUpdate} onStatus={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(/Finish after writing a document/));
    expect(onUpdate).toHaveBeenCalledWith({
      agent: { maxSteps: 25, wallClockBudgetSecs: 300, finishAfterDocumentWrite: false },
    });
  });
});

describe('AgentSection hand-off agents', () => {
  const lib = (id: string, name: string, instructions: string) => ({
    agent: { id, name, instructions },
    createdAt: '',
    updatedAt: '',
    usedBy: [],
  });

  it('lists the library with a checkbox each, bound to the saved ids', async () => {
    vi.mocked(listLibraryAgents).mockResolvedValue([
      lib('researcher', 'Researcher', 'Find facts.\nCite them.'),
      lib('writer', 'Writer', 'Write it up.'),
    ] as never);
    const onUpdate = vi.fn();
    const agent = { maxSteps: 25, wallClockBudgetSecs: 300, handoffAgents: ['writer'] } as AppSettings['agent'];
    render(<AgentSection settings={settingsWith(agent)} onUpdate={onUpdate} onStatus={vi.fn()} />);

    expect(await screen.findByText('Agents the assistant can hand work to')).toBeInTheDocument();
    expect(screen.getByText('Find facts.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Writer/)).toBeChecked();
    expect(screen.getByLabelText(/Researcher/)).not.toBeChecked();

    fireEvent.click(screen.getByLabelText(/Researcher/));
    expect(onUpdate).toHaveBeenCalledWith({ agent: { ...agent, handoffAgents: ['writer', 'researcher'] } });
    fireEvent.click(screen.getByLabelText(/Writer/));
    expect(onUpdate).toHaveBeenLastCalledWith({ agent: { ...agent, handoffAgents: [] } });
  });

  it('points at the Agents page when the library is empty', async () => {
    vi.mocked(listLibraryAgents).mockResolvedValue([]);
    const onOpenAgents = vi.fn();
    render(
      <AgentSection
        settings={settingsWith({ maxSteps: 25, wallClockBudgetSecs: 300 } as AppSettings['agent'])}
        onUpdate={vi.fn()}
        onStatus={vi.fn()}
        onOpenAgents={onOpenAgents}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open Agents' }));
    expect(onOpenAgents).toHaveBeenCalled();
  });
});
