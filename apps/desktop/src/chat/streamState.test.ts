import { describe, expect, it } from 'vitest';
import { applyConnectorRuntimeEvent, applyProviderEvent, createAssistantStreamState } from './streamState';

describe('streamState connector runtime events', () => {
  it('marks a tool call pending when consent is requested', () => {
    let state = createAssistantStreamState('req-1');
    state = applyProviderEvent(state, {
      kind: 'toolCallStart',
      requestId: 'req-1',
      toolCallId: 'call-1',
      index: 0,
      toolId: 'Echo__post_message',
      name: 'Echo__post_message',
    });

    state = applyConnectorRuntimeEvent(state, {
      kind: 'consentRequested',
      prompt: {
        toolCallId: 'call-1',
        connectorVersionId: 'echo:1.0.0',
        connectorName: 'Echo',
        toolName: 'post_message',
        arguments: {},
        expectedEffect: 'Posts a message.',
        dataSummary: '{"channel":"general"}',
        consentCopy: 'Tenant copy',
      },
    });

    expect(state.toolCalls[0]).toMatchObject({
      toolCallId: 'call-1',
      sideEffecting: true,
      consent: 'pending',
    });
  });

  it('records approved completion after a runtime finish event', () => {
    let state = createAssistantStreamState('req-1');
    state = applyProviderEvent(state, {
      kind: 'toolCallStart',
      requestId: 'req-1',
      toolCallId: 'call-1',
      index: 0,
      toolId: 'Echo__post_message',
      name: 'Echo__post_message',
    });
    state = applyConnectorRuntimeEvent(state, {
      kind: 'consentRequested',
      prompt: {
        toolCallId: 'call-1',
        connectorVersionId: 'echo:1.0.0',
        connectorName: 'Echo',
        toolName: 'post_message',
        arguments: {},
        expectedEffect: 'Posts a message.',
        dataSummary: '{"channel":"general"}',
        consentCopy: 'Tenant copy',
      },
    });

    state = applyConnectorRuntimeEvent(state, {
      kind: 'toolCallFinished',
      tool_call_id: 'call-1',
      status: 'completed',
      size_bytes: 10n,
      mime_hints: ['text/plain'],
    });

    expect(state.toolCalls[0]).toMatchObject({
      complete: true,
      status: 'completed',
      consent: 'approved',
    });
  });

  it('marks denied tool calls as cancelled', () => {
    let state = createAssistantStreamState('req-1');
    state = applyProviderEvent(state, {
      kind: 'toolCallStart',
      requestId: 'req-1',
      toolCallId: 'call-1',
      index: 0,
      toolId: 'Echo__post_message',
      name: 'Echo__post_message',
    });
    state = applyConnectorRuntimeEvent(state, {
      kind: 'consentRequested',
      prompt: {
        toolCallId: 'call-1',
        connectorVersionId: 'echo:1.0.0',
        connectorName: 'Echo',
        toolName: 'post_message',
        arguments: {},
        expectedEffect: 'Posts a message.',
        dataSummary: '{"channel":"general"}',
        consentCopy: 'Tenant copy',
      },
    });

    state = applyConnectorRuntimeEvent(state, {
      kind: 'toolCallFinished',
      tool_call_id: 'call-1',
      status: 'cancelled',
      size_bytes: 0n,
      mime_hints: [],
      error: 'user denied consent',
    });

    expect(state.toolCalls[0]).toMatchObject({
      complete: true,
      status: 'cancelled',
      consent: 'denied',
      error: 'user denied consent',
    });
  });
});

describe('streamState web search', () => {
  it('deduplicates identical citation annotations', () => {
    let state = createAssistantStreamState('req-ws');
    state = applyProviderEvent(state, {
      kind: 'contentBlockStart',
      requestId: 'req-ws',
      blockId: 'b1',
      index: 0,
      blockKind: 'text',
    });
    const cite = {
      kind: 'urlCitation' as const,
      url: 'https://example.com',
      title: 'Example',
      startIndex: 0,
      endIndex: 5,
    };
    state = applyProviderEvent(state, {
      kind: 'citation',
      requestId: 'req-ws',
      blockId: 'b1',
      index: 1,
      annotation: cite,
    });
    state = applyProviderEvent(state, {
      kind: 'citation',
      requestId: 'req-ws',
      blockId: 'b1',
      index: 2,
      annotation: cite,
    });
    expect(state.blocks[0].citations).toHaveLength(1);
  });

  it('scopes searchSources to the last completed web_search call', () => {
    let state = createAssistantStreamState('req-ws');
    state = applyProviderEvent(state, {
      kind: 'toolCallStart',
      requestId: 'req-ws',
      toolCallId: 'ws-1',
      index: 0,
      toolId: 'web_search',
      name: 'web_search',
    });
    state = applyProviderEvent(state, {
      kind: 'toolCallComplete',
      requestId: 'req-ws',
      toolCallId: 'ws-1',
      index: 1,
      arguments: { query: 'q1', status: 'completed' },
    });
    state = applyProviderEvent(state, {
      kind: 'searchSources',
      requestId: 'req-ws',
      index: 2,
      sources: [{ url: 'https://a.com', title: 'A' }],
    });
    expect(state.toolCalls[0].sources).toHaveLength(1);
    expect(state.toolCalls[0].sources?.[0].raw.url).toBe('https://a.com');
  });
});
