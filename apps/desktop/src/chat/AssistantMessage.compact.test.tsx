import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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

const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCallState => ({
  toolCallId: id,
  toolId: name,
  name,
  argumentsText: JSON.stringify(args),
  arguments: args,
  complete: true,
  startedAt: 1,
  endedAt: 2,
  status: 'completed',
});

function finished(over: Partial<AssistantStreamState>): AssistantStreamState {
  return { ...createAssistantStreamState('req-1'), streaming: false, ...over };
}

const text = (content: string) => [{ blockId: 'b1', blockKind: 'text', content, citations: [] }];

describe('AssistantMessage compact', () => {
  it('shows the reply and one collapsed summary line for tool calls, which expands in place', () => {
    const toolCalls = [
      call('c1', 'update_slide', { slide_id: 'b' }),
      call('c2', 'patch_slide', { slide_id: 'd' }),
    ];
    render(
      <AssistantMessage
        compact
        deckSlideIds={['a', 'b', 'c', 'd']}
        state={finished({
          blocks: text('Done, both slides are updated.'),
          toolCalls,
          segments: [
            { kind: 'tool', toolCallId: 'c1' },
            { kind: 'tool', toolCallId: 'c2' },
            { kind: 'text', blockId: 'b1' },
          ],
        })}
        provider="openai"
        modelId="gpt-5.4-mini"
      />,
    );
    expect(screen.getByText('Done, both slides are updated.')).toBeTruthy();
    const line = screen.getByRole('button', { name: /Changed slides 2, 4 · 2 steps/ });
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.turn-compact-details')).toBeNull();
    expect(document.querySelector('.turn-step-rows')).toBeNull();
    fireEvent.click(line);
    expect(line.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('.turn-compact-details')).not.toBeNull();
    fireEvent.click(line);
    expect(document.querySelector('.turn-compact-details')).toBeNull();
  });

  it('names a storyline draft without a step count', () => {
    render(
      <AssistantMessage
        compact
        state={finished({
          blocks: text('Here is the plan.'),
          toolCalls: [call('c1', 'set_storyline')],
          segments: [
            { kind: 'tool', toolCallId: 'c1' },
            { kind: 'text', blockId: 'b1' },
          ],
        })}
        provider="openai"
      />,
    );
    expect(screen.getByRole('button', { name: 'Drafted the storyline' })).toBeTruthy();
  });

  it('summarizes thinking alone as Thought for a duration, and expands to the reasoning', () => {
    render(
      <AssistantMessage
        compact
        state={finished({
          blocks: text('Sure.'),
          reasoning: [
            { blockId: 'r1', blockKind: 'thinking', content: 'weighing options', citations: [], startedAt: 0, lastDeltaAt: 113_000 },
          ],
          segments: [
            { kind: 'reasoning', blockId: 'r1' },
            { kind: 'text', blockId: 'b1' },
          ],
        })}
        provider="openai"
      />,
    );
    const line = screen.getByRole('button', { name: /Thought for/ });
    expect(document.querySelector('details.think')).toBeNull();
    fireEvent.click(line);
    expect(document.querySelector('details.think')).not.toBeNull();
  });

  it('keeps the full inline rows in the default mode', () => {
    render(
      <AssistantMessage
        state={finished({
          blocks: text('Done.'),
          toolCalls: [call('c1', 'update_slide', { slide_id: 'b' })],
          segments: [
            { kind: 'tool', toolCallId: 'c1' },
            { kind: 'text', blockId: 'b1' },
          ],
        })}
        provider="openai"
      />,
    );
    expect(document.querySelector('.turn-step-rows')).not.toBeNull();
    expect(document.querySelector('.turn-compact')).toBeNull();
  });

  it('shows a live line while a deck tool runs', () => {
    const running: ToolCallState = { ...call('c1', 'update_slide', { slide_id: 'c' }), complete: false, status: 'running', endedAt: undefined };
    render(
      <AssistantMessage
        compact
        deckSlideIds={['a', 'b', 'c']}
        state={finished({ streaming: true, toolCalls: [running], segments: [{ kind: 'tool', toolCallId: 'c1' }] })}
        provider="openai"
      />,
    );
    expect(screen.getByRole('button', { name: 'Updating slide 3…' })).toBeTruthy();
  });
});
