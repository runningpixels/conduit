import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AssistantMessage } from './AssistantMessage';
import { createAssistantStreamState } from './streamState';
import type { AssistantStreamState, ToolCallState } from './streamState';

vi.mock('../ipc/client', () => ({
  exportArtifact: vi.fn(),
  getArtifactContentBytes: vi.fn(),
  revealPath: vi.fn(),
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
    const card = document.querySelector('.tool');
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
