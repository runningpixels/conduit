import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AssistantMessage } from './AssistantMessage';
import { createAssistantStreamState } from './streamState';
import type { AssistantStreamState } from './streamState';

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
});
