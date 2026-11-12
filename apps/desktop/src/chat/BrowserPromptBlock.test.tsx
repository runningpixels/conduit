import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BrowserRequest } from '../ipc/contracts';
import type { ToolCallState } from './streamState';
import { ToolCallBlock } from './ToolCallBlock';

const ipc = vi.hoisted(() => ({
  approveConnectorToolCall: vi.fn(),
  denyConnectorToolCall: vi.fn(),
  answerBrowserAction: vi.fn(),
  answerBrowserQuestion: vi.fn(),
}));
vi.mock('../ipc/client', () => ipc);

const base = {
  host: 'github.com',
  pageUrl: 'https://github.com/notifications',
  pageTitle: 'Notifications',
};

const newSite: BrowserRequest = {
  ...base,
  action: 'click',
  elementRole: 'link',
  elementName: 'tauri-apps/tauri#1234',
  why: 'Open the first notification',
  reason: 'newSite',
  offerSite: 'github.com',
};

const submit: BrowserRequest = {
  ...base,
  action: 'type_text',
  elementRole: 'textbox',
  elementName: 'Comment',
  text: 'Thanks!',
  reason: 'submit',
  offerSite: 'github.com',
};

function call(over: Partial<ToolCallState>): ToolCallState {
  return {
    toolCallId: 'tc-9',
    toolId: 'click',
    name: 'click',
    argumentsText: '{}',
    arguments: { ref: 'e3', why: 'Open the first notification' },
    complete: true,
    status: 'running',
    ...over,
  };
}

beforeEach(() => {
  ipc.answerBrowserAction.mockReset().mockResolvedValue(true);
  ipc.answerBrowserQuestion.mockReset().mockResolvedValue(true);
});

describe('ToolCallBlock browser approval', () => {
  it('shows what it wants to do and why, on the tool row', () => {
    render(<ToolCallBlock toolCall={call({ browserApproval: newSite })} conversationId="conv-1" />);
    const card = screen.getByRole('group', { name: 'Open the first notification' });
    expect(card).toHaveTextContent('github.com');
    expect(card.querySelector('.cc-chip')).not.toBeNull();
  });

  it('leads with Do it, offers the site and all sites, and Don’t last', () => {
    render(<ToolCallBlock toolCall={call({ browserApproval: newSite })} />);
    const buttons = Array.from(document.querySelectorAll('.browser-consent .row button')).map((b) => b.textContent);
    expect(buttons).toEqual(['Do it', 'Always on github.com', 'Allow on all sites', 'Don’t']);
    expect(screen.getByRole('button', { name: 'Do it' })).toHaveClass('primary');
    expect(screen.getByRole('button', { name: 'Don’t' })).toHaveClass('ghost');
  });

  it.each([
    ['Do it', [true, undefined]],
    ['Don’t', [false, undefined]],
    ['Always on github.com', [true, 'site']],
    ['Allow on all sites', [true, 'all']],
  ] as const)('“%s” answers with %j', async (label, [send, remember]) => {
    render(<ToolCallBlock toolCall={call({ browserApproval: newSite })} />);
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() => expect(ipc.answerBrowserAction).toHaveBeenCalledWith('tc-9', send, remember));
  });

  it('leads with Don’t for a submit, and shows the full text it would type', () => {
    render(<ToolCallBlock toolCall={call({ name: 'type_text', browserApproval: submit })} />);
    expect(screen.getByRole('button', { name: 'Don’t' })).toHaveClass('primary');
    expect(screen.getByRole('button', { name: 'Do it' })).not.toHaveClass('primary');
    expect(document.querySelector('.browser-consent')).toHaveClass('cc-risky');
    expect(document.querySelector('.cc-term')?.textContent).toBe('Thanks!');
  });

  it('offers no site buttons without offerSite', () => {
    render(<ToolCallBlock toolCall={call({ browserApproval: { ...newSite, offerSite: undefined } })} />);
    expect(screen.queryByRole('button', { name: /Always on/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Allow on all sites' })).toBeNull();
  });

  it('says so when the answer could not be sent', async () => {
    ipc.answerBrowserAction.mockRejectedValue(new Error('gone'));
    render(<ToolCallBlock toolCall={call({ browserApproval: newSite })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('gone');
  });
});

describe('ToolCallBlock browser question', () => {
  const question = call({
    name: 'open_page',
    browserQuestion: { question: 'Sign in to GitHub in the browser window, then continue.', decline: 'Don’t sign in' },
  });

  it('shows the question with Continue as the main button and the decline as a quiet one', () => {
    render(<ToolCallBlock toolCall={question} />);
    expect(screen.getByRole('group', { name: 'Sign in to GitHub in the browser window, then continue.' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveClass('primary');
    expect(screen.getByRole('button', { name: 'Don’t sign in' })).toHaveClass('ghost');
  });

  it('Continue goes on', async () => {
    render(<ToolCallBlock toolCall={question} />);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(ipc.answerBrowserQuestion).toHaveBeenCalledWith('tc-9', true));
  });

  it('the decline choice does not', async () => {
    render(<ToolCallBlock toolCall={question} />);
    fireEvent.click(screen.getByRole('button', { name: 'Don’t sign in' }));
    await waitFor(() => expect(ipc.answerBrowserQuestion).toHaveBeenCalledWith('tc-9', false));
  });
});
