import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { AgentEntry, LibraryAgent } from '../ipc/contracts';
import { AgentsPage, AGENTS_REFRESH_MS } from './AgentsPage';

const ipc = vi.hoisted(() => ({
  listAgents: vi.fn(),
  listLibraryAgents: vi.fn(),
  createLibraryAgent: vi.fn(),
  deleteLibraryAgent: vi.fn(),
  updateLibraryAgent: vi.fn(),
  validateLibraryAgent: vi.fn(),
  getWorkflow: vi.fn(),
  listProviderDescriptors: vi.fn(),
  listConfiguredProviders: vi.fn(),
  listProviderModels: vi.fn(),
  getSettings: vi.fn(),
  listInstalledConnectors: vi.fn(),
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

const writer: LibraryAgent = {
  agent: {
    id: 'writer',
    name: 'Writer',
    instructions: 'Write it up.\nKeep it short.',
    tools: ['computer', 'calculator'],
    agents: ['researcher'],
  },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  usedBy: [
    { workflowId: 'w1', workflowName: 'Weekly report' },
    { workflowId: 'w2', workflowName: 'Digest' },
  ],
  chat: { tasks: 0, failed: 0, tokens: 0, lastActive: null, currentTask: null, currentConversationId: null },
};
const researcher: LibraryAgent = {
  agent: { id: 'researcher', name: 'Researcher', instructions: 'Find facts', tools: [] },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
  usedBy: [],
  chat: { tasks: 0, failed: 0, tokens: 0, lastActive: null, currentTask: null, currentConversationId: null },
};

beforeEach(() => {
  vi.useFakeTimers();
  ipc.getWorkflow.mockRejectedValue(new Error('no'));
  ipc.listLibraryAgents.mockResolvedValue([]);
  ipc.validateLibraryAgent.mockResolvedValue([]);
  ipc.listProviderDescriptors.mockResolvedValue([]);
  ipc.listConfiguredProviders.mockResolvedValue([]);
  ipc.listProviderModels.mockResolvedValue([]);
  ipc.getSettings.mockResolvedValue({ activeProvider: 'anthropic', activeModel: 'claude-x' });
  ipc.listInstalledConnectors.mockResolvedValue([]);
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

  it('shows an empty library as a section with a way to make an agent, and a way to Workflows', async () => {
    ipc.listAgents.mockResolvedValue([]);
    const go = vi.fn();
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={go} />);
    await flush();
    expect(screen.getByRole('heading', { name: 'Your agents' })).toBeTruthy();
    expect(screen.getByText(/You haven’t made an agent yet/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New agent' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'In workflows' })).toBeTruthy();
    // Nothing to search or filter yet.
    expect(screen.queryByRole('searchbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open Workflows' }));
    expect(go).toHaveBeenCalled();
  });

  it("shows your agents with their copies' activity, apart from the ones in workflows", async () => {
    ipc.listLibraryAgents.mockResolvedValue([writer, researcher]);
    ipc.listAgents.mockResolvedValue([
      { ...helper, agentId: 'writer', library: 'writer', name: 'Writer', tasks: 4, failed: 1, tokens: 1500, currentTask: 'Draft the intro' },
      { ...helper, workflowId: 'w2', agentId: 'writer', library: 'writer', name: 'Writer', tasks: 2, failed: 0, tokens: 500, currentTask: null },
      step,
    ]);
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    const mine = screen.getByRole('group', { name: 'Writer' });
    expect(within(mine).getByText('Used in 2 workflows')).toBeTruthy();
    expect(within(mine).getByText('Write it up.')).toBeTruthy();
    expect(within(mine).getByText('Working on: Draft the intro')).toBeTruthy();
    expect(within(mine).getByText('Uses your computer')).toBeTruthy();
    expect(within(mine).getByText('Hands work to Researcher')).toBeTruthy();
    // 4 + 2 tasks, 1500 + 500 tokens.
    expect(within(mine).getByText('6')).toBeTruthy();
    expect(within(mine).getByText('2K')).toBeTruthy();
    const other = screen.getByRole('group', { name: 'Researcher' });
    expect(within(other).getByText('Not used in a workflow yet')).toBeTruthy();
    // The workflow copies are not listed a second time under "In workflows".
    expect(screen.getAllByRole('button', { name: 'Weekly report' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Writer' })).toBeNull();
  });

  it('adds chat work to the card: tasks, tokens, working on and last active', async () => {
    const chatWriter = {
      ...writer,
      chat: { tasks: 3, failed: 1, tokens: 3000, lastActive: '2026-10-20T10:00:00Z', currentTask: 'Summarise the thread', currentConversationId: 'c9' },
    };
    ipc.listLibraryAgents.mockResolvedValue([chatWriter]);
    ipc.listAgents.mockResolvedValue([
      { ...helper, agentId: 'writer', library: 'writer', name: 'Writer', tasks: 4, failed: 0, tokens: 1500, currentTask: null },
    ]);
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    const mine = screen.getByRole('group', { name: 'Writer' });
    expect(within(mine).getByText('Working on: Summarise the thread')).toBeTruthy();
    // 4 + 3 tasks, 1500 + 3000 tokens.
    expect(within(mine).getByText('7')).toBeTruthy();
    expect(within(mine).getByText('5K')).toBeTruthy();
  });

  it('opens the editor from New agent and Edit', async () => {
    ipc.listLibraryAgents.mockResolvedValue([writer, researcher]);
    ipc.listAgents.mockResolvedValue([]);
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'New agent' }));
    expect(screen.getByRole('dialog', { name: 'New agent' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Writer' }));
    expect(screen.getByRole('dialog', { name: 'Edit agent' })).toBeTruthy();
    expect(screen.getByDisplayValue('Writer')).toBeTruthy();
  });

  it('duplicates an agent with an empty id so the backend makes a new one', async () => {
    ipc.listLibraryAgents.mockResolvedValue([writer]);
    ipc.listAgents.mockResolvedValue([]);
    ipc.createLibraryAgent.mockResolvedValue(writer);
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Writer' }));
    await flush();
    expect(ipc.createLibraryAgent).toHaveBeenCalledWith({ ...writer.agent, id: '', name: 'Writer copy' });
  });

  it('asks before deleting and says workflows keep their copy', async () => {
    ipc.listLibraryAgents.mockResolvedValue([writer]);
    ipc.listAgents.mockResolvedValue([]);
    ipc.deleteLibraryAgent.mockResolvedValue(2);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Writer' }));
    expect(confirm).toHaveBeenCalledWith('Delete “Writer”? Workflows that use it keep their own copy.');
    expect(ipc.deleteLibraryAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Writer' }));
    await flush();
    expect(ipc.deleteLibraryAgent).toHaveBeenCalledWith('writer');
    confirm.mockRestore();
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
