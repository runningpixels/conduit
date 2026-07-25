import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Message, MessagePart } from '@conduit/config-schema';
import { hydrateAssistantTurn, messageToDisplayTurn } from './conversationHydration';

vi.mock('../ipc/client', () => ({
  getRequestProviderEvents: vi.fn(),
}));

import { getRequestProviderEvents } from '../ipc/client';

const now = '2026-07-02T00:00:00.000Z';

function textPart(content: string, kind: MessagePart['kind'] = 'text'): MessagePart {
  return {
    id: 'part-1',
    messageId: 'msg-1',
    index: 0,
    kind,
    content,
    createdAt: now,
  };
}

function makeMessage(overrides: Partial<Message> & Pick<Message, 'role'>): Message {
  return {
    id: 'msg-1',
    conversationId: 'convo-1',
    parts: [],
    createdAt: now,
    ...overrides,
  };
}

describe('messageToDisplayTurn', () => {
  it('maps user text parts to a user turn', () => {
    const turn = messageToDisplayTurn(
      makeMessage({
        role: 'user',
        parts: [textPart('my prompt')],
      }),
    );

    expect(turn).toEqual({
      id: 'msg-1',
      role: 'user',
      content: 'my prompt',
      interrupted: false,
    });
  });

  it('excludes tool messages with artifact JSON', () => {
    const turn = messageToDisplayTurn(
      makeMessage({
        role: 'tool',
        parts: [
          textPart(
            JSON.stringify({
              ok: true,
              artifact_id: '320a60ff-7705-44b3-9861-519ed949e7a9',
              created: true,
              kind: 'html',
              title: 'Basic Linux CLI Commands',
              updated: false,
            }),
            'toolResult',
          ),
        ],
      }),
    );

    expect(turn).toBeNull();
  });

  it('does not label tool content as a user turn', () => {
    const turn = messageToDisplayTurn(
      makeMessage({
        role: 'tool',
        parts: [textPart('{"answer":42}', 'toolResult')],
      }),
    );

    expect(turn?.role).not.toBe('user');
    expect(turn).toBeNull();
  });

  it('filters non-text parts from user messages', () => {
    const turn = messageToDisplayTurn(
      makeMessage({
        role: 'user',
        parts: [
          textPart('visible prompt'),
          textPart('{"artifact_id":"hidden"}', 'toolResult'),
        ],
      }),
    );

    expect(turn).toEqual({
      id: 'msg-1',
      role: 'user',
      content: 'visible prompt',
      interrupted: false,
    });
  });

  it('skips system and developer messages', () => {
    expect(messageToDisplayTurn(makeMessage({ role: 'system', parts: [textPart('sys')] }))).toBeNull();
    expect(messageToDisplayTurn(makeMessage({ role: 'developer', parts: [textPart('dev')] }))).toBeNull();
  });

  it('skips empty user messages', () => {
    expect(messageToDisplayTurn(makeMessage({ role: 'user', parts: [textPart('   ')] }))).toBeNull();
  });

  it('maps assistant messages to assistant turns', () => {
    const turn = messageToDisplayTurn(
      makeMessage({
        role: 'assistant',
        requestId: 'req-1',
        parts: [textPart('Here is your document.')],
      }),
    );

    expect(turn).toEqual({
      id: 'msg-1',
      role: 'assistant',
      content: 'Here is your document.',
      interrupted: false,
    });
  });
});

describe('hydrateAssistantTurn', () => {
  beforeEach(() => {
    vi.mocked(getRequestProviderEvents).mockReset();
  });

  it('returns null for tool messages', async () => {
    const turn = await hydrateAssistantTurn(
      makeMessage({
        role: 'tool',
        parts: [textPart('{"ok":true}', 'toolResult')],
      }),
    );

    expect(turn).toBeNull();
    expect(getRequestProviderEvents).not.toHaveBeenCalled();
  });

  it('replays provider events into streamState for assistant turns', async () => {
    vi.mocked(getRequestProviderEvents).mockResolvedValue([
      {
        kind: 'contentBlockStart',
        requestId: 'req-1',
        blockId: 'block-1',
        index: 0,
        blockKind: 'text',
      },
      {
        kind: 'contentDelta',
        requestId: 'req-1',
        blockId: 'block-1',
        index: 0,
        content: 'Hello',
      },
      {
        kind: 'toolCallStart',
        requestId: 'req-1',
        toolCallId: 'call-1',
        index: 1,
        toolId: 'write_html_document',
        name: 'write_html_document',
      },
      {
        kind: 'toolCallComplete',
        requestId: 'req-1',
        toolCallId: 'call-1',
        index: 1,
        arguments: { title: 'Doc' },
      },
    ]);

    const turn = await hydrateAssistantTurn(
      makeMessage({
        role: 'assistant',
        requestId: 'req-1',
        parts: [textPart('Hello')],
      }),
    );

    expect(getRequestProviderEvents).toHaveBeenCalledWith('convo-1', 'req-1');
    expect(turn).toMatchObject({
      role: 'assistant',
      content: 'Hello',
    });
    expect(turn?.streamState?.toolCalls).toHaveLength(1);
    expect(turn?.streamState?.toolCalls[0]).toMatchObject({
      toolCallId: 'call-1',
      name: 'write_html_document',
      complete: true,
    });
  });
});
