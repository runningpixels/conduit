import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HandoffBlock } from './HandoffBlock';
import { createAssistantStreamState, type HandoffState, type ToolCallState } from './streamState';

vi.mock('../ipc/client', () => ({
  approveConnectorToolCall: vi.fn(),
  denyConnectorToolCall: vi.fn(),
}));

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
    const summary = screen.getByText(/Compare X and Y · Done · p\/m/);
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
