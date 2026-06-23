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
