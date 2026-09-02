import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Message, MessagePart } from '@conduit/config-schema';
import {
  assistantTurnMatchesRequest,
  excludeLiveAssistantTurns,
  hydrateAssistantTurn,
  messageToDisplayTurn,
  upsertAssistantTurn,
  type ChatTurn,
} from './conversationHydration';

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
      createdAt: now,
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
      createdAt: now,
    });
  });

  it('skips system and developer messages', () => {
    expect(messageToDisplayTurn(makeMessage({ role: 'system', parts: [textPart('sys')] }))).toBeNull();
    expect(messageToDisplayTurn(makeMessage({ role: 'developer', parts: [textPart('dev')] }))).toBeNull();
  });

  it('skips empty user messages', () => {
    expect(messageToDisplayTurn(makeMessage({ role: 'user', parts: [textPart('   ')] }))).toBeNull();
  });

  it('keeps image-only user turns with attachment refs', () => {
    const turn = messageToDisplayTurn(
      makeMessage({
        role: 'user',
        parts: [
          {
            id: 'part-att',
            messageId: 'msg-1',
            index: 0,
            kind: 'attachmentReference',
            attachmentId: 'att-9',
            mimeType: 'image/png',
            createdAt: now,
          },
        ],
      }),
    );
    expect(turn).toMatchObject({
      id: 'msg-1',
      role: 'user',
      content: '',
      attachments: [{ id: 'att-9', mimeType: 'image/png' }],
    });
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
      createdAt: now,
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

describe('live vs persisted assistant overlap', () => {
  const live: ChatTurn = {
    id: 'msg-live',
    role: 'assistant',
    content: 'streaming…',
    streamState: {
      requestId: 'req-turn',
      blocks: [],
      reasoning: [],
      toolCalls: [],
      searchSources: [],
      interrupted: false,
      streaming: true,
    },
  };
  const user: ChatTurn = { id: 'u1', role: 'user', content: 'hi' };
  const other: ChatTurn = {
    id: 'msg-other',
    role: 'assistant',
    content: 'previous',
    streamState: {
      requestId: 'req-other',
      blocks: [],
      reasoning: [],
      toolCalls: [],
      searchSources: [],
      interrupted: false,
      streaming: false,
    },
  };

  it('matches assistant turns by stream requestId or client turn id', () => {
    expect(assistantTurnMatchesRequest(live, 'req-turn')).toBe(true);
    expect(assistantTurnMatchesRequest({ id: 'assistant-req-turn', role: 'assistant', content: '' }, 'req-turn')).toBe(
      true,
    );
    expect(assistantTurnMatchesRequest(other, 'req-turn')).toBe(false);
    expect(assistantTurnMatchesRequest(user, 'req-turn')).toBe(false);
  });

  it('hides the persisted assistant while the live stream for that request is mounted', () => {
    expect(excludeLiveAssistantTurns([user, other, live], 'req-turn')).toEqual([user, other]);
    expect(excludeLiveAssistantTurns([user, live], null)).toEqual([user, live]);
  });

  it('upserts the finished turn instead of appending a duplicate', () => {
    const finished: ChatTurn = {
      ...live,
      content: 'done',
      streamState: live.streamState ? { ...live.streamState, streaming: false } : undefined,
    };
    const next = upsertAssistantTurn([user, live], finished, 'req-turn');
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual(finished);
  });
});
