import { describe, expect, it } from 'vitest';
import type { ChatTurn } from '../chat/conversationHydration';
import {
  applyProviderEvent,
  createAssistantStreamState,
  rebuildAssistantStreamStateFromEvents,
  type AssistantStreamState,
  type ToolCallState,
} from '../chat/streamState';
import type { ProviderEvent } from '@conduit/config-schema';
import { deriveActivitySteps, turnActivity, turnMatchesId, turnSites, turnSummary } from './turnActivity';

function state(over: Partial<AssistantStreamState> = {}): AssistantStreamState {
  return { ...createAssistantStreamState('req-1'), streaming: false, ...over };
}

function call(over: Partial<ToolCallState> & { toolCallId: string; name: string }): ToolCallState {
  return { toolId: over.name, argumentsText: '', complete: true, ...over };
}

function assistant(streamState?: AssistantStreamState, id = 'm1'): ChatTurn {
  return { id, role: 'assistant', content: '', streamState };
}

describe('deriveActivitySteps', () => {
  it('turns a finished generic tool into a done step with its duration and label', () => {
    const steps = deriveActivitySteps(
      state({
        toolCalls: [
          call({
            toolCallId: 'c1',
            name: 'workspace_read',
            arguments: { path: 'src/main.rs' },
            status: 'completed',
            startedAt: 1000,
            endedAt: 1340,
          }),
        ],
      }),
    );
    expect(steps).toEqual([
      expect.objectContaining({
        id: 'c1',
        kind: 'tool',
        name: 'workspace_read',
        label: 'src/main.rs',
        status: 'done',
        durationMs: 340,
        startedAt: 1000,
      }),
    ]);
  });

  it('names the connector of a connector tool', () => {
    const [step] = deriveActivitySteps(
      state({ toolCalls: [call({ toolCallId: 'c1', name: 'github__create_issue', status: 'completed' })] }),
    );
    expect(step.connector).toBe('github');
  });

  it('reads a document write title and size from the arguments', () => {
    const [step] = deriveActivitySteps(
      state({
        toolCalls: [
          call({
            toolCallId: 'd1',
            name: 'write_html_document',
            arguments: { title: 'Q3 report', html: '<h1>Hi</h1>\n<p>x</p>' },
            status: 'completed',
          }),
        ],
      }),
    );
    expect(step).toMatchObject({
      kind: 'document',
      label: 'Q3 report',
      documentAction: 'create',
      status: 'done',
      size: { chars: 20, lines: 2 },
    });
  });

  it('shows a streaming document as running with its live title', () => {
    let s = createAssistantStreamState('req-1');
    const events: ProviderEvent[] = [
      { kind: 'toolCallStart', toolCallId: 'd1', toolId: 'write_html_document', name: 'write_html_document' },
      { kind: 'toolCallDelta', toolCallId: 'd1', content: '{"title":"Plan","html":"<p>a' },
    ] as ProviderEvent[];
    for (const e of events) s = applyProviderEvent(s, e);
    const [step] = deriveActivitySteps(s);
    expect(step).toMatchObject({ kind: 'document', label: 'Plan', status: 'running' });
    expect(turnSummary(assistant(s)).running).toBe(true);
  });

  it('reads web search queries, source counts and hosts', () => {
    const s = state({
      toolCalls: [
        call({
          toolCallId: 's1',
          name: 'web_search',
          toolId: 'web_search',
          arguments: { query: 'rust async' },
          status: 'completed',
          sources: [
            { raw: { title: 'Tokio', url: 'https://tokio.rs/tutorial' } },
            { raw: { title: 'Docs', url: 'https://doc.rust-lang.org/a' } },
            { raw: { title: 'Docs 2', url: 'https://doc.rust-lang.org/b' } },
          ],
        }),
      ],
    });
    const [step] = deriveActivitySteps(s);
    expect(step).toMatchObject({ kind: 'search', label: 'rust async', sourceCount: 3, status: 'done' });
    expect(turnSites(s)).toEqual(['tokio.rs', 'doc.rust-lang.org']);
    expect(turnSummary(assistant(s))).toMatchObject({ steps: 1, sites: 2 });
  });

  it('counts fetched URLs and citations as sites', () => {
    const s = state({
      toolCalls: [call({ toolCallId: 'f1', name: 'web_fetch', arguments: { url: 'https://example.com/x' } })],
      blocks: [
        {
          blockId: 'b',
          blockKind: 'text',
          content: 'x',
          citations: [{ index: 1, url: 'https://news.example.org/a', title: 'A', startIndex: 0, endIndex: 1 }],
        },
      ],
    });
    expect(turnSites(s)).toEqual(['example.com', 'news.example.org']);
  });

  it('marks a failed call failed and keeps the reason', () => {
    const [step] = deriveActivitySteps(
      state({ toolCalls: [call({ toolCallId: 'c1', name: 'uuid', status: 'failed', error: 'boom' })] }),
    );
    expect(step).toMatchObject({ status: 'failed', error: 'boom' });
    expect(turnSummary(assistant(state({ toolCalls: [call({ toolCallId: 'c1', name: 'uuid', status: 'failed' })] }))).failed).toBe(1);
  });

  it('marks a call waiting on consent as waiting, and the turn as needing the reader', () => {
    const s = state({
      streaming: true,
      toolCalls: [call({ toolCallId: 'c1', name: 'slack__post', sideEffecting: true, consent: 'pending' })],
    });
    expect(deriveActivitySteps(s)[0].status).toBe('waiting');
    expect(turnSummary(assistant(s)).needsYou).toBe(true);
  });

  it('marks a denied call denied', () => {
    const [step] = deriveActivitySteps(
      state({
        toolCalls: [
          call({ toolCallId: 'c1', name: 'slack__post', sideEffecting: true, consent: 'denied', status: 'cancelled' }),
        ],
      }),
    );
    expect(step.status).toBe('denied');
  });

  it('marks a pending ask_user form as waiting with its title', () => {
    const s = state({
      streaming: true,
      toolCalls: [call({ toolCallId: 'a1', name: 'ask_user', complete: true })],
      askUser: { toolCallId: 'a1', title: 'Quick question', fields: [] },
    });
    expect(deriveActivitySteps(s)[0]).toMatchObject({ kind: 'askUser', label: 'Quick question', status: 'waiting' });
    expect(turnSummary(assistant(s)).needsYou).toBe(true);
  });

  it('keeps a local tool running until the runtime finishes it', () => {
    const s = state({
      streaming: true,
      toolCalls: [call({ toolCallId: 'c1', name: 'current_time', complete: true })],
    });
    expect(deriveActivitySteps(s)[0].status).toBe('running');
  });

  it('adds the turn error as an error step that does not count as a step', () => {
    const s = state({
      error: 'Provider refused',
      toolCalls: [call({ toolCallId: 'c1', name: 'uuid', status: 'completed' })],
    });
    const steps = deriveActivitySteps(s);
    expect(steps.map((x) => x.kind)).toEqual(['tool', 'error']);
    expect(turnSummary(assistant(s)).steps).toBe(1);
  });
});

describe('hydrated turns', () => {
  it('gives a turn without a stream state no steps and an empty summary', () => {
    const turn: ChatTurn = { id: 'm1', role: 'assistant', content: 'Hello' };
    expect(turnActivity(turn)).toEqual([]);
    expect(turnSummary(turn)).toEqual({ steps: 0, sites: 0, failed: 0, running: false, needsYou: false });
  });

  it('gives user turns nothing', () => {
    expect(turnActivity({ id: 'u1', role: 'user', content: 'hi' })).toEqual([]);
  });

  it('reads a turn rebuilt from persisted events', () => {
    const rebuilt = rebuildAssistantStreamStateFromEvents('req-9', [
      { kind: 'toolCallStart', toolCallId: 's1', toolId: 'web_search', name: 'web_search' },
      { kind: 'toolCallComplete', toolCallId: 's1', arguments: { query: 'weather' } },
      { kind: 'searchSources', sources: [{ title: 'Met', url: 'https://met.example/x' }] },
      { kind: 'messageComplete', finishReason: 'stop' },
    ] as unknown as ProviderEvent[]);
    const turn = assistant(rebuilt);
    expect(turnActivity(turn)).toEqual([expect.objectContaining({ kind: 'search', label: 'weather', status: 'done' })]);
    expect(turnSummary(turn)).toMatchObject({ steps: 1, sites: 1, running: false });
  });
});

describe('turnMatchesId', () => {
  it('matches the persisted id or the live request id', () => {
    const turn = assistant(state({ requestId: 'req-7' }), 'm7');
    expect(turnMatchesId(turn, 'm7')).toBe(true);
    expect(turnMatchesId(turn, 'req-7')).toBe(true);
    expect(turnMatchesId(turn, 'other')).toBe(false);
  });
});
