import { describe, expect, it } from 'vitest';
import type { ConnectorRuntimeEvent, ProviderEvent } from '@conduit/config-schema';
import {
  allToolCalls,
  applyConnectorRuntimeEvent,
  applyProviderEvent,
  createAssistantStreamState,
  markInterrupted,
  rebuildAssistantStreamStateFromLog,
} from './streamState';

// The generated ProviderEvent union gains these kinds with the backend change.
const ev = (event: unknown) => event as ProviderEvent;

const toolStart = (id: string, name: string) =>
  ev({ kind: 'toolCallStart', requestId: 'r', toolCallId: id, index: 0, toolId: name, name });
const started = (id: string, agentId = 'researcher') =>
  ev({ kind: 'handoffStarted', requestId: 'r', toolCallId: id, agentId, name: 'Researcher', task: 'Compare X and Y', model: 'p/m' });
const inner = (id: string, event: unknown) => ev({ kind: 'handoff', requestId: 'r', toolCallId: id, event });
const finished = (id: string, status = 'done') =>
  ev({ kind: 'handoffFinished', requestId: 'r', toolCallId: id, status, tokens: 1200, error: null });

describe('hand-off events', () => {
  it('attaches the hand-off to the lead tool call and folds the helper turn into inner', () => {
    let state = createAssistantStreamState('r');
    state = applyProviderEvent(state, toolStart('tc1', 'ask_researcher'));
    state = applyProviderEvent(state, started('tc1'));
    state = applyProviderEvent(state, inner('tc1', { kind: 'contentBlockStart', requestId: 'r', blockId: 'b0', blockKind: 'text' }));
    state = applyProviderEvent(state, inner('tc1', { kind: 'contentDelta', requestId: 'r', blockId: 'b0', content: 'Found it.' }));
    state = applyProviderEvent(state, inner('tc1', toolStart('inner1', 'web_search')));

    const handoff = state.toolCalls[0].handoff!;
    expect(state.toolCalls).toHaveLength(1);
    expect(handoff).toMatchObject({ agentId: 'researcher', name: 'Researcher', task: 'Compare X and Y', model: 'p/m', status: 'running' });
    expect(handoff.inner.blocks[0].content).toBe('Found it.');
    expect(handoff.inner.toolCalls.map((tc) => tc.toolCallId)).toEqual(['inner1']);
    // The lead's own text and tools are untouched by the helper's.
    expect(state.blocks).toHaveLength(0);

    state = applyProviderEvent(state, finished('tc1'));
    expect(state.toolCalls[0].handoff).toMatchObject({ status: 'done', tokens: 1200 });
    expect(state.toolCalls[0].handoff!.endedAt).toBeDefined();
  });

  it('creates a placeholder call when the hand-off starts before the tool call', () => {
    let state = createAssistantStreamState('r');
    state = applyProviderEvent(state, started('tc1'));
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0]).toMatchObject({ toolCallId: 'tc1', name: 'ask_researcher' });
    state = applyProviderEvent(state, toolStart('tc1', 'ask_researcher'));
    expect(state.toolCalls).toHaveLength(1);
    expect(state.toolCalls[0].handoff).toBeDefined();
  });

  it('nests a helper that hands work to another helper', () => {
    let state = createAssistantStreamState('r');
    state = applyProviderEvent(state, started('tc1'));
    state = applyProviderEvent(state, inner('tc1', toolStart('tc2', 'ask_writer')));
    state = applyProviderEvent(state, inner('tc1', started('tc2', 'writer')));
    state = applyProviderEvent(state, inner('tc1', inner('tc2', toolStart('deep', 'calculator'))));
    state = applyProviderEvent(state, inner('tc1', finished('tc2', 'failed')));

    const nested = state.toolCalls[0].handoff!.inner.toolCalls[0].handoff!;
    expect(nested).toMatchObject({ agentId: 'writer', status: 'failed' });
    expect(nested.inner.toolCalls[0].toolCallId).toBe('deep');
    expect(allToolCalls(state).map((tc) => tc.toolCallId)).toEqual(['tc1', 'tc2', 'deep']);
  });

  it('applies consent events to calls inside a hand-off', () => {
    let state = createAssistantStreamState('r');
    state = applyProviderEvent(state, started('tc1'));
    state = applyProviderEvent(state, inner('tc1', toolStart('inner1', 'Echo__post')));
    state = applyConnectorRuntimeEvent(state, {
      kind: 'consentRequested',
      prompt: {
        toolCallId: 'inner1',
        connectorVersionId: 'echo:1',
        connectorName: 'Echo',
        toolName: 'post',
        arguments: {},
        permissionLevel: 'sideEffectful',
        toolDescription: '',
        dataSummary: '',
        consentCopy: null,
      },
    } as unknown as ConnectorRuntimeEvent);
    expect(state.toolCalls[0].handoff!.inner.toolCalls[0]).toMatchObject({ consent: 'pending', sideEffecting: true });

    state = applyConnectorRuntimeEvent(state, {
      kind: 'toolCallFinished',
      tool_call_id: 'inner1',
      status: 'completed',
      error: null,
    } as unknown as ConnectorRuntimeEvent);
    expect(state.toolCalls[0].handoff!.inner.toolCalls[0]).toMatchObject({ consent: 'approved', status: 'completed' });
  });

  it('stops a running hand-off when the turn is interrupted', () => {
    let state = createAssistantStreamState('r');
    state = applyProviderEvent(state, started('tc1'));
    state = applyProviderEvent(state, inner('tc1', toolStart('inner1', 'web_search')));
    state = markInterrupted(state);
    const handoff = state.toolCalls[0].handoff!;
    expect(handoff.status).toBe('stopped');
    expect(handoff.inner.toolCalls[0].status).toBe('cancelled');
  });

  it('replays a saved turn with the times it was saved', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 21, 8, 0, s)).toISOString();
    const state = rebuildAssistantStreamStateFromLog('r', {
      toolFinishedAt: {},
      events: [
        { event: toolStart('tc1', 'ask_researcher'), at: at(0) },
        { event: started('tc1'), at: at(1) },
        { event: inner('tc1', toolStart('inner1', 'web_search')), at: at(2) },
        { event: finished('tc1'), at: at(9) },
      ],
    });
    const handoff = state.toolCalls[0].handoff!;
    expect(handoff.startedAt).toBe(Date.parse(at(1)));
    expect(handoff.endedAt).toBe(Date.parse(at(9)));
    expect(handoff.status).toBe('done');
    expect(handoff.inner.toolCalls[0].startedAt).toBe(Date.parse(at(2)));
  });

  it('replays a hand-off that never finished as stopped', () => {
    const state = rebuildAssistantStreamStateFromLog('r', {
      toolFinishedAt: {},
      events: [{ event: started('tc1'), at: new Date(Date.UTC(2026, 9, 21)).toISOString() }],
    });
    expect(state.toolCalls[0].handoff!.status).toBe('stopped');
    expect(state.streaming).toBe(false);
  });
});
