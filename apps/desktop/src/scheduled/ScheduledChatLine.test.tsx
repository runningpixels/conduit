import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ScheduledChatLine, scheduledFrom } from './ScheduledChatLine';
import { enTranslate as t } from '../test/enTranslate';
import { describeStep } from '../workflows/describeStep';
import { notificationFor } from '../workflows/workflowRunEvents';

const ipc = vi.hoisted(() => ({ getWorkflow: vi.fn() }));
vi.mock('../ipc/client', () => ipc);

beforeEach(() => {
  ipc.getWorkflow.mockResolvedValue({ id: 'wf-1', name: 'Morning news' });
});

describe('scheduledFrom', () => {
  it('reads which run saved a chat from its metadata', () => {
    expect(scheduledFrom({ scheduled: { workflowId: 'wf-1', runId: 'run-1' } })).toEqual({ workflowId: 'wf-1', runId: 'run-1' });
    expect(scheduledFrom({ scheduled: { workflowId: 'wf-1' } })).toEqual({ workflowId: 'wf-1', runId: null });
  });

  it('is null for an ordinary chat', () => {
    expect(scheduledFrom(undefined)).toBeNull();
    expect(scheduledFrom({ agent: 'x' })).toBeNull();
    expect(scheduledFrom({ scheduled: { runId: 'run-1' } })).toBeNull();
    expect(scheduledFrom({ scheduled: 'nope' })).toBeNull();
  });
});

describe('ScheduledChatLine', () => {
  it('says which task the chat came from and opens it', async () => {
    const onOpen = vi.fn();
    render(<ScheduledChatLine workflowId="wf-1" onOpen={onOpen} />);
    expect(screen.getByText('Scheduled task')).toBeInTheDocument();
    expect(await screen.findByText('Morning news')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open task' }));
    expect(onOpen).toHaveBeenCalledWith('wf-1');
  });
});

describe('a run that saved a chat', () => {
  it('has a step line in the workflow editor', () => {
    expect(describeStep({ id: 'save', type: 'save_chat', title: 'News', prompt: 'Brief me', content: '{{steps.work.text}}' }, t)).toBe(
      'Save as a chat: “News”',
    );
  });

  it('carries the chat’s id on the run-finished event', () => {
    const event = {
      workflowId: 'wf-1',
      workflowName: 'Morning news',
      runId: 'run-1',
      status: 'completed' as const,
      error: null,
      trigger: 'schedule' as const,
      documents: [],
      conversationId: 'chat-1',
    };
    expect(notificationFor(event, t)).toEqual({ title: 'Morning news', body: expect.any(String) });
    expect(event.conversationId).toBe('chat-1');
  });
});
