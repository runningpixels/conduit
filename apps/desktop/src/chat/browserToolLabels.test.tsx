import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createAssistantStreamState, type ToolCallState } from './streamState';
import { deriveActivitySteps } from '../inspector/turnActivity';
import { stepName } from '../inspector/stepPresentation';
import { BrowserApprovalGate } from './BrowserPromptBlock';
import type { BrowserRequest } from '../ipc/contracts';

vi.mock('../ipc/client', () => ({
  answerBrowserQuestion: vi.fn(async () => undefined),
  answerBrowserAction: vi.fn(async () => undefined),
}));

const t = ((key: string) => `t:${key}`) as Parameters<typeof stepName>[1];

function call(over: Partial<ToolCallState> & { toolCallId: string; name: string }): ToolCallState {
  return { toolId: over.name, argumentsText: '', complete: true, status: 'completed', ...over };
}

describe('browser tools in a chat', () => {
  it('labels browser steps for people and says what an action was for', () => {
    const steps = deriveActivitySteps({
      ...createAssistantStreamState('req-1'),
      streaming: false,
      toolCalls: [
        call({ toolCallId: 'a', name: 'open_page', arguments: { url: 'https://en.wikipedia.org' } }),
        call({ toolCallId: 'b', name: 'click', arguments: { ref: 'e4', why: 'Open the search page' } }),
      ],
    });
    expect(steps.map((s) => [stepName(s.name, t), s.label])).toEqual([
      ['t:chat.toolCall.browser.opened', 'https://en.wikipedia.org'],
      ['t:chat.toolCall.browser.clicked', 'Open the search page'],
    ]);
    expect(stepName('workspace_read', t)).toBe('workspace_read');
  });

  it('says "in this chat" on a chat card for a new site', () => {
    const request: BrowserRequest = {
      action: 'click',
      host: 'en.wikipedia.org',
      pageUrl: 'https://en.wikipedia.org/',
      pageTitle: 'Wikipedia',
      elementRole: 'link',
      elementName: 'Search',
      reason: 'newSite',
    } as BrowserRequest;
    render(<BrowserApprovalGate toolCallId="call-1" request={request} />);
    expect(screen.getByText('First action on en.wikipedia.org in this chat')).toBeInTheDocument();
  });
});
