import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AgentCallRow } from '../ipc/contracts';
import { AgentTree, buildAgentTree, rowsOfStep, usageOfRows } from './AgentTree';
import { HelperTotals } from '../agents/HelperTotals';

const ipc = vi.hoisted(() => ({
  listProviderDescriptors: vi.fn(),
  resolveModelPrices: vi.fn(),
  stopAgentCall: vi.fn(),
  redirectAgentCall: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

beforeEach(() => {
  vi.clearAllMocks();
  ipc.listProviderDescriptors.mockResolvedValue([{ id: 'p', displayName: 'ProvCo' }]);
  ipc.resolveModelPrices.mockImplementation(async (_provider: string, ids: string[]) =>
    ids.map((id) => (id === 'm' ? { price: { inputPerMtok: 1, outputPerMtok: 2 }, source: 'override' } : null)),
  );
  ipc.stopAgentCall.mockResolvedValue(undefined);
  ipc.redirectAgentCall.mockResolvedValue(undefined);
});

function row(id: string, extra: Partial<AgentCallRow> = {}): AgentCallRow {
  return {
    id,
    parentId: null,
    kind: 'helper',
    stepId: 'research',
    agentId: id,
    name: id.toUpperCase(),
    task: `Task of ${id}`,
    model: 'p/m',
    status: 'done',
    tokens: 300,
    inputTokens: 200,
    outputTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    startedAt: '2026-10-21T08:00:00Z',
    finishedAt: '2026-10-21T08:00:05Z',
    ...extra,
  };
}

const rows: AgentCallRow[] = [
  row('lead', { kind: 'step', tokens: 1000, inputTokens: 800, outputTokens: 200 }),
  row('a', { parentId: 'lead', status: 'running', finishedAt: null, startedAt: '2026-10-21T08:00:01Z' }),
  row('b', { parentId: 'lead', startedAt: '2026-10-21T08:00:02Z', model: 'p/other' }),
  row('deep', { parentId: 'a', status: 'running', finishedAt: null, startedAt: '2026-10-21T08:00:03Z' }),
];

describe('buildAgentTree', () => {
  it('nests by parent id, oldest first, and roots a row whose parent is missing', () => {
    const tree = buildAgentTree([...rows].reverse().concat(row('orphan', { parentId: 'gone' })));
    expect(tree.map((n) => n.row.id)).toEqual(['lead', 'orphan']);
    expect(tree[0].children.map((n) => n.row.id)).toEqual(['a', 'b']);
    expect(tree[0].children[0].children.map((n) => n.row.id)).toEqual(['deep']);
  });

  it('picks the rows of a step, telling repeats of a loop apart by time', () => {
    const all = [row('x'), row('y', { stepId: 'other' }), row('z', { startedAt: '2026-10-21T09:00:00Z' })];
    expect(rowsOfStep(all, { stepId: 'research', iteration: null, startedAt: '', finishedAt: null }).map((r) => r.id)).toEqual(['x', 'z']);
    expect(
      rowsOfStep(all, { stepId: 'research', iteration: 1, startedAt: '2026-10-21T08:30:00Z', finishedAt: null }).map((r) => r.id),
    ).toEqual(['z']);
  });
});

describe('AgentTree', () => {
  it('shows each node with provider, model, status, tokens and cost, nested', async () => {
    const { container } = render(<AgentTree rows={rows} />);
    const nodes = container.querySelectorAll('li.agent-tree-node');
    expect(nodes).toHaveLength(4);
    const lead = nodes[0] as HTMLElement;
    // The lead's children sit inside its own list item.
    expect(within(lead).getByText('A')).toBeInTheDocument();
    expect(within(lead).getByText('DEEP')).toBeInTheDocument();
    expect(await screen.findAllByText('ProvCo')).toHaveLength(4);
    expect(within(lead).getAllByText('Working')).toHaveLength(2);
    // The lead used 800 in and 200 out at $1 and $2 per million.
    await waitFor(() => expect(lead.querySelector('.agent-tree-nums')?.textContent).toContain('1,000 tokens · $0.0012'));
    // "other" has no price, so its line shows tokens only.
    const b = Array.from(nodes).find((n) => n.textContent?.startsWith('B'))!;
    expect(b.querySelector('.agent-tree-nums')?.textContent).not.toContain('$');
    expect(screen.getByText('Task of deep')).toBeInTheDocument();
  });

  it('offers Stop and Redirect on running helpers only', () => {
    render(<AgentTree rows={[...rows, row('lead2', { kind: 'step', status: 'running', finishedAt: null })]} />);
    expect(screen.getByRole('button', { name: 'Stop A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop DEEP' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop B' })).toBeNull();
    // A running step is not a helper: it has no controls.
    expect(screen.queryByRole('button', { name: 'Stop LEAD2' })).toBeNull();
  });

  it('stops and redirects a helper by its row id', async () => {
    render(<AgentTree rows={rows} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop A' }));
    await waitFor(() => expect(ipc.stopAgentCall).toHaveBeenCalledWith('a'));
    fireEvent.click(screen.getByRole('button', { name: 'Redirect DEEP' }));
    const field = screen.getByRole('textbox', { name: 'New instruction for DEEP' });
    fireEvent.change(field, { target: { value: 'Try another source' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(ipc.redirectAgentCall).toHaveBeenCalledWith('deep', 'Try another source'));
  });

  it('renders nothing without rows', () => {
    const { container } = render(<AgentTree rows={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('run totals by model', () => {
  it('equal the sum of the nodes', async () => {
    const { container } = render(<HelperTotals nodes={usageOfRows(rows)} title="Agents in this run" />);
    const lines = () => Array.from(container.querySelectorAll('.helper-totals-line')).map((l) => l.textContent);
    // m: 1000 + 300 + 300 = 1,600 tokens (1200 in, 400 out); other: 300.
    await waitFor(() => expect(lines()[0]).toContain('$'));
    expect(lines()).toEqual(['ProvCom1,600 tokens · $0.002', 'ProvCoother300 tokens', 'Total1,900 tokens']);
    const sum = rows.reduce((n, r) => n + r.tokens, 0);
    expect(sum).toBe(1900);
  });
});
