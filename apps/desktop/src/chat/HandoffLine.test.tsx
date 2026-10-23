import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HandoffLine, HandoffTotals } from './HandoffLine';
import { TurnBody } from './TurnBody';
import { createAssistantStreamState, type HandoffState, type ToolCallState } from './streamState';

const ipc = vi.hoisted(() => ({
  approveConnectorToolCall: vi.fn(),
  denyConnectorToolCall: vi.fn(),
  listProviderDescriptors: vi.fn(),
  resolveModelPrices: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

const PRICE = { price: { inputPerMtok: 1, outputPerMtok: 2 }, source: 'override' };

beforeEach(() => {
  vi.clearAllMocks();
  ipc.listProviderDescriptors.mockResolvedValue([{ id: 'p', displayName: 'ProvCo' }]);
  // Only the model "m" has a price; any other is unpriced.
  ipc.resolveModelPrices.mockImplementation(async (_provider: string, ids: string[]) =>
    ids.map((id) => (id === 'm' ? PRICE : null)),
  );
});

function call(id: string, name: string, extra: Partial<ToolCallState> = {}): ToolCallState {
  return { toolCallId: id, toolId: name, name, argumentsText: '', complete: true, startedAt: 0, endedAt: 10, ...extra };
}

function handoff(extra: Partial<HandoffState> = {}): HandoffState {
  return {
    agentId: 'researcher',
    name: 'Researcher',
    task: 'Compare X and Y',
    model: 'p/m',
    status: 'done',
    tokens: 1234,
    usage: { inputTokens: 1000, outputTokens: 234, cacheReadTokens: 0, cacheWriteTokens: 0 },
    callId: '',
    helperRequestId: 'hr1',
    startedAt: 0,
    endedAt: 5000,
    inner: { ...createAssistantStreamState('r'), streaming: false },
    ...extra,
  };
}

function lead(h: HandoffState, id = 'tc1'): ToolCallState {
  return call(id, 'ask_researcher', { handoff: h });
}

const running = (extra: Partial<HandoffState> = {}) =>
  handoff({ status: 'running', endedAt: undefined, tokens: 0, inner: createAssistantStreamState('r'), ...extra });

describe('HandoffLine', () => {
  it('is one row: agent, task, status, tokens and time', () => {
    const { container } = render(<HandoffLine toolCall={lead(handoff())} />);
    const row = screen.getByRole('button', { name: /Open Researcher/ });
    expect(row).toHaveTextContent('Researcher');
    expect(row).toHaveTextContent('Compare X and Y');
    expect(row).toHaveTextContent('Done');
    expect(container.querySelector('.handoff-line-nums')?.textContent).toContain('1,234 tokens');
    expect(container.querySelector('.handoff-line-nums')?.textContent).toContain('5');
    // The full task is a hover away when the line shortens it.
    expect(row).toHaveAttribute('title', 'Compare X and Y');
    // The agent's own work is not in the main thread.
    expect(container.querySelector('.tool')).toBeNull();
  });

  it('prices the tokens, and shows no cost for a model without a price', async () => {
    const { container, rerender } = render(<HandoffLine toolCall={lead(handoff())} />);
    // 1000 in at $1 and 234 out at $2 per million tokens.
    await waitFor(() => expect(container.querySelector('.handoff-line-nums')?.textContent).toContain('$0.0015'));
    rerender(<HandoffLine toolCall={lead(handoff({ model: 'p/unpriced' }))} />);
    await waitFor(() => expect(container.querySelector('.handoff-line-nums')?.textContent).not.toContain('$'));
  });

  it('says Working while it runs and Failed when it failed', () => {
    const { rerender } = render(<HandoffLine toolCall={lead(running())} />);
    expect(screen.getByText('Working')).toBeInTheDocument();
    rerender(<HandoffLine toolCall={lead(handoff({ status: 'failed', error: 'Out of tokens.' }))} />);
    expect(screen.getByText('Failed')).toHaveAttribute('data-status', 'failed');
  });

  it('opens the agent view from the whole row', () => {
    const onOpen = vi.fn();
    render(<HandoffLine toolCall={lead(handoff())} onOpen={onOpen} />);
    fireEvent.click(screen.getByText('Compare X and Y'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('says it needs your approval, with Review, when a call inside waits on one', () => {
    const onOpen = vi.fn();
    const pending = call('inner1', 'Echo__post', { complete: false, sideEffecting: true, consent: 'pending' });
    const inner = {
      ...createAssistantStreamState('r'),
      toolCalls: [pending],
      segments: [{ kind: 'tool' as const, toolCallId: 'inner1' }],
    };
    const { container } = render(<HandoffLine toolCall={lead(running({ inner }))} onOpen={onOpen} />);
    expect(screen.getByText('Needs your approval')).toBeInTheDocument();
    // The approval card itself waits in the agent view, not the main thread.
    expect(container.querySelector('.consent')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("counts a nested helper's approval too", () => {
    const pending = call('inner2', 'Echo__post', { complete: false, sideEffecting: true, consent: 'pending' });
    const nested = call('tc2', 'ask_writer', {
      handoff: running({ name: 'Writer', inner: { ...createAssistantStreamState('w'), toolCalls: [pending] } }),
    });
    const inner = { ...createAssistantStreamState('r'), toolCalls: [nested] };
    render(<HandoffLine toolCall={lead(running({ inner }))} />);
    expect(screen.getByText('Needs your approval')).toBeInTheDocument();
  });
});

describe('hand-offs in a turn', () => {
  const turn = (calls: ToolCallState[]) => ({
    ...createAssistantStreamState('r'),
    toolCalls: calls,
    segments: calls.map((c) => ({ kind: 'tool' as const, toolCallId: c.toolCallId })),
  });

  it('puts "Waiting for N agents" above helpers that run side by side', () => {
    const state = turn([lead(running(), 'a'), lead(running({ name: 'Writer' }), 'b'), lead(handoff(), 'c')]);
    const { container } = render(<TurnBody state={state} />);
    expect(screen.getByText('Waiting for 2 agents')).toBeInTheDocument();
    const lines = container.querySelectorAll('.handoff-line');
    expect(lines).toHaveLength(3);
    // The label comes before the lines.
    expect(container.querySelector('.handoff-waiting')?.compareDocumentPosition(lines[0])).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it('has no label for a single running helper', () => {
    render(<TurnBody state={turn([lead(running(), 'a'), lead(handoff(), 'b')])} />);
    expect(screen.queryByText(/Waiting for/)).toBeNull();
  });

  it('leaves hand-offs out of the step line: they have their own lines', () => {
    const { container, rerender } = render(<TurnBody state={turn([lead(running(), 'a'), lead(running(), 'b')])} />);
    expect(container.querySelector('.turn-step-block')).toBeNull();
    // Another tool call is a step; the hand-offs still aren't.
    rerender(<TurnBody state={turn([call('s', 'web_search'), lead(running(), 'a'), lead(handoff(), 'b')])} />);
    const rows = container.querySelectorAll('.turn-step-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('web_search');
    expect(container.querySelectorAll('.handoff-line')).toHaveLength(2);
  });

  it('opens a hand-off by its tool call id', () => {
    const onOpenHandoff = vi.fn();
    render(<TurnBody state={turn([lead(handoff(), 'tc9')])} onOpenHandoff={onOpenHandoff} />);
    fireEvent.click(screen.getByRole('button', { name: /Open Researcher/ }));
    expect(onOpenHandoff).toHaveBeenCalledWith('tc9');
  });
});

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

describe('Helpers total under a message', () => {
  it('splits by model and equals the sum of the nodes, nested ones included', async () => {
    const nestedCall = call('tc2', 'ask_writer', {
      handoff: handoff({ model: 'p/other', tokens: 500, usage: usage(400, 100) }),
    });
    const innerState = {
      ...createAssistantStreamState('r'),
      toolCalls: [nestedCall],
      segments: [{ kind: 'tool' as const, toolCallId: 'tc2' }],
    };
    const first = call('tc1', 'ask_researcher', {
      handoff: handoff({ model: 'p/m', tokens: 1000, usage: usage(800, 200), inner: innerState }),
    });
    const second = call('tc3', 'ask_researcher', { handoff: handoff({ model: 'p/m', tokens: 300, usage: usage(200, 100) }) });
    const state = { ...createAssistantStreamState('r'), toolCalls: [first, second] };
    const { container } = render(<HandoffTotals state={state} />);
    const lines = () => Array.from(container.querySelectorAll('.helper-totals-line')).map((l) => l.textContent);
    // m: 1000 in at $1 + 300 out at $2 per million = $0.0016; "other" has no price.
    await waitFor(() => expect(lines()[0]).toContain('$0.0016'));
    expect(lines()).toEqual(['ProvCom1,300 tokens · $0.0016', 'ProvCoother500 tokens', 'Total1,800 tokens']);
  });

  it('prices the total when every model has a price', async () => {
    const a = call('tc1', 'ask_researcher', { handoff: handoff({ model: 'p/m', tokens: 1000, usage: usage(800, 200) }) });
    const b = call('tc2', 'ask_researcher', { handoff: handoff({ model: 'p/m', tokens: 300, usage: usage(200, 100) }) });
    const { container } = render(<HandoffTotals state={{ ...createAssistantStreamState('r'), toolCalls: [a, b] }} />);
    await waitFor(() => expect(container.textContent).toContain('$0.0016'));
    // One model: a single line, which is the total.
    expect(container.querySelectorAll('.helper-totals-line')).toHaveLength(1);
    expect(container.textContent).toContain('1,300 tokens');
  });

  it('renders nothing without hand-offs', () => {
    const { container } = render(<HandoffTotals state={createAssistantStreamState('r')} />);
    expect(container.firstChild).toBeNull();
  });
});
