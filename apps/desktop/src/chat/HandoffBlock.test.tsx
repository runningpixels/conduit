import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HandoffBlock, HandoffTotals } from './HandoffBlock';
import { createAssistantStreamState, type HandoffState, type ToolCallState } from './streamState';

const ipc = vi.hoisted(() => ({
  approveConnectorToolCall: vi.fn(),
  denyConnectorToolCall: vi.fn(),
  listProviderDescriptors: vi.fn(),
  resolveModelPrices: vi.fn(),
  stopAgentCall: vi.fn(),
  redirectAgentCall: vi.fn(),
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
  ipc.stopAgentCall.mockResolvedValue(undefined);
  ipc.redirectAgentCall.mockResolvedValue(undefined);
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

function lead(h: HandoffState): ToolCallState {
  return call('tc1', 'ask_researcher', { handoff: h });
}

describe('HandoffBlock', () => {
  it('shows agent, task, status, model, tokens and elapsed time on the head', () => {
    render(<HandoffBlock toolCall={lead(handoff())} />);
    expect(screen.getByText('Researcher')).toBeInTheDocument();
    const summary = screen.getByText(/Compare X and Y · Done · m ·/);
    expect(summary.textContent).toContain('1,234 tokens');
    expect(summary.textContent).toContain('5');
    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument();
  });

  it('is open and says Working while it runs', () => {
    const running = handoff({ status: 'running', endedAt: undefined, tokens: 0, inner: createAssistantStreamState('r') });
    render(<HandoffBlock toolCall={lead(running)} />);
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(screen.getAllByText(/Working/).length).toBeGreaterThan(0);
  });

  it('shows the helper answer text and its tool calls in the body', () => {
    const inner = {
      ...createAssistantStreamState('r'),
      streaming: false,
      blocks: [{ blockId: 'b0', blockKind: 'text', content: 'X is cheaper than Y.', citations: [] }],
      toolCalls: [call('inner1', 'calculator', { arguments: { expression: '2+2' } })],
      segments: [
        { kind: 'tool' as const, toolCallId: 'inner1' },
        { kind: 'text' as const, blockId: 'b0' },
      ],
    };
    const { container } = render(<HandoffBlock toolCall={lead(handoff({ inner }))} />);
    expect(screen.getByText('X is cheaper than Y.')).toBeInTheDocument();
    expect(container.querySelectorAll('.tool-name').length).toBe(2);
  });

  it('shows the answer from the finish event when the streamed text was not kept', () => {
    const inner = {
      ...createAssistantStreamState('r'),
      streaming: false,
      blocks: [{ blockId: 'b0', blockKind: 'text', content: '', citations: [] }],
      segments: [{ kind: 'text' as const, blockId: 'b0' }],
    };
    render(<HandoffBlock toolCall={lead(handoff({ inner, answer: 'Y is faster.' }))} />);
    expect(screen.getByText('Y is faster.')).toBeInTheDocument();
  });

  it('marks a failed hand-off and shows its error', () => {
    const failed = handoff({ status: 'failed', error: 'It used up its limit of 5000 tokens before answering.' });
    const { container } = render(<HandoffBlock toolCall={lead(failed)} />);
    expect(screen.getByText(/Failed/)).toBeInTheDocument();
    expect(container.querySelector('.tool-sum.err')).not.toBeNull();
    expect(screen.getByText(/used up its limit/)).toBeInTheDocument();
  });

  it('renders a nested hand-off as another block', () => {
    const nested = call('tc2', 'ask_writer', {
      handoff: handoff({ agentId: 'writer', name: 'Writer', task: 'Draft it' }),
    });
    const inner = {
      ...createAssistantStreamState('r'),
      streaming: false,
      toolCalls: [nested],
      segments: [{ kind: 'tool' as const, toolCallId: 'tc2' }],
    };
    render(<HandoffBlock toolCall={lead(handoff({ inner }))} />);
    expect(screen.getByText('Writer')).toBeInTheDocument();
    expect(screen.getByText(/Draft it · Done/)).toBeInTheDocument();
  });

  it('opens when an approval inside is pending', () => {
    const pending = call('inner1', 'Echo__post', { complete: false, sideEffecting: true, consent: 'pending' });
    const inner = {
      ...createAssistantStreamState('r'),
      streaming: false,
      toolCalls: [pending],
      segments: [{ kind: 'tool' as const, toolCallId: 'inner1' }],
    };
    const { container } = render(<HandoffBlock toolCall={lead(handoff({ inner }))} />);
    expect(container.querySelector('.handoff')).toHaveAttribute('data-open', 'true');
    expect(container.querySelector('.consent')).not.toBeNull();
  });
});

const usage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

describe('HandoffBlock head', () => {
  it('names the provider in a badge and prices the tokens', async () => {
    const { container } = render(<HandoffBlock toolCall={lead(handoff())} />);
    expect(await screen.findByText('ProvCo')).toHaveClass('provider-badge');
    // 1000 in at $1 and 234 out at $2 per million tokens.
    await waitFor(() => expect(container.querySelector('.tool-sum')?.textContent).toContain('$0.0015'));
  });

  it('shows no cost for a model without a price', async () => {
    const { container } = render(<HandoffBlock toolCall={lead(handoff({ model: 'p/unpriced' }))} />);
    await screen.findByText('ProvCo');
    expect(container.querySelector('.tool-sum')?.textContent).not.toContain('$');
  });

  it('says which tool a running helper is in', () => {
    const inner = {
      ...createAssistantStreamState('r'),
      toolCalls: [call('i1', 'web_search', { complete: true, endedAt: undefined })],
      segments: [{ kind: 'tool' as const, toolCallId: 'i1' }],
    };
    const running = handoff({ status: 'running', endedAt: undefined, inner });
    render(<HandoffBlock toolCall={lead(running)} />);
    expect(screen.getByText(/Compare X and Y · Working · web_search · m/)).toBeInTheDocument();
  });
});

describe('HandoffBlock controls', () => {
  const running = (extra: Partial<HandoffState> = {}) =>
    handoff({ status: 'running', endedAt: undefined, callId: 'call-1', inner: createAssistantStreamState('r'), ...extra });

  it('offers Stop and Redirect only while it runs and has a call id', () => {
    const { rerender } = render(<HandoffBlock toolCall={lead(running())} />);
    expect(screen.getByRole('button', { name: 'Stop Researcher' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Redirect Researcher' })).toBeInTheDocument();
    rerender(<HandoffBlock toolCall={lead(running({ callId: '' }))} />);
    expect(screen.queryByRole('button', { name: 'Stop Researcher' })).toBeNull();
    rerender(<HandoffBlock toolCall={lead(handoff({ callId: 'call-1' }))} />);
    expect(screen.queryByRole('button', { name: 'Stop Researcher' })).toBeNull();
  });

  it('stops that helper by call id without toggling the block', async () => {
    const { container } = render(<HandoffBlock toolCall={lead(running())} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop Researcher' }));
    await waitFor(() => expect(ipc.stopAgentCall).toHaveBeenCalledWith('call-1'));
    expect(container.querySelector('.handoff')).toHaveAttribute('data-open', 'true');
  });

  it('shows why a stop failed for a moment', async () => {
    ipc.stopAgentCall.mockRejectedValue(new Error('gone'));
    render(<HandoffBlock toolCall={lead(running())} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop Researcher' }));
    expect(await screen.findByText(/may have just finished/)).toBeInTheDocument();
  });

  it('sends a redirect on Enter', async () => {
    render(<HandoffBlock toolCall={lead(running())} />);
    fireEvent.click(screen.getByRole('button', { name: 'Redirect Researcher' }));
    const field = screen.getByRole('textbox', { name: 'New instruction for Researcher' });
    fireEvent.change(field, { target: { value: 'Use only primary sources' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() => expect(ipc.redirectAgentCall).toHaveBeenCalledWith('call-1', 'Use only primary sources'));
    await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull());
  });

  it('closes the redirect field on Escape and keeps the key from parent handlers', () => {
    const parent = vi.fn();
    render(
      <div onKeyDown={parent}>
        <HandoffBlock toolCall={lead(running())} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Redirect Researcher' }));
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(parent).not.toHaveBeenCalled();
    expect(ipc.redirectAgentCall).not.toHaveBeenCalled();
  });
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
