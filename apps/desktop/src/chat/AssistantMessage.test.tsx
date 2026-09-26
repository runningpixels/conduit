import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AssistantMessage } from './AssistantMessage';
import { createAssistantStreamState } from './streamState';
import type { AssistantStreamState, ToolCallState } from './streamState';

vi.mock('../ipc/client', () => ({
  exportArtifact: vi.fn(),
  getArtifactContentBytes: vi.fn(),
  revealPath: vi.fn(),
  submitAskUser: vi.fn(),
  approveConnectorToolCall: vi.fn(),
  denyConnectorToolCall: vi.fn(),
}));

function streaming(over: Partial<AssistantStreamState> = {}): AssistantStreamState {
  return { ...createAssistantStreamState('req-1'), streaming: true, ...over };
}

const inAgentLoop = {
  label: 'Running 2 tools',
  round: 1,
  totalRounds: 25,
  subPhase: 'executing_tools' as const,
};

describe('AssistantMessage turn chrome', () => {
  // "Round 1/25" reported the agent-loop step against `max_steps`, a ceiling
  // that is essentially never approached, so it read as alarming progress
  // toward a limit that was not real. ThinkingIndicator still says what is
  // happening, in words.
  it('renders no round badge while an agent phase is active', () => {
    render(
      <AssistantMessage
        state={streaming({ agentPhase: inAgentLoop })}
        provider="openai"
        modelId="gpt-5.4-mini"
      />,
    );

    expect(screen.queryByText(/Round \d/)).toBeNull();
    expect(document.querySelector('.phase-badge')).toBeNull();
  });

  it('still names the phase in the thinking indicator', () => {
    render(
      <AssistantMessage
        state={streaming({ agentPhase: inAgentLoop })}
        provider="openai"
        modelId="gpt-5.4-mini"
      />,
    );

    expect(screen.getByText(/Running 2 tools/)).toBeInTheDocument();
  });

  it('renders no model line unless the caller asks for one', () => {
    render(
      <AssistantMessage
        state={streaming()}
        provider="openai"
        modelId="gpt-5.4-mini"
        showModelLine={false}
      />,
    );

    expect(document.querySelector('.turn-model')).toBeNull();
  });

  it('still shows the model line at a switch', () => {
    render(
      <AssistantMessage
        state={streaming()}
        provider="anthropic"
        modelId="claude-sonnet-4"
        showModelLine
        switchedFrom="openai"
      />,
    );

    expect(document.querySelector('.turn-model')).not.toBeNull();
    expect(screen.getByText(/switched from OpenAI/i)).toBeInTheDocument();
  });

  it('nests the usage info control inside the reserved action row', () => {
    render(
      <AssistantMessage
        state={{
          ...createAssistantStreamState('req-1'),
          streaming: false,
          usage: { inputTokens: 120n, outputTokens: 40n },
          blocks: [{ blockId: 'b1', blockKind: 'text', content: 'Done.', citations: [] }],
        }}
        provider="openai"
        messageId="msg-1"
        isLast
        onCopy={() => {}}
      />,
    );

    const usage = document.querySelector('.usage-summary');
    expect(usage).not.toBeNull();
    expect(usage!.closest('.turn-actions')).not.toBeNull();
    expect(usage!.querySelector('.usage-summary-tip')).not.toBeNull();
    expect(screen.getByRole('button', { name: /Token usage: in: 120 · out: 40/ })).toBeInTheDocument();
  });
});

/**
 * The live tail is the turn's only "still working" affordance. It used to sit
 * above the prose and the tool cards, so cards kept appearing below the cursor
 * while the turn ran and the frontier of generation read as somewhere in the
 * middle of the turn.
 */
describe('AssistantMessage live tail', () => {
  const toolCall = (id: string, name: string): ToolCallState => ({
    toolCallId: id,
    toolId: name,
    name,
    argumentsText: '',
    complete: false,
    startedAt: 1,
  });

  const withText = (content: string): Partial<AssistantStreamState> => ({
    blocks: [{ blockId: 'b1', blockKind: 'text', content, citations: [] }],
  });

  it('renders after the tool cards, never before them', () => {
    render(
      <AssistantMessage
        state={streaming({
          ...withText('Here is what I found.'),
          toolCalls: [toolCall('c1', 'write_html_document')],
          agentPhase: inAgentLoop,
        })}
        provider="openai"
        modelId="gpt-5.4-mini"
      />,
    );

    const tail = document.querySelector('.turn-live-tail');
    const card = document.querySelector('.turn-steps');
    expect(tail).not.toBeNull();
    expect(card).not.toBeNull();
    // DOCUMENT_POSITION_FOLLOWING — the tail comes after the card.
    expect(card!.compareDocumentPosition(tail!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows exactly one caret, in the tail, when tool cards follow the text', () => {
    render(
      <AssistantMessage
        state={streaming({
          ...withText('Here is what I found.'),
          toolCalls: [toolCall('c1', 'write_html_document')],
        })}
        provider="openai"
      />,
    );

    const carets = document.querySelectorAll('.streaming');
    expect(carets).toHaveLength(1);
    expect(carets[0].closest('.turn-live-tail')).not.toBeNull();
  });

  it('keeps the caret at the text tail when nothing renders below it', () => {
    render(
      <AssistantMessage
        state={streaming({
          blocks: [
            { blockId: 'b1', blockKind: 'text', content: 'First.', citations: [] },
            { blockId: 'b2', blockKind: 'text', content: 'Second.', citations: [] },
          ],
        })}
        provider="openai"
      />,
    );

    // One caret for the turn, not one per block.
    const carets = document.querySelectorAll('.streaming');
    expect(carets).toHaveLength(1);
    expect(carets[0].closest('.turn-live-tail')).toBeNull();
  });

  it('renders no caret once the turn has ended', () => {
    render(
      <AssistantMessage
        state={{
          ...streaming({
            ...withText('Partial answer.'),
            toolCalls: [toolCall('c1', 'write_html_document')],
          }),
          streaming: false,
          error: 'Agent turn exceeded wall-clock budget (300s).',
        }}
        provider="openai"
      />,
    );

    expect(document.querySelectorAll('.streaming')).toHaveLength(0);
    expect(document.querySelector('.turn-live-tail')).toBeNull();
  });
});

describe('AssistantMessage chronological timeline', () => {
  const toolCall = (id: string, name: string): ToolCallState => ({
    toolCallId: id,
    toolId: name,
    name,
    argumentsText: '',
    complete: true,
    startedAt: 1,
    endedAt: 2,
    status: 'completed',
  });

  it('renders tool → final text in DOM order (not all prose then all tools)', () => {
    render(
      <AssistantMessage
        state={streaming({
          streaming: false,
          blocks: [
            { blockId: 'block-0', blockKind: 'text', content: 'Hello, Ada.', citations: [] },
          ],
          toolCalls: [toolCall('c1', 'ask_user')],
          askUser: undefined,
          segments: [
            { kind: 'tool', toolCallId: 'c1' },
            { kind: 'text', blockId: 'block-0' },
          ],
        })}
        provider="openai"
      />,
    );

    const article = document.querySelector('article.turn.assistant');
    expect(article).not.toBeNull();
    const card = article!.querySelector('.turn-steps');
    const prose = article!.querySelector('.prose');
    expect(card).not.toBeNull();
    expect(prose).not.toBeNull();
    expect(card!.compareDocumentPosition(prose!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(prose!.textContent).toContain('Hello, Ada.');
  });

  it('renders text → tool → text interleaved', () => {
    render(
      <AssistantMessage
        state={streaming({
          streaming: false,
          blocks: [
            { blockId: 'block-0', blockKind: 'text', content: 'Let me ask.', citations: [] },
            { blockId: 'block-0', blockKind: 'text', content: 'Thanks!', citations: [] },
          ],
          toolCalls: [toolCall('c1', 'current_time')],
          segments: [
            { kind: 'text', blockId: 'block-0' },
            { kind: 'tool', toolCallId: 'c1' },
            { kind: 'text', blockId: 'block-0' },
          ],
        })}
        provider="openai"
      />,
    );

    const article = document.querySelector('article.turn.assistant')!;
    const nodes = [...article.querySelectorAll('.prose, .turn-steps')];
    expect(nodes).toHaveLength(3);
    expect(nodes[0].classList.contains('prose')).toBe(true);
    expect(nodes[0].textContent).toContain('Let me ask.');
    expect(nodes[1].classList.contains('turn-steps')).toBe(true);
    expect(nodes[2].classList.contains('prose')).toBe(true);
    expect(nodes[2].textContent).toContain('Thanks!');
  });

  it('keeps ask_user form before the final greeting text', () => {
    render(
      <AssistantMessage
        state={streaming({
          streaming: false,
          blocks: [
            { blockId: 'block-0', blockKind: 'text', content: 'Nice to meet you, Ada.', citations: [] },
          ],
          toolCalls: [toolCall('c1', 'ask_user')],
          askUser: {
            toolCallId: 'c1',
            title: 'Quick question',
            fields: [{ id: 'name', prompt: 'Your name?', type: 'text', options: null }],
          },
          segments: [
            { kind: 'tool', toolCallId: 'c1' },
            { kind: 'askUser', toolCallId: 'c1' },
            { kind: 'text', blockId: 'block-0' },
          ],
        })}
        provider="openai"
      />,
    );

    const article = document.querySelector('article.turn.assistant')!;
    const ask = article.querySelector('.ask-user');
    const prose = article.querySelector('.prose');
    expect(ask).not.toBeNull();
    expect(prose).not.toBeNull();
    expect(ask!.compareDocumentPosition(prose!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // Live: under a pending form it read "Running 1 tool… still working · 301s —
  // some models send long responses all at once", though nothing was running.
  it('says it is waiting for the reader while an ask_user form is pending', () => {
    render(
      <AssistantMessage
        state={streaming({
          toolCalls: [toolCall('c1', 'ask_user')],
          askUser: {
            toolCallId: 'c1',
            title: 'A couple of quick preferences',
            fields: [{ id: 'units', prompt: 'Which units?', type: 'choice', options: ['Celsius', 'Fahrenheit'] }],
          },
          segments: [
            { kind: 'tool', toolCallId: 'c1' },
            { kind: 'askUser', toolCallId: 'c1' },
          ],
          agentPhase: inAgentLoop,
          lastEventAt: Date.now() - 300_000,
        })}
        provider="openai"
      />,
    );
    const indicator = document.querySelector('.thinking-indicator');
    expect(indicator?.textContent).toContain('Waiting for your answer above');
    expect(indicator?.textContent).not.toMatch(/still working|Running/);
  });

  it('places the live tail after the timeline end, not above later cards', () => {
    render(
      <AssistantMessage
        state={streaming({
          blocks: [
            { blockId: 'b1', blockKind: 'text', content: 'Working…', citations: [] },
          ],
          toolCalls: [toolCall('c1', 'current_time')],
          segments: [
            { kind: 'text', blockId: 'b1' },
            { kind: 'tool', toolCallId: 'c1' },
          ],
          agentPhase: inAgentLoop,
        })}
        provider="openai"
        modelId="gpt-5.4-mini"
      />,
    );

    const tail = document.querySelector('.turn-live-tail');
    const card = document.querySelector('.turn-steps');
    expect(tail).not.toBeNull();
    expect(card).not.toBeNull();
    expect(card!.compareDocumentPosition(tail!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders reasoning above the answer prose', () => {
    render(
      <AssistantMessage
        state={streaming({
          streaming: false,
          reasoning: [
            { blockId: 'r1', blockKind: 'reasoning', content: 'Let me think about Rome.', citations: [] },
          ],
          blocks: [
            { blockId: 'block-0', blockKind: 'text', content: 'Rome grew from a city-state.', citations: [] },
          ],
          segments: [
            { kind: 'reasoning', blockId: 'r1' },
            { kind: 'text', blockId: 'block-0' },
          ],
        })}
        provider="openai"
      />,
    );

    const article = document.querySelector('article.turn.assistant')!;
    const think = article.querySelector('.think');
    const prose = article.querySelector('.prose');
    expect(think).not.toBeNull();
    expect(prose).not.toBeNull();
    expect(think!.compareDocumentPosition(prose!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(think!.querySelector('summary')!.textContent).toBe('Thought');
    expect(prose!.textContent).toContain('Rome grew from a city-state.');
  });

  it('keeps reasoning above answer even when an empty text segment precedes it', () => {
    render(
      <AssistantMessage
        state={streaming({
          streaming: false,
          reasoning: [
            { blockId: 'r1', blockKind: 'reasoning', content: 'thinking…', citations: [] },
          ],
          blocks: [
            { blockId: 'block-0', blockKind: 'text', content: '', citations: [] },
            { blockId: 'block-0', blockKind: 'text', content: 'Final answer.', citations: [] },
          ],
          segments: [
            { kind: 'text', blockId: 'block-0' },
            { kind: 'reasoning', blockId: 'r1' },
            { kind: 'text', blockId: 'block-0' },
          ],
        })}
        provider="openai"
      />,
    );

    const article = document.querySelector('article.turn.assistant')!;
    const think = article.querySelector('.think');
    const proseNodes = [...article.querySelectorAll('.prose')];
    expect(think).not.toBeNull();
    expect(proseNodes).toHaveLength(1);
    expect(proseNodes[0].textContent).toContain('Final answer.');
    expect(think!.compareDocumentPosition(proseNodes[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders reasoning → tool → text in DOM order', () => {
    render(
      <AssistantMessage
        state={streaming({
          streaming: false,
          reasoning: [
            { blockId: 'r1', blockKind: 'reasoning', content: 'I should look this up.', citations: [] },
          ],
          blocks: [
            { blockId: 'block-0', blockKind: 'text', content: 'Here is what I found.', citations: [] },
          ],
          toolCalls: [toolCall('c1', 'web_search')],
          segments: [
            { kind: 'reasoning', blockId: 'r1' },
            { kind: 'tool', toolCallId: 'c1' },
            { kind: 'text', blockId: 'block-0' },
          ],
        })}
        provider="openai"
      />,
    );

    const article = document.querySelector('article.turn.assistant')!;
    const nodes = [...article.querySelectorAll('.think, .turn-steps, .prose')];
    expect(nodes).toHaveLength(3);
    expect(nodes[0].classList.contains('think')).toBe(true);
    expect(nodes[1].classList.contains('turn-steps')).toBe(true);
    expect(nodes[2].classList.contains('prose')).toBe(true);
  });
});

describe('AssistantMessage output limit', () => {
  it('says a reply was cut off when it stopped at the output limit', () => {
    render(
      <AssistantMessage
        state={{ ...streaming(), streaming: false, finishReason: 'length' }}
        provider="openai"
        modelId="gpt-5.4-mini"
      />,
    );

    expect(screen.getByText(/reached the output limit/)).toBeInTheDocument();
  });

  it('says nothing for a reply that finished normally', () => {
    render(
      <AssistantMessage
        state={{ ...streaming(), streaming: false, finishReason: 'stop' }}
        provider="openai"
        modelId="gpt-5.4-mini"
      />,
    );

    expect(screen.queryByText(/output limit/)).toBeNull();
  });
});

describe('AssistantMessage document build stopped at the time limit', () => {
  it('offers to continue building when the build was cut short', () => {
    const onContinueBuilding = vi.fn();
    render(
      <AssistantMessage
        state={{
          ...streaming(),
          streaming: false,
          error: 'The turn reached its time limit while the document was still being built.',
          errorCode: 'turn_time_limit_building',
        }}
        provider="openai"
        modelId="gpt-5.4-mini"
        onContinueBuilding={onContinueBuilding}
      />,
    );

    screen.getByRole('button', { name: 'Continue building' }).click();
    expect(onContinueBuilding).toHaveBeenCalledTimes(1);
  });

  it('does not offer it for other time limits or on earlier turns', () => {
    const state = {
      ...streaming(),
      streaming: false,
      error: 'Agent turn reached its time limit (300s).',
      errorCode: 'turn_time_limit',
    };
    const { rerender } = render(
      <AssistantMessage state={state} provider="openai" modelId="gpt-5.4-mini" onContinueBuilding={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Continue building' })).toBeNull();

    rerender(
      <AssistantMessage
        state={{ ...state, errorCode: 'turn_time_limit_building' }}
        provider="openai"
        modelId="gpt-5.4-mini"
        isLast={false}
        onContinueBuilding={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Continue building' })).toBeNull();
  });
});

describe('AssistantMessage output limit actions', () => {
  it('offers a retry without the token limit after an output-limit error', () => {
    const onRetryWithoutLimit = vi.fn();
    render(
      <AssistantMessage
        state={{
          ...streaming(),
          streaming: false,
          error: 'The model used its whole output limit (9,000 tokens) on reasoning.',
          errorCode: 'output_limit_reasoning',
        }}
        provider="openai"
        modelId="gpt-5.4-mini"
        onRetryWithoutLimit={onRetryWithoutLimit}
      />,
    );
    screen.getByRole('button', { name: 'Retry without the token limit' }).click();
    expect(onRetryWithoutLimit).toHaveBeenCalledTimes(1);
  });

  it('shows the limit next to the live token count', () => {
    vi.useFakeTimers();
    try {
      render(<AssistantMessage state={streaming()} provider="openai" modelId="gpt-5.4-mini" outputLimit={9000} />);
      act(() => {
        vi.advanceTimersByTime(1500);
      });
      expect(screen.getByText(/ \/ 9000 tok/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AssistantMessage compact step line', () => {
  const done = (id: string, name: string, over: Partial<ToolCallState> = {}): ToolCallState => ({
    toolCallId: id,
    toolId: name,
    name,
    argumentsText: '',
    complete: true,
    startedAt: 1,
    endedAt: 2,
    status: 'completed',
    ...over,
  });

  const finished = (over: Partial<AssistantStreamState>): AssistantStreamState =>
    streaming({
      streaming: false,
      blocks: [{ blockId: 'b', blockKind: 'text', content: 'Answer.', citations: [] }],
      ...over,
    });

  const twoStepsOneSite = finished({
    toolCalls: [
      done('s1', 'web_search', {
        arguments: { query: 'rust' },
        sources: [{ raw: { title: 'Tokio', url: 'https://tokio.rs/' } }],
      }),
      done('c1', 'current_time'),
    ],
    segments: [
      { kind: 'tool', toolCallId: 's1' },
      { kind: 'tool', toolCallId: 'c1' },
      { kind: 'text', blockId: 'b' },
    ],
  });

  it('replaces the tool cards with one line per turn', () => {
    render(<AssistantMessage state={twoStepsOneSite} provider="openai" onOpenActivity={() => {}} />);
    const lines = document.querySelectorAll('.turn-steps');
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toContain('2 steps · 1 site');
    expect(lines[0].querySelector('.step-status')?.getAttribute('data-status')).toBe('done');
    expect(document.querySelector('.tool')).toBeNull();
  });

  it('opens the activity for this turn when the host handles it', () => {
    const onOpenActivity = vi.fn();
    render(
      <AssistantMessage
        state={twoStepsOneSite}
        provider="openai"
        messageId="m1"
        turnId="turn-1"
        onOpenActivity={onOpenActivity}
      />,
    );
    fireEvent.click(document.querySelector('.turn-steps')!);
    expect(onOpenActivity).toHaveBeenCalledWith('turn-1');
    expect(document.querySelector('.tool')).toBeNull();
  });

  it('falls back to the message id, then the request id', () => {
    const onOpenActivity = vi.fn();
    const { unmount } = render(
      <AssistantMessage state={twoStepsOneSite} provider="openai" messageId="m1" onOpenActivity={onOpenActivity} />,
    );
    fireEvent.click(document.querySelector('.turn-steps')!);
    expect(onOpenActivity).toHaveBeenLastCalledWith('m1');
    unmount();
    render(<AssistantMessage state={twoStepsOneSite} provider="openai" onOpenActivity={onOpenActivity} />);
    fireEvent.click(document.querySelector('.turn-steps')!);
    expect(onOpenActivity).toHaveBeenLastCalledWith('req-1');
  });

  it('expands the old tool cards in place without an activity handler', () => {
    render(<AssistantMessage state={twoStepsOneSite} provider="openai" />);
    const line = document.querySelector('.turn-steps')!;
    expect(line).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('.tool')).toBeNull();
    fireEvent.click(line);
    expect(line).toHaveAttribute('aria-expanded', 'true');
    expect(document.querySelector('.search-call-group')).not.toBeNull();
    expect(document.querySelectorAll('.tool')).toHaveLength(2);
    fireEvent.click(line);
    expect(document.querySelector('.tool')).toBeNull();
  });

  it('shows no line for a turn without tools', () => {
    render(<AssistantMessage state={finished({})} provider="openai" />);
    expect(document.querySelector('.turn-steps')).toBeNull();
  });

  it('spins while the turn is running', () => {
    render(
      <AssistantMessage
        state={streaming({ toolCalls: [{ ...done('c1', 'current_time'), status: 'running', endedAt: undefined }] })}
        provider="openai"
      />,
    );
    expect(document.querySelector('.turn-steps .step-status')?.getAttribute('data-status')).toBe('running');
  });

  it('keeps a pending approval inline', () => {
    render(
      <AssistantMessage
        state={streaming({
          toolCalls: [
            done('c0', 'current_time'),
            {
              toolCallId: 'c1',
              toolId: 'slack__post',
              name: 'slack__post',
              argumentsText: '',
              complete: true,
              sideEffecting: true,
              consent: 'pending',
            },
          ],
        })}
        provider="openai"
        onOpenActivity={() => {}}
      />,
    );
    expect(document.querySelector('.consent')).not.toBeNull();
    expect(screen.getByRole('button', { name: /approve/i })).toBeInTheDocument();
    const line = document.querySelector('.turn-steps')!;
    expect(line.textContent).toContain('needs you');
    // Only the gated call is a card; the finished one folded into the line.
    expect(document.querySelectorAll('.tool')).toHaveLength(1);
  });

  it('keeps an ask_user form inline', () => {
    render(
      <AssistantMessage
        state={streaming({
          toolCalls: [done('a1', 'ask_user', { status: undefined })],
          askUser: {
            toolCallId: 'a1',
            title: 'Quick question',
            fields: [{ id: 'name', prompt: 'Your name?', type: 'text', options: null }],
          },
          segments: [
            { kind: 'tool', toolCallId: 'a1' },
            { kind: 'askUser', toolCallId: 'a1' },
          ],
        })}
        provider="openai"
        onOpenActivity={() => {}}
      />,
    );
    expect(document.querySelector('.ask-user')).not.toBeNull();
    expect(screen.getByText('Your name?')).toBeInTheDocument();
    expect(document.querySelector('.turn-steps')?.textContent).toContain('needs you');
  });

  it('keeps a document that is still being written inline', () => {
    render(
      <AssistantMessage
        state={streaming({
          toolCalls: [
            {
              toolCallId: 'd1',
              toolId: 'write_html_document',
              name: 'write_html_document',
              argumentsText: '{"title":"Plan","html":"<p>',
              complete: false,
              startedAt: 1,
              documentWrite: {
                contentField: 'html',
                title: 'Plan',
                contentChars: 3,
                contentLines: 0,
                depth: 1,
                inString: true,
                key: 'html',
                expectKey: false,
                role: 'value',
                escaped: false,
                unicodeRemaining: 0,
                unicodeHex: '',
              },
            },
          ],
        })}
        provider="openai"
        onOpenActivity={() => {}}
      />,
    );
    const card = document.querySelector('.tool');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('writing…');
    expect(card!.textContent).toContain('Plan');
  });

  it('keeps the turn error inline', () => {
    render(
      <AssistantMessage
        state={finished({ error: 'Provider refused', toolCalls: [done('c1', 'current_time')] })}
        provider="openai"
        onOpenActivity={() => {}}
      />,
    );
    expect(document.querySelector('.error-text')?.textContent).toBe('Provider refused');
  });
});
