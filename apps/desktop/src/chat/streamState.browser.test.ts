import { describe, expect, it } from 'vitest';
import type { BrowserRequest } from '../ipc/contracts';
import {
  allToolCalls,
  applyProviderEvent,
  createAssistantStreamState,
  createReattachedStreamState,
  markInterrupted,
  toolCallAwaitsReader,
  type AssistantStreamState,
} from './streamState';

const request: BrowserRequest = {
  action: 'click',
  host: 'news.ycombinator.com',
  pageUrl: 'https://news.ycombinator.com/',
  pageTitle: 'Hacker News',
  elementRole: 'link',
  elementName: 'comments',
  why: 'Open the comments',
  reason: 'newSite',
  offerSite: 'news.ycombinator.com',
};

function withClick(): AssistantStreamState {
  let state = createAssistantStreamState('req-b');
  state = applyProviderEvent(state, { kind: 'messageStart', requestId: 'req-b', index: 0 });
  state = applyProviderEvent(state, {
    kind: 'toolCallStart',
    requestId: 'req-b',
    toolCallId: 'call-1',
    index: 0,
    toolId: 'click',
    name: 'click',
  });
  return state;
}

const call = (state: AssistantStreamState) => state.toolCalls.find((tc) => tc.toolCallId === 'call-1')!;

describe('streamState browser events', () => {
  it('attaches an approval to its tool call and clears it when resolved', () => {
    let state = applyProviderEvent(withClick(), {
      kind: 'browserApprovalRequested',
      requestId: 'req-b',
      toolCallId: 'call-1',
      request,
    });
    expect(call(state).browserApproval).toEqual(request);
    expect(toolCallAwaitsReader(call(state))).toBe(true);

    state = applyProviderEvent(state, { kind: 'browserPromptResolved', requestId: 'req-b', toolCallId: 'call-1' });
    expect(call(state).browserApproval).toBeUndefined();
    expect(toolCallAwaitsReader(call(state))).toBe(false);
  });

  it('attaches a question with its decline choice and clears it when resolved', () => {
    let state = applyProviderEvent(withClick(), {
      kind: 'browserQuestionRequested',
      requestId: 'req-b',
      toolCallId: 'call-1',
      question: 'This page shows a check for humans. Solve it in the browser window, then continue.',
      decline: 'Skip this page',
    });
    expect(call(state).browserQuestion).toEqual({
      question: 'This page shows a check for humans. Solve it in the browser window, then continue.',
      decline: 'Skip this page',
    });
    expect(toolCallAwaitsReader(call(state))).toBe(true);

    state = applyProviderEvent(state, { kind: 'browserPromptResolved', requestId: 'req-b', toolCallId: 'call-1' });
    expect(call(state).browserQuestion).toBeUndefined();
  });

  it('a question replaces an approval on the same call', () => {
    let state = applyProviderEvent(withClick(), {
      kind: 'browserApprovalRequested',
      requestId: 'req-b',
      toolCallId: 'call-1',
      request,
    });
    state = applyProviderEvent(state, {
      kind: 'browserQuestionRequested',
      requestId: 'req-b',
      toolCallId: 'call-1',
      question: 'Sign in to GitHub in the browser window.',
      decline: 'Don’t sign in',
    });
    expect(call(state).browserApproval).toBeUndefined();
    expect(call(state).browserQuestion?.decline).toBe('Don’t sign in');
  });

  it('ignores an event for a tool call it does not know', () => {
    const before = withClick();
    const after = applyProviderEvent(before, {
      kind: 'browserApprovalRequested',
      requestId: 'req-b',
      toolCallId: 'call-unknown',
      request,
    });
    expect(allToolCalls(after).some((tc) => tc.browserApproval)).toBe(false);
  });

  it('drops a waiting card when the tool finishes or the turn is stopped', () => {
    const waiting = applyProviderEvent(withClick(), {
      kind: 'browserApprovalRequested',
      requestId: 'req-b',
      toolCallId: 'call-1',
      request,
    });
    const finished = applyProviderEvent(waiting, {
      kind: 'toolExecutionFinished',
      requestId: 'req-b',
      toolCallId: 'call-1',
      toolName: 'click',
      isError: false,
    });
    expect(call(finished).browserApproval).toBeUndefined();

    const stopped = markInterrupted(waiting);
    expect(call(stopped).browserApproval).toBeUndefined();
  });
});

describe('a reattached reply waiting on the browser', () => {
  it('draws the call and its card again after a reload', () => {
    const state = createReattachedStreamState('req-b', null, {
      toolCallId: 'call-1',
      toolName: 'click',
      arguments: { ref: 'e4' },
      event: { kind: 'browserApprovalRequested', requestId: 'req-b', toolCallId: 'call-1', request },
    });
    expect(state.segments).toEqual([{ kind: 'tool', toolCallId: 'call-1' }]);
    expect(call(state).name).toBe('click');
    expect(call(state).arguments).toEqual({ ref: 'e4' });
    expect(call(state).browserApproval).toEqual(request);
    expect(toolCallAwaitsReader(call(state))).toBe(true);
  });

  it('keeps a question with its code and values', () => {
    const state = createReattachedStreamState('req-b', null, {
      toolCallId: 'call-1',
      toolName: 'ask_to_sign_in',
      arguments: {},
      event: {
        kind: 'browserQuestionRequested',
        requestId: 'req-b',
        toolCallId: 'call-1',
        question: 'Sign in to github.com…',
        code: 'chat.browser.question.signIn',
        params: { site: 'github.com' },
        decline: 'Don’t sign in',
      },
    });
    expect(call(state).browserQuestion).toEqual({
      question: 'Sign in to github.com…',
      code: 'chat.browser.question.signIn',
      params: { site: 'github.com' },
      decline: 'Don’t sign in',
    });
  });
});
