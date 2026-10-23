import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { AgentCallChange, AgentEntry, LibraryAgent, RoutineSummary } from '../ipc/contracts';
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
  listRoutines: vi.fn(),
  setWorkflowSchedule: vi.fn(),
  createRoutine: vi.fn(),
  approveWorkflowPermissions: vi.fn(),
  deleteWorkflow: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
  listMemoryItems: vi.fn(),
  listKnowledgeCollections: vi.fn(),
  agentMemoryScope: (id: string) => `agent:${id}`,
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
  notes: 0,
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
  notes: 0,
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
  ipc.listRoutines.mockResolvedValue([]);
  ipc.setWorkflowSchedule.mockResolvedValue(null);
  ipc.listMemoryItems.mockResolvedValue([]);
  ipc.listKnowledgeCollections.mockResolvedValue([]);
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
    expect(screen.getByText('Default model')).toBeTruthy();
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

  it('starts a chat with an agent from Ask', async () => {
    ipc.listLibraryAgents.mockResolvedValue([writer]);
    ipc.listAgents.mockResolvedValue([]);
    const onAskAgent = vi.fn();
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} onAskAgent={onAskAgent} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Start a chat with Writer' }));
    expect(onAskAgent).toHaveBeenCalledWith({ id: writer.agent.id, name: 'Writer' });
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

describe('AgentsPage task links', () => {
  it('opens the run a workflow agent is working in, not just the workflow', async () => {
    ipc.listAgents.mockResolvedValue([helper]);
    const onOpenWorkflow = vi.fn();
    render(<AgentsPage onOpenWorkflow={onOpenWorkflow} onOpenWorkflows={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('link', { name: 'Working on: Look up the launch date' }));
    expect(onOpenWorkflow).toHaveBeenCalledTimes(1);
    expect(onOpenWorkflow).toHaveBeenCalledWith('w1', 'r1');
  });

  it('still opens the workflow from the rest of the card', async () => {
    ipc.listAgents.mockResolvedValue([helper]);
    const onOpenWorkflow = vi.fn();
    render(<AgentsPage onOpenWorkflow={onOpenWorkflow} onOpenWorkflows={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Researcher' }));
    expect(onOpenWorkflow).toHaveBeenCalledWith('w1');
  });

  it('is plain text when the task has no run to open', async () => {
    ipc.listAgents.mockResolvedValue([{ ...helper, currentRunId: null }]);
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Working on: Look up the launch date')).toBeTruthy();
  });

  it("opens the chat one of the user's agents is working in", async () => {
    ipc.listAgents.mockResolvedValue([]);
    ipc.listLibraryAgents.mockResolvedValue([
      { ...researcher, chat: { ...researcher.chat, currentTask: 'Compare the plans', currentConversationId: 'c42' } },
    ]);
    const onOpenConversation = vi.fn();
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} onOpenConversation={onOpenConversation} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Working on: Compare the plans' }));
    expect(onOpenConversation).toHaveBeenCalledWith('c42');
  });

  it("opens the run one of the user's agents is working in inside a workflow", async () => {
    ipc.listAgents.mockResolvedValue([{ ...helper, library: 'researcher' }]);
    ipc.listLibraryAgents.mockResolvedValue([researcher]);
    const onOpenWorkflow = vi.fn();
    render(<AgentsPage onOpenWorkflow={onOpenWorkflow} onOpenWorkflows={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Working on: Look up the launch date' }));
    expect(onOpenWorkflow).toHaveBeenCalledWith('w1', 'r1');
  });
});

describe('Running now', () => {
  const row = (extra: Partial<AgentCallChange>): AgentCallChange => ({
    id: 'call-1',
    kind: 'helper',
    agentId: 'researcher',
    name: 'Researcher',
    task: 'Compare the plans',
    status: 'running',
    conversationId: 'c42',
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    ...extra,
  });

  it('is not there while nothing runs', async () => {
    ipc.listAgents.mockResolvedValue([]);
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    expect(screen.queryByText('Running now')).toBeNull();
  });

  it('lists each agent at work with its task, where and for how long', async () => {
    ipc.listAgents.mockResolvedValue([helper]);
    render(
      <AgentsPage
        onOpenWorkflow={() => {}}
        onOpenWorkflows={() => {}}
        running={[
          row({}),
          row({ id: 'call-2', kind: 'step', name: 'Writer', task: 'Write it', conversationId: null, runId: 'r1', workflowId: 'w1' }),
        ]}
        chatTitle={(id) => (id === 'c42' ? 'Plans' : null)}
      />,
    );
    await flush();
    const list = screen.getByRole('list', { name: 'Running now' });
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Researcher');
    expect(rows[0]).toHaveTextContent('Compare the plans');
    expect(rows[0]).toHaveTextContent('In Plans');
    expect(rows[0]).toHaveTextContent('1m');
    // The workflow's name comes from the page's own list.
    expect(rows[1]).toHaveTextContent('In Weekly report');
  });

  it("opens a chat helper's view, and a workflow agent's run", async () => {
    ipc.listAgents.mockResolvedValue([]);
    const onOpenAgent = vi.fn();
    const onOpenWorkflow = vi.fn();
    render(
      <AgentsPage
        onOpenWorkflow={onOpenWorkflow}
        onOpenWorkflows={() => {}}
        onOpenAgent={onOpenAgent}
        running={[row({}), row({ id: 'call-2', conversationId: null, runId: 'r1', workflowId: 'w1', task: 'Write it' })]}
      />,
    );
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Open Researcher: Compare the plans' }));
    expect(onOpenAgent).toHaveBeenCalledWith('c42', 'call-1');
    fireEvent.click(screen.getByRole('button', { name: 'Open Researcher: Write it' }));
    expect(onOpenWorkflow).toHaveBeenCalledWith('w1', 'r1');
    // Without a name for the chat it still says where.
    expect(screen.getByText('In a chat')).toBeTruthy();
  });
});

describe('Memory and knowledge chips', () => {
  const withDef = (agent: LibraryAgent, def: Partial<LibraryAgent['agent']>, notes = 0): LibraryAgent => ({
    ...agent,
    notes,
    agent: { ...agent.agent, ...def },
  });

  beforeEach(() => {
    ipc.listAgents.mockResolvedValue([]);
  });

  it('shows how many notes an agent that remembers keeps, and how many collections it reads', async () => {
    ipc.listLibraryAgents.mockResolvedValue([
      withDef(writer, { memory: true, knowledge: ['c1', 'c2'] }, 3),
      withDef(researcher, { memory: true }, 1),
    ]);
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    const w = within(screen.getByRole('group', { name: 'Writer' }));
    expect(w.getByText('Remembers · 3 notes')).toBeTruthy();
    expect(w.getByText('Reads 2 collections')).toBeTruthy();
    const r = within(screen.getByRole('group', { name: 'Researcher' }));
    expect(r.getByText('Remembers · 1 note')).toBeTruthy();
    expect(r.queryByText(/^Reads/)).toBeNull();
  });

  it('says only "Remembers" before it has any notes', async () => {
    ipc.listLibraryAgents.mockResolvedValue([withDef(writer, { memory: true })]);
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    expect(within(screen.getByRole('group', { name: 'Writer' })).getByText('Remembers')).toBeTruthy();
  });

  it('shows neither chip when memory is off and nothing is read', async () => {
    ipc.listLibraryAgents.mockResolvedValue([withDef(writer, {}, 5)]);
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    const w = within(screen.getByRole('group', { name: 'Writer' }));
    expect(w.queryByText(/^Remembers/)).toBeNull();
    expect(w.queryByText(/^Reads/)).toBeNull();
  });
});

describe('Routines', () => {
  const brief: RoutineSummary = {
    workflowId: 'wf-r1',
    agentId: 'researcher',
    name: 'Energy brief',
    task: 'Brief me on EU energy prices',
    schedule: { kind: 'weekdays', time: '08:00' },
    trigger: null,
    folder: null,
    enabled: true,
    nextRunAt: '2026-10-23T06:00:00Z',
    lastRunId: 'run-9',
    lastRunStatus: 'completed',
    lastRunAt: new Date(Date.now() - 3600_000).toISOString(),
    lastResultTitle: 'Energy brief — 2026-10-22',
  };
  const inbox: RoutineSummary = {
    ...brief,
    workflowId: 'wf-r2',
    name: 'New files',
    schedule: { kind: 'trigger' },
    trigger: { kind: 'folder' },
    folder: 'C:\Inbox',
    enabled: false,
    nextRunAt: null,
    lastRunId: null,
    lastRunStatus: null,
    lastRunAt: null,
    lastResultTitle: null,
  };

  beforeEach(() => {
    ipc.listAgents.mockResolvedValue([]);
    ipc.listLibraryAgents.mockResolvedValue([writer, researcher]);
    ipc.listRoutines.mockResolvedValue([brief, inbox]);
  });

  it("lists each agent's routines on its card: when, next run or paused, and the last result", async () => {
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    const card = screen.getByRole('group', { name: 'Researcher' });
    const list = within(card).getByRole('list', { name: 'Routines of Researcher' });
    expect(within(list).getByText('Energy brief')).toBeTruthy();
    expect(within(list).getByText(/^Weekdays at 08:00 · next /)).toBeTruthy();
    expect(within(list).getByText(/^Last: Energy brief — 2026-10-22, /)).toBeTruthy();
    expect(within(list).getByText('When a new file arrives · paused')).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Writer' })).queryByRole('list')).toBeNull();
  });

  it('pauses and resumes a routine, and opens it on its last run', async () => {
    const open = vi.fn();
    render(<AgentsPage onOpenWorkflow={open} onOpenWorkflows={() => {}} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Pause Energy brief' }));
    expect(ipc.setWorkflowSchedule).toHaveBeenCalledWith('wf-r1', { kind: 'weekdays', time: '08:00' }, false);
    fireEvent.click(screen.getByRole('button', { name: 'Resume New files' }));
    expect(ipc.setWorkflowSchedule).toHaveBeenCalledWith('wf-r2', { kind: 'trigger' }, true);
    fireEvent.click(screen.getByRole('button', { name: 'Open Energy brief' }));
    expect(open).toHaveBeenCalledWith('wf-r1', 'run-9');
    fireEvent.click(screen.getByRole('button', { name: 'Open New files' }));
    expect(open).toHaveBeenCalledWith('wf-r2', undefined);
  });

  it('filters to the agents that have routines', async () => {
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    const chip = screen.getByRole('button', { name: /^Routines/ });
    expect(within(chip).getByText('2')).toBeTruthy();
    fireEvent.click(chip);
    expect(screen.getByRole('group', { name: 'Researcher' })).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Writer' })).toBeNull();
  });

  it('opens the routine form from "Run on a schedule…" under Routines, even on a card with none yet', async () => {
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    const card = screen.getByRole('group', { name: 'Writer' });
    // The card's own actions stay Edit, Duplicate and Delete.
    const actions = card.querySelector('.agent-actions') as HTMLElement;
    expect(within(actions).getAllByRole('button').map((b) => b.textContent)).toEqual(['Edit', 'Duplicate', 'Delete']);
    expect(within(card).getByText('Routines')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run Writer on a schedule' }));
    expect(screen.getByRole('dialog', { name: 'Run Writer on a schedule' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('still shows the cards when routines cannot be read', async () => {
    ipc.listRoutines.mockRejectedValue(new Error('no'));
    render(<AgentsPage onOpenWorkflow={() => {}} onOpenWorkflows={() => {}} />);
    await flush();
    expect(screen.getByRole('group', { name: 'Researcher' })).toBeTruthy();
    expect(screen.queryByText('Energy brief')).toBeNull();
  });
});
