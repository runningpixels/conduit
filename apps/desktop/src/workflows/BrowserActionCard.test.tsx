import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BrowserRequest, WorkflowAction } from '../ipc/contracts';
import { ActionCard } from './ActionCard';

const ipc = vi.hoisted(() => ({ answerWorkflowAction: vi.fn(), getWorkflowRun: vi.fn() }));
vi.mock('../ipc/client', () => ipc);

function action(browser: BrowserRequest, over: Partial<WorkflowAction> = {}): WorkflowAction {
  return {
    runId: 'r1',
    workflowId: 'w1',
    workflowName: 'Shop check',
    stepId: 's1',
    connectorId: 'browser',
    connectorName: 'Browser',
    tool: browser.action,
    description: null,
    arguments: { ref: 'e7', why: browser.why },
    inputSchema: {},
    sensitive: false,
    browser,
    requestedAt: '2026-11-12T06:00:00Z',
    expiresAt: '2026-11-13T06:00:00Z',
    ...over,
  };
}

const base = {
  host: 'github.com',
  pageUrl: 'https://github.com/search',
  pageTitle: 'Search · GitHub',
};

const newSite: BrowserRequest = {
  ...base,
  action: 'click',
  elementRole: 'link',
  elementName: 'Pricing',
  why: 'Open the pricing page',
  reason: 'newSite',
  offerSite: 'github.com',
};

const submit: BrowserRequest = {
  ...base,
  action: 'type_text',
  elementRole: 'textbox',
  elementName: 'Search',
  text: 'tauri  webview2\nline two',
  why: 'Search for the repo',
  reason: 'submit',
};

const risky: BrowserRequest = {
  ...base,
  action: 'click',
  elementRole: 'button',
  elementName: 'Place order',
  reason: 'risky',
  riskyWord: 'order',
  readBefore: '2 web pages',
};

function setup(request: BrowserRequest) {
  const onAnswered = vi.fn();
  const a = action(request);
  render(<ActionCard action={a} onAnswered={onAnswered} />);
  return { onAnswered, a };
}

beforeEach(() => {
  ipc.answerWorkflowAction.mockReset();
  ipc.answerWorkflowAction.mockResolvedValue(true);
  ipc.getWorkflowRun.mockReset();
  ipc.getWorkflowRun.mockResolvedValue({ run: {}, steps: [] });
});

describe('ActionCard for a browser action', () => {
  it('leads with why, says the action in plain words, the page and the first-time-on-site reason', () => {
    setup(newSite);
    expect(screen.getByRole('group', { name: 'Open the pricing page' })).toBeInTheDocument();
    expect(screen.getByText(/Shop check · step “s1” ·/)).toBeInTheDocument();
    expect(screen.getByText('Click “Pricing” (link)')).toBeInTheDocument();
    expect(screen.getByText('On “Search · GitHub” · github.com')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('First action on github.com in this workflow');
    // Not careful: Do it leads.
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['Do it', 'Always on github.com', 'Don’t']);
    expect(screen.getByRole('button', { name: 'Do it' })).toHaveClass('primary');
  });

  it('“Always on” answers with remember', async () => {
    const { onAnswered, a } = setup(newSite);
    fireEvent.click(screen.getByRole('button', { name: 'Always on github.com' }));
    await waitFor(() => expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', { send: true, remember: true }));
    expect(onAnswered).toHaveBeenCalledWith(a, true);
  });

  it('Do it and Don’t answer without remember', async () => {
    setup(newSite);
    fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
    await waitFor(() => expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', { send: true }));
    ipc.answerWorkflowAction.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Don’t' }));
    await waitFor(() => expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', { send: false }));
  });

  it('shows the full text to type, says it submits a form, and leads with Don’t', () => {
    setup(submit);
    expect(screen.getByText('Type into “Search” (textbox)')).toBeInTheDocument();
    expect(screen.getByLabelText('Text to type').textContent).toBe('tauri  webview2\nline two');
    expect(screen.getByRole('note')).toHaveTextContent('It submits a form');
    expect(screen.queryByRole('button', { name: /Always on/ })).toBeNull();
    const buttons = screen.getAllByRole('button').map((b) => b.textContent);
    expect(buttons).toEqual(['Don’t', 'Do it']);
    expect(screen.getByRole('button', { name: 'Don’t' })).toHaveClass('primary');
    expect(screen.getByRole('group')).toHaveClass('cc-risky');
  });

  it('names the risky word, what it read before, and has no remember option', () => {
    setup(risky);
    expect(screen.getByRole('group', { name: 'The agent wants to act in its browser' })).toBeInTheDocument();
    expect(screen.getByText('Click “Place order” (button)')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('“order” can spend money or change an account');
    expect(screen.getByText('It read outside content first (2 web pages)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Always on/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Don’t' })).toHaveClass('primary');
  });

  it('offers “Always on” on a careful action when the backend offers it', async () => {
    setup({ ...submit, offerSite: 'github.com' });
    fireEvent.click(screen.getByRole('button', { name: 'Always on github.com' }));
    await waitFor(() => expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', { send: true, remember: true }));
  });

  it('says choices and the rest in plain words', () => {
    setup({ ...base, action: 'choose_option', elementRole: 'combobox', elementName: 'Country', option: 'Spain', reason: 'newSite' });
    expect(screen.getByText('Choose “Spain” in “Country”')).toBeInTheDocument();
    expect(screen.getByText('On “Search · GitHub” · github.com')).toBeInTheDocument();
  });

  it('lists what the step did so far', () => {
    setup({
      ...newSite,
      soFar: [
        { action: 'open_page', url: 'https://github.com' },
        { action: 'type_text', elementName: 'Search' },
        { action: 'click', elementName: 'Next' },
        'scrolled down',
      ],
    });
    expect(
      screen.getByText('So far in this run: Opened page “https://github.com” · Typed “Search” · Clicked “Next” · scrolled down'),
    ).toBeInTheDocument();
  });

  it('shows a refused answer', async () => {
    ipc.answerWorkflowAction.mockRejectedValue({ message: 'The run is no longer waiting' });
    setup(newSite);
    fireEvent.click(screen.getByRole('button', { name: 'Do it' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The run is no longer waiting');
  });
});
