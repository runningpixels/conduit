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
  saveAttachmentAs: vi.fn(),
}));

const click: ToolCallState = {
  toolCallId: 'c1',
  toolId: 'click',
  name: 'click',
  argumentsText: '{"ref":"e4"}',
  arguments: { ref: 'e4' },
  complete: true,
  startedAt: 1,
  endedAt: 2,
  status: 'completed',
  files: [{ attachmentId: 'att-1', name: 'biostats.csv', mime: 'text/csv', size: 849 }],
};

const finished: AssistantStreamState = {
  ...createAssistantStreamState('req-1'),
  streaming: false,
  blocks: [{ blockId: 'b1', blockKind: 'text', content: 'It lists 18 people.', citations: [] }],
  toolCalls: [click],
  segments: [
    { kind: 'tool', toolCallId: 'c1' },
    { kind: 'text', blockId: 'b1' },
  ],
};

const cards = () => document.querySelectorAll('.saved-file');

describe('a downloaded file in a finished reply', () => {
  it('shows once beside the folded steps, and once when they are opened', () => {
    render(<AssistantMessage state={finished} provider="openrouter" />);
    expect(cards()).toHaveLength(1);
    expect(screen.getByText('biostats.csv')).toBeTruthy();
    fireEvent.click(document.querySelector('.turn-step-row')!);
    expect(cards()).toHaveLength(1);
  });

  it('shows once in a compact turn, open or closed', () => {
    render(<AssistantMessage compact state={finished} provider="openrouter" />);
    expect(cards()).toHaveLength(1);
    fireEvent.click(document.querySelector('.turn-steps-compact')!);
    expect(cards()).toHaveLength(1);
  });
});

describe('a browser call waiting before a page load', () => {
  const opening: ToolCallState = {
    toolCallId: 'o1',
    toolId: 'open_page',
    name: 'open_page',
    argumentsText: '{"url":"https://news.ycombinator.com/"}',
    arguments: { url: 'https://news.ycombinator.com/' },
    complete: true,
    startedAt: 1,
    status: 'running',
    browserPause: { host: 'news.ycombinator.com', seconds: 30, slowDown: true },
  };
  const streaming: AssistantStreamState = {
    ...createAssistantStreamState('req-2'),
    streaming: true,
    toolCalls: [opening],
    segments: [{ kind: 'tool', toolCallId: 'o1' }],
  };

  it('says so on its step row', () => {
    render(<AssistantMessage state={streaming} provider="openrouter" />);
    const row = document.querySelector('.turn-step-row');
    expect(row?.textContent).toContain('news.ycombinator.com asked to slow down, waiting 30 s');
  });

  it('says so on the summary line when its step is past the rows shown', () => {
    const done = (n: number): ToolCallState => ({
      ...opening,
      toolCallId: `d${n}`,
      status: 'completed',
      endedAt: 2,
      browserPause: undefined,
    });
    const many: AssistantStreamState = {
      ...streaming,
      toolCalls: [done(1), done(2), done(3), done(4), opening],
      segments: ['d1', 'd2', 'd3', 'd4', 'o1'].map((toolCallId) => ({ kind: 'tool' as const, toolCallId })),
    };
    render(<AssistantMessage state={many} provider="openrouter" />);
    const rows = [...document.querySelectorAll('.turn-step-row')].map((r) => r.textContent ?? '');
    expect(rows.some((r) => r.includes('slow down'))).toBe(false);
    expect(document.querySelector('.turn-steps-label')?.textContent).toContain(
      'news.ycombinator.com asked to slow down, waiting 30 s',
    );
  });
});
