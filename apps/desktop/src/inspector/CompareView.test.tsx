import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Message } from '@conduit/config-schema';

vi.mock('../ipc/client', () => ({
  getReplyVersions: vi.fn(),
  getRequestEventLog: vi.fn().mockResolvedValue({ events: [] }),
}));

import { getReplyVersions } from '../ipc/client';
import { CompareView } from './CompareView';

function reply(id: string, text: string, model?: { provider: string; model: string }): Message {
  return {
    id,
    conversationId: 'conv-1',
    role: 'assistant',
    ...(model ? { metadata: { model } } : {}),
    parts: [{ id: `${id}-p0`, messageId: id, index: 0, kind: 'text', content: text, createdAt: '2026-10-31T00:00:00Z' }],
    createdAt: '2026-10-31T00:00:00Z',
  } as Message;
}

const versions = [
  { position: 1, current: false, messages: [reply('a1', 'The DeepSeek answer.', { provider: 'openrouter', model: 'deepseek/deepseek-v4-flash' })] },
  { position: 2, current: true, messages: [reply('a2', 'The GLM answer.', { provider: 'openrouter', model: 'z-ai/glm-5.3-flash' })] },
];

describe('CompareView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getReplyVersions).mockResolvedValue(versions);
  });

  it('shows every version side by side with the model that wrote it', async () => {
    render(<CompareView conversationId="conv-1" userMessageId="u1" canUse onUse={vi.fn()} onFork={vi.fn()} />);
    const first = await screen.findByRole('article', { name: 'Version 1 of 2' });
    expect(first).toHaveTextContent('The DeepSeek answer.');
    expect(first).toHaveTextContent('deepseek/deepseek-v4-flash');
    const second = screen.getByRole('article', { name: 'Version 2 of 2' });
    expect(second).toHaveTextContent('The GLM answer.');
    expect(second).toHaveTextContent('In use');
    expect(getReplyVersions).toHaveBeenCalledWith('conv-1', 'u1');
  });

  it('puts a version in use, or forks from it', async () => {
    const onUse = vi.fn();
    const onFork = vi.fn();
    render(<CompareView conversationId="conv-1" userMessageId="u1" canUse onUse={onUse} onFork={onFork} />);
    await screen.findByRole('article', { name: 'Version 1 of 2' });
    // Only the version not in use offers it.
    const use = screen.getAllByRole('button', { name: 'Use this one' });
    expect(use).toHaveLength(1);
    fireEvent.click(use[0]);
    expect(onUse).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'Fork from this version' })[1]);
    expect(onFork).toHaveBeenCalledWith(2);
  });

  it('only forks an earlier reply', async () => {
    render(<CompareView conversationId="conv-1" userMessageId="u1" canUse={false} onUse={vi.fn()} onFork={vi.fn()} />);
    await screen.findByRole('article', { name: 'Version 1 of 2' });
    expect(screen.queryByRole('button', { name: 'Use this one' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Fork from this version' })).toHaveLength(2);
  });

  it('says so when the reply has one version', async () => {
    vi.mocked(getReplyVersions).mockResolvedValue([]);
    render(<CompareView conversationId="conv-1" userMessageId="u1" canUse onUse={vi.fn()} onFork={vi.fn()} />);
    expect(await screen.findByText('This reply has only one version.')).toBeInTheDocument();
  });
});
