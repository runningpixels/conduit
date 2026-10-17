import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { AgentEntry } from '../ipc/contracts';
import { AgentsPage, AGENTS_REFRESH_MS } from './AgentsPage';

const ipc = vi.hoisted(() => ({
  listAgents: vi.fn(),
  getWorkflow: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

const helper: AgentEntry = {
  workflowId: 'w1',
  workflowName: 'Weekly report',
  kind: 'helper',
  agentId: 'researcher',
  name: 'Researcher',
  about: 'Finds facts',
  model: { provider: 'openrouter', model: 'glm-flash' },
  tools: ['web_search', 'web_fetch'],
  handsTo: ['Writer'],
  currentTask: 'Look up the launch date',
  currentRunId: 'r1',
  lastActive: null,
  tasks: 1234,
  failed: 2,
  tokens: 56789,
};
const step: AgentEntry = {
  workflowId: 'w1',
  workflowName: 'Weekly report',
  kind: 'step',
  agentId: 'agent',
  name: '',
  about: 'Write the report',
  model: null,
  tools: [],
  handsTo: [],
  currentTask: null,
  currentRunId: null,
  lastActive: null,
  tasks: 0,
  failed: 0,
  tokens: 0,
};

beforeEach(() => {
  vi.useFakeTimers();
  ipc.getWorkflow.mockRejectedValue(new Error('no'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('AgentsPage', () => {
  it('shows a working helper, a step named by its workflow and the last 30 days', async () => {
    ipc.listAgents.mockResolvedValue([step, helper]);
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    const cards = screen.getAllByRole('button', { name: /Researcher|Weekly report/ });
    // Working agents come first.
    expect(cards[0].getAttribute('aria-label')).toBe('Researcher');
    expect(screen.getByText('Helper · Weekly report')).toBeTruthy();
    // The workflow's only agent step goes by the workflow's name, its prompt below.
    expect(screen.getByRole('button', { name: 'Weekly report' })).toBeTruthy();
    expect(screen.getByText('Agent step')).toBeTruthy();
    expect(screen.getByText('Write the report')).toBeTruthy();
    expect(screen.getByText('Working on: Look up the launch date')).toBeTruthy();
    expect(screen.getByRole('status').getAttribute('title')).toBe('Working on: Look up the launch date');
    expect(screen.getByText('Not used yet')).toBeTruthy();
    expect(screen.getByText('glm-flash')).toBeTruthy();
    expect(screen.getByText("Workflow's model")).toBeTruthy();
    expect(screen.getByText('2 tools')).toBeTruthy();
    expect(screen.getByText('Hands work to Writer')).toBeTruthy();
    expect(screen.getByText('1,234')).toBeTruthy();
    expect(screen.getByText('57K')).toBeTruthy();
  });

  it('names steps by their prompt when a workflow has several, and shows computer use', async () => {
    ipc.listAgents.mockResolvedValue([
      { ...step, tools: ['computer', 'web_search'] },
      { ...step, agentId: 'agent2', about: 'Check the numbers\nthen more' },
    ]);
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    expect(screen.getByRole('button', { name: 'Check the numbers' })).toBeTruthy();
    expect(screen.getAllByText('Agent step · Weekly report')).toHaveLength(2);
    expect(screen.getByText('Uses your computer')).toBeTruthy();
    expect(screen.getByText('1 tool')).toBeTruthy();
  });

  it('filters by search and by working or helper', async () => {
    ipc.listAgents.mockResolvedValue([helper, step]);
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /^Working/ }));
    expect(screen.queryByRole('button', { name: 'Weekly report' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Researcher' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search agents' }), { target: { value: 'nothing like it' } });
    expect(screen.getByText('No agents match “nothing like it”.')).toBeTruthy();
  });

  it('shows idle with the last-active time', async () => {
    ipc.listAgents.mockResolvedValue([{ ...helper, currentTask: null, lastActive: new Date(Date.now() - 3 * 3600_000).toISOString() }]);
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    expect(screen.getByText(/^Idle, last active/)).toBeTruthy();
  });

  it('opens the workflow', async () => {
    ipc.listAgents.mockResolvedValue([helper]);
    const open = vi.fn();
    render(<AgentsPage onOpenWorkflow={open} onOpenWorkflows={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Researcher' }));
    expect(open).toHaveBeenCalledWith('w1');
  });

  it('shows the empty state with a way to Workflows', async () => {
    ipc.listAgents.mockResolvedValue([]);
    const go = vi.fn();
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={go} />);
    await flush();
    expect(screen.getByText('No agents yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open Workflows' }));
    expect(go).toHaveBeenCalled();
  });

  it('refreshes every few seconds and stops on unmount', async () => {
    ipc.listAgents.mockResolvedValue([helper]);
    const { unmount } = render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    expect(ipc.listAgents).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(AGENTS_REFRESH_MS);
    });
    await flush();
    expect(ipc.listAgents).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => {
      vi.advanceTimersByTime(AGENTS_REFRESH_MS * 3);
    });
    expect(ipc.listAgents).toHaveBeenCalledTimes(2);
  });
});
