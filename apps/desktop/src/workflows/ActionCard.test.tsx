import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkflowAction } from '../ipc/contracts';
import { ActionCard } from './ActionCard';

const ipc = vi.hoisted(() => ({ answerWorkflowAction: vi.fn() }));
vi.mock('../ipc/client', () => ipc);

const REMEMBER = "Don't ask again for this in this workflow";

function action(over: Partial<WorkflowAction> = {}): WorkflowAction {
  return {
    runId: 'r1',
    workflowId: 'w1',
    workflowName: 'Morning briefing',
    stepId: 's1',
    connectorId: 'slack',
    connectorName: 'Slack',
    tool: 'post_message',
    description: 'Posts a message to a channel',
    arguments: { channel: '#news', text: 'Line one\nLine two', count: 3 },
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string' },
        text: { type: 'string' },
        count: { type: 'integer' },
        pin: { type: 'boolean' },
        extra: { type: 'array' },
      },
    },
    sensitive: false,
    requestedAt: '2026-10-12T06:00:00Z',
    expiresAt: '2026-10-13T06:00:00Z',
    ...over,
  };
}

function setup(over: Partial<WorkflowAction> = {}) {
  const onAnswered = vi.fn();
  const a = action(over);
  render(<ActionCard action={a} onAnswered={onAnswered} />);
  return { onAnswered, a };
}

beforeEach(() => {
  ipc.answerWorkflowAction.mockReset();
  ipc.answerWorkflowAction.mockResolvedValue(true);
});

describe('ActionCard', () => {
  it('names the tool and connector and shows the arguments', () => {
    setup();
    expect(screen.getByRole('group', { name: 'Check before it sends' })).toBeInTheDocument();
    expect(screen.getByText('“post_message” in Slack')).toBeInTheDocument();
    expect(screen.getByText('Posts a message to a channel')).toBeInTheDocument();
    expect(screen.getByText('channel')).toBeInTheDocument();
    expect(screen.getByText('#news')).toBeInTheDocument();
    expect(screen.getByText(/Line one\s*Line two/)).toBeInTheDocument();
  });

  it('sends as is', async () => {
    const { onAnswered, a } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', { send: true }));
    await waitFor(() => expect(onAnswered).toHaveBeenCalledWith(a, true));
  });

  it('sends edited arguments from a form built from the schema', async () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('text'), { target: { value: 'Changed' } });
    fireEvent.change(screen.getByLabelText('count'), { target: { value: '5' } });
    fireEvent.click(screen.getByLabelText('pin'));
    fireEvent.change(screen.getByLabelText('extra'), { target: { value: '[1, 2]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', {
        send: true,
        arguments: { channel: '#news', text: 'Changed', count: 5, pin: true, extra: [1, 2] },
      }),
    );
  });

  it('blocks sending invalid JSON and shows why', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('extra'), { target: { value: '[1,' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('alert')).toHaveTextContent("That isn't valid JSON.");
    expect(ipc.answerWorkflowAction).not.toHaveBeenCalled();
  });

  it('edits everything as JSON when the schema has no properties', async () => {
    setup({ inputSchema: {} });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('Details to send (JSON)');
    fireEvent.change(box, { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(ipc.answerWorkflowAction).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: '{"a": 1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', { send: true, arguments: { a: 1 } }),
    );
  });

  it('cancels editing back to the read view', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: "Don't send" })).toBeInTheDocument();
  });

  it("doesn't send", async () => {
    const { onAnswered } = setup();
    fireEvent.click(screen.getByRole('button', { name: "Don't send" }));
    await waitFor(() => expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', { send: false }));
    await waitFor(() => expect(onAnswered).toHaveBeenCalled());
  });

  it('remembers the choice when asked', async () => {
    setup();
    fireEvent.click(screen.getByLabelText(REMEMBER));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(ipc.answerWorkflowAction).toHaveBeenCalledWith('r1', 's1', { send: true, remember: true }),
    );
  });

  it("doesn't offer to remember a sensitive tool", () => {
    setup({ sensitive: true });
    expect(screen.queryByLabelText(REMEMBER)).not.toBeInTheDocument();
    expect(screen.getByText('This one always asks first.')).toBeInTheDocument();
  });

  it('shows a refused answer and keeps the card', async () => {
    ipc.answerWorkflowAction.mockRejectedValue(new Error('connector is down'));
    const { onAnswered } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('connector is down');
    expect(onAnswered).not.toHaveBeenCalled();
  });
});
