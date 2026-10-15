import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentHandoffs, handoffsOf } from './AgentHandoffs';
import { describeStep } from './describeStep';

describe('AgentHandoffs', () => {
  it('shows each hand-off with its task, answer or error and tokens', () => {
    render(
      <AgentHandoffs
        output={{
          text: 'done',
          tokens: 12345,
          handoffs: [
            { agent: 'r', name: 'Researcher', task: 'Find the date', answer: 'May 4', tokens: 1200 },
            { agent: 'w', name: 'Writer', task: 'Draft it', error: 'Out of tokens', tokens: 80 },
          ],
        }}
      />,
    );
    expect(screen.getByText('Researcher')).toBeTruthy();
    expect(screen.getByText('Task: Find the date')).toBeTruthy();
    expect(screen.getByText('May 4')).toBeTruthy();
    expect(screen.getByText('1,200 tokens')).toBeTruthy();
    expect(screen.getByText('Out of tokens')).toBeTruthy();
    expect(screen.getByText('12,345 tokens in all')).toBeTruthy();
  });

  it('folds a long answer and renders nothing for other outputs', () => {
    const long = 'word '.repeat(100);
    const { container } = render(
      <AgentHandoffs output={{ handoffs: [{ agent: 'r', name: 'R', task: 't', answer: long, tokens: 1 }] }} />,
    );
    expect(container.querySelector('details.wf-handoff-fold')).not.toBeNull();
    expect(handoffsOf({ text: 'x' })).toEqual([]);
    expect(handoffsOf(null)).toEqual([]);
    const empty = render(<AgentHandoffs output={{ text: 'x' }} />);
    expect(empty.container.innerHTML).toBe('');
  });
});

describe('describeStep hands-to text', () => {
  const t = (id: string, values?: Record<string, unknown>) => `${id.split('.').pop()} ${JSON.stringify(values)}`;

  it('names the helpers, falling back to the id', () => {
    const step = { id: 'a', type: 'agent' as const, prompt: 'p', agents: ['r', 'gone'] };
    expect(describeStep(step, t, {}, {}, [], { r: 'Researcher' })).toContain('handsTo {"names":"Researcher, gone"}');
  });

  it('adds nothing without helpers', () => {
    const line = describeStep({ id: 'a', type: 'agent', prompt: 'p' }, t);
    expect(line).not.toContain('handsTo');
    expect(describeStep({ id: 'a', type: 'agent', prompt: 'p', agents: [] }, t)).not.toContain('handsTo');
  });
});
