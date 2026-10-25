import { describe, expect, it, vi } from 'vitest';
import { announceAgentCall, isWatchingAgentCall, type AgentCallNoticeDeps } from './agentCallNotices';
import type { AgentCallChange } from '../ipc/contracts';
import type { StatusState } from '../chat/statusTypes';

const t = (id: string, values?: Record<string, unknown>) => `${id}${values ? ` ${JSON.stringify(values)}` : ''}`;

function change(extra: Partial<AgentCallChange> = {}): AgentCallChange {
  return {
    id: 'call-1',
    kind: 'helper',
    agentId: 'researcher',
    name: 'Researcher',
    task: 'Germany prices',
    status: 'done',
    conversationId: 'c1',
    startedAt: '2026-10-21T08:00:00Z',
    finishedAt: '2026-10-21T08:01:00Z',
    ...extra,
  };
}

function deps(extra: Partial<AgentCallNoticeDeps> = {}) {
  const toasts: StatusState[] = [];
  const d = {
    t,
    watching: false,
    focused: true,
    pushToast: vi.fn((toast: StatusState) => void toasts.push(toast)),
    openAgentView: vi.fn(),
    notify: vi.fn(),
    ...extra,
  };
  return { d, toasts };
}

describe('announceAgentCall', () => {
  it('toasts a finished chat helper with Open, which opens its view', () => {
    const { d, toasts } = deps();
    expect(announceAgentCall(change(), d)).toBe(true);
    expect(toasts).toHaveLength(1);
    expect(toasts[0].brief).toBe('chat.agentView.toastFinished {"name":"Researcher","task":"Germany prices"}');
    expect(toasts[0].kind).toBe('success');
    expect(toasts[0].action?.label).toBe('chat.agentView.open');
    toasts[0].action?.run();
    expect(d.openAgentView).toHaveBeenCalledWith('c1', 'call-1');
  });

  it('says so when one could not finish', () => {
    const { d, toasts } = deps();
    announceAgentCall(change({ status: 'failed', error: 'Out of tokens.' }), d);
    expect(toasts[0].brief).toContain('chat.agentView.toastFailed');
    expect(toasts[0].detail).toBe('Out of tokens.');
  });

  it('says nothing about the helper being watched', () => {
    const { d } = deps({ watching: true });
    expect(announceAgentCall(change(), d)).toBe(false);
    expect(d.pushToast).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
  });

  it('notifies the desktop only when the window is not focused', () => {
    const focused = deps();
    announceAgentCall(change(), focused.d);
    expect(focused.d.notify).not.toHaveBeenCalled();
    const away = deps({ focused: false });
    announceAgentCall(change(), away.d);
    expect(away.d.notify).toHaveBeenCalledWith('Researcher', away.toasts[0].brief);
  });

  it('leaves workflow helpers, stopped and starting calls, and @ turns to others', () => {
    const { d } = deps();
    expect(announceAgentCall(change({ runId: 'r1', workflowId: 'w1' }), d)).toBe(false);
    expect(announceAgentCall(change({ status: 'stopped' }), d)).toBe(false);
    expect(announceAgentCall(change({ status: 'running' }), d)).toBe(false);
    expect(announceAgentCall(change({ kind: 'chat' }), d)).toBe(false);
    expect(announceAgentCall(change({ conversationId: null }), d)).toBe(false);
    expect(d.pushToast).not.toHaveBeenCalled();
  });

  it('shortens a long task', () => {
    const { d, toasts } = deps();
    announceAgentCall(change({ task: 'x'.repeat(200) }), d);
    expect(toasts[0].brief).toContain(`${'x'.repeat(79)}…`);
  });
});

describe('isWatchingAgentCall', () => {
  it('counts an open view and one still being opened, only while in chats', () => {
    expect(isWatchingAgentCall('call-1', true, { callId: 'call-1' }, null)).toBe(true);
    expect(isWatchingAgentCall('call-1', true, null, { callId: 'call-1' })).toBe(true);
    expect(isWatchingAgentCall('call-1', true, { callId: 'call-2' }, null)).toBe(false);
    expect(isWatchingAgentCall('call-1', false, { callId: 'call-1' }, null)).toBe(false);
  });
});
