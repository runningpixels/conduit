import { describe, expect, it } from 'vitest';
import {
  applyConnectorRuntimeEvent,
  applyProviderEvent,
  createAssistantStreamState,
  markInterrupted,
  rebuildAssistantStreamStateFromEvents,
  toolCallAwaitsRuntimeFinish,
} from './streamState';

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

describe('streamState agent feedback events', () => {
  it('stores agentPhase from agentPhase event', () => {
    let state = createAssistantStreamState('req-ap');
    state = applyProviderEvent(state, {
      kind: 'agentPhase',
      requestId: 'req-ap',
      label: 'Thinking',
      round: 1,
      totalRounds: 5,
      subPhase: 'thinking',
    });
    expect(state.agentPhase).toEqual({
      label: 'Thinking',
      round: 1,
      totalRounds: 5,
      subPhase: 'thinking',
    });
  });

  it('updates agentPhase on subsequent rounds', () => {
    let state = createAssistantStreamState('req-ap');
    state = applyProviderEvent(state, {
      kind: 'agentPhase',
      requestId: 'req-ap',
      label: 'Thinking',
      round: 1,
      totalRounds: 3,
      subPhase: 'thinking',
    });
    state = applyProviderEvent(state, {
      kind: 'agentPhase',
      requestId: 'req-ap',
      label: 'Running 2 tools',
      round: 1,
      totalRounds: 3,
      subPhase: 'executing_tools',
    });
    expect(state.agentPhase).toEqual({
      label: 'Running 2 tools',
      round: 1,
      totalRounds: 3,
      subPhase: 'executing_tools',
    });
  });

  it('sets zero totalRounds to undefined', () => {
    let state = createAssistantStreamState('req-ap');
    state = applyProviderEvent(state, {
      kind: 'agentPhase',
      requestId: 'req-ap',
      label: 'Thinking',
      round: 1,
      totalRounds: 0,
      subPhase: 'thinking',
    });
    expect(state.agentPhase?.totalRounds).toBeUndefined();
  });

  it('marks a tool call running on toolExecutionStarted', () => {
    let state = createAssistantStreamState('req-te');
    state = applyProviderEvent(state, {
      kind: 'toolCallStart',
      requestId: 'req-te',
      toolCallId: 'call-1',
      index: 0,
      toolId: 'web_search',
      name: 'web_search',
    });
    state = applyProviderEvent(state, {
      kind: 'toolExecutionStarted',
      requestId: 'req-te',
      toolCallId: 'call-1',
      toolName: 'web_search',
    });
    expect(state.toolCalls[0]).toMatchObject({
      toolCallId: 'call-1',
      status: 'running',
    });
  });

  it('marks a tool call completed on toolExecutionFinished', () => {
    let state = createAssistantStreamState('req-te');
    state = applyProviderEvent(state, {
      kind: 'toolCallStart',
      requestId: 'req-te',
      toolCallId: 'call-1',
      index: 0,
      toolId: 'web_search',
      name: 'web_search',
    });
    state = applyProviderEvent(state, {
      kind: 'toolExecutionStarted',
      requestId: 'req-te',
      toolCallId: 'call-1',
      toolName: 'web_search',
    });
    state = applyProviderEvent(state, {
      kind: 'toolExecutionFinished',
      requestId: 'req-te',
      toolCallId: 'call-1',
      toolName: 'web_search',
      isError: false,
    });
    expect(state.toolCalls[0]).toMatchObject({
      toolCallId: 'call-1',
      status: 'completed',
    });
  });

  it('marks a tool call failed on toolExecutionFinished with isError', () => {
    let state = createAssistantStreamState('req-te');
    state = applyProviderEvent(state, {
      kind: 'toolCallStart',
      requestId: 'req-te',
      toolCallId: 'call-1',
      index: 0,
      toolId: 'web_search',
      name: 'web_search',
    });
    state = applyProviderEvent(state, {
      kind: 'toolExecutionStarted',
      requestId: 'req-te',
      toolCallId: 'call-1',
      toolName: 'web_search',
    });
    state = applyProviderEvent(state, {
      kind: 'toolExecutionFinished',
      requestId: 'req-te',
      toolCallId: 'call-1',
      toolName: 'web_search',
      isError: true,
      error: 'Rate limited',
    });
    expect(state.toolCalls[0]).toMatchObject({
      toolCallId: 'call-1',
      status: 'failed',
      error: 'Rate limited',
    });
  });

  it('preserves toolExecutionStarted status when tool completes via runtime event', () => {
    // Connector tools get status via ToolExecutionStarted + ConnectorRuntimeEvent::toolCallFinished
    let state = createAssistantStreamState('req-te');
    state = applyProviderEvent(state, {
      kind: 'toolCallStart',
      requestId: 'req-te',
      toolCallId: 'call-1',
      index: 0,
      toolId: 'Echo__post_message',
      name: 'Echo__post_message',
    });
    state = applyProviderEvent(state, {
      kind: 'toolExecutionStarted',
      requestId: 'req-te',
      toolCallId: 'call-1',
      toolName: 'Echo__post_message',
    });
    expect(state.toolCalls[0].status).toBe('running');

    // Runtime completes the call
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
    });
  });

  it('preserves error from toolExecutionFinished when error is None', () => {
    let state = createAssistantStreamState('req-te');
    state = applyProviderEvent(state, {
      kind: 'toolCallStart',
      requestId: 'req-te',
      toolCallId: 'call-1',
      index: 0,
      toolId: 'web_search',
      name: 'web_search',
    });
    state = applyProviderEvent(state, {
      kind: 'toolExecutionStarted',
      requestId: 'req-te',
      toolCallId: 'call-1',
      toolName: 'web_search',
    });
    state = applyProviderEvent(state, {
      kind: 'toolExecutionFinished',
      requestId: 'req-te',
      toolCallId: 'call-1',
      toolName: 'web_search',
      isError: false,
    });
    // error should not be set when isError is false and error is not provided
    expect(state.toolCalls[0].error).toBeUndefined();
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

  it('accumulates searchCost from searchCost events', () => {
    let state = createAssistantStreamState('req-ws');
    state = applyProviderEvent(state, {
      kind: 'searchCost',
      requestId: 'req-ws',
      index: 0,
      toolCalls: 3,
    });
    state = applyProviderEvent(state, {
      kind: 'searchCost',
      requestId: 'req-ws',
      index: 1,
      toolCalls: 2,
    });
    expect(state.searchCost).toBe(5);
  });

  it('stores searchUnavailable from searchUnavailable events', () => {
    let state = createAssistantStreamState('req-ws');
    state = applyProviderEvent(state, {
      kind: 'searchUnavailable',
      requestId: 'req-ws',
      index: 0,
      code: 'unsupported',
      message: 'Hosted search is not available for this model.',
    });
    expect(state.searchUnavailable).toEqual({
      code: 'unsupported',
      message: 'Hosted search is not available for this model.',
    });
  });
});

describe('streamState terminal settling', () => {
  const startCall = (state: ReturnType<typeof createAssistantStreamState>, id: string, name: string) =>
    applyProviderEvent(state, {
      kind: 'toolCallStart',
      requestId: 'req-1',
      toolCallId: id,
      index: 0,
      toolId: name,
      name,
    });

  it('fails tool calls the turn abandoned when it errors', () => {
    let state = createAssistantStreamState('req-1');
    state = startCall(state, 'call-1', 'write_html_document');
    state = applyProviderEvent(state, {
      kind: 'error',
      requestId: 'req-1',
      error: {
        message: 'Agent turn exceeded wall-clock budget (300s) waiting on the provider.',
        retryable: false,
      },
    });

    expect(state.toolCalls[0]).toMatchObject({ status: 'failed' });
    expect(state.toolCalls[0].endedAt).toBeTypeOf('number');
    expect(state.toolCalls[0].error).toBeTruthy();
  });

  it('fails a call left mid-execution by the agent loop', () => {
    let state = createAssistantStreamState('req-1');
    state = startCall(state, 'call-1', 'write_html_document');
    state = applyProviderEvent(state, {
      kind: 'toolExecutionStarted',
      requestId: 'req-1',
      toolCallId: 'call-1',
      toolName: 'write_html_document',
    });
    state = applyProviderEvent(state, {
      kind: 'error',
      requestId: 'req-1',
      error: { message: 'boom', retryable: false },
    });

    expect(state.toolCalls[0].status).toBe('failed');
  });

  it('leaves already-settled calls untouched on error', () => {
    let state = createAssistantStreamState('req-1');
    state = startCall(state, 'call-1', 'current_time');
    state = applyProviderEvent(state, {
      kind: 'toolExecutionFinished',
      requestId: 'req-1',
      toolCallId: 'call-1',
      toolName: 'current_time',
      isError: false,
    });
    const settledAt = state.toolCalls[0].endedAt;
    state = applyProviderEvent(state, {
      kind: 'error',
      requestId: 'req-1',
      error: { message: 'boom', retryable: false },
    });

    expect(state.toolCalls[0]).toMatchObject({ status: 'completed', endedAt: settledAt });
    expect(state.toolCalls[0].error).toBeUndefined();
  });

  it('marks hosted web_search completed on toolCallComplete (no runtime finish)', () => {
    let state = createAssistantStreamState('req-1');
    state = startCall(state, 'ws-1', 'web_search');
    state = applyProviderEvent(state, {
      kind: 'toolCallComplete',
      requestId: 'req-1',
      toolCallId: 'ws-1',
      index: 1,
      arguments: { query: 'q1' },
    });
    state = applyProviderEvent(state, {
      kind: 'error',
      requestId: 'req-1',
      error: { message: 'boom', retryable: false },
    });

    expect(state.toolCalls[0].status).toBe('completed');
    expect(state.toolCalls[0].complete).toBe(true);
    expect(state.toolCalls[0].error).toBeUndefined();
  });

  it('toolCallAwaitsRuntimeFinish ignores hosted web_search', () => {
    let state = createAssistantStreamState('req-1');
    state = startCall(state, 'ws-1', 'web_search');
    state = applyProviderEvent(state, {
      kind: 'toolCallComplete',
      requestId: 'req-1',
      toolCallId: 'ws-1',
      index: 1,
      arguments: { query: 'q1' },
    });
    expect(toolCallAwaitsRuntimeFinish(state.toolCalls[0])).toBe(false);

    state = createAssistantStreamState('req-2');
    state = startCall(state, 'call-1', 'write_html_document');
    state = applyProviderEvent(state, {
      kind: 'toolCallComplete',
      requestId: 'req-2',
      toolCallId: 'call-1',
      index: 0,
      arguments: { html: '<p>x</p>' },
    });
    expect(toolCallAwaitsRuntimeFinish(state.toolCalls[0])).toBe(true);
  });

  it('cancels unfinished calls when the turn is interrupted', () => {
    let state = createAssistantStreamState('req-1');
    state = startCall(state, 'call-1', 'write_html_document');
    const interrupted = markInterrupted(state);

    expect(interrupted).toMatchObject({ interrupted: true, streaming: false });
    expect(interrupted.toolCalls[0]).toMatchObject({ status: 'cancelled' });
    expect(interrupted.toolCalls[0].endedAt).toBeTypeOf('number');
  });

  it('leaves no running calls when replaying a persisted turn', () => {
    const state = rebuildAssistantStreamStateFromEvents('req-1', [
      {
        kind: 'toolCallStart',
        requestId: 'req-1',
        toolCallId: 'call-1',
        index: 0,
        toolId: 'write_html_document',
        name: 'write_html_document',
      },
      {
        kind: 'toolExecutionStarted',
        requestId: 'req-1',
        toolCallId: 'call-1',
        toolName: 'write_html_document',
      },
    ]);

    expect(state.streaming).toBe(false);
    expect(state.toolCalls[0].status).toBe('failed');
  });
});
