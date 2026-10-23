import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AgentCallChange } from '../ipc/contracts';

const tauri = vi.hoisted(() => ({
  handler: null as null | ((e: { payload: unknown }) => void),
  listRunningAgentCalls: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, handler: (e: { payload: unknown }) => void) => {
    tauri.handler = handler;
    return () => {
      tauri.handler = null;
    };
  }),
}));
vi.mock('../ipc/client', () => ({ listRunningAgentCalls: tauri.listRunningAgentCalls }));

import { applyAgentCallChange, useRunningAgentCalls } from './runningAgentCalls';

function row(id: string, extra: Partial<AgentCallChange> = {}): AgentCallChange {
  return {
    id,
    kind: 'helper',
    agentId: 'researcher',
    name: 'Researcher',
    task: 'Look it up',
    status: 'running',
    conversationId: 'c1',
    startedAt: `2026-10-21T08:00:0${id.slice(-1)}Z`,
    ...extra,
  };
}

beforeEach(() => {
  tauri.handler = null;
  tauri.listRunningAgentCalls.mockReset();
});

describe('applyAgentCallChange', () => {
  it('adds a running call, updates it, and drops it when it ends', () => {
    let running = applyAgentCallChange([], row('a1'));
    running = applyAgentCallChange(running, row('a1', { task: 'Changed' }));
    expect(running).toEqual([row('a1', { task: 'Changed' })]);
    expect(applyAgentCallChange(running, row('a1', { status: 'done' }))).toEqual([]);
  });
});

describe('useRunningAgentCalls', () => {
  it('starts from the running list and follows the event', async () => {
    tauri.listRunningAgentCalls.mockResolvedValue([row('a1'), row('a2')]);
    const onChange = vi.fn();
    const { result } = renderHook(() => useRunningAgentCalls(onChange));
    await waitFor(() => expect(result.current.map((r) => r.id)).toEqual(['a1', 'a2']));
    await waitFor(() => expect(tauri.handler).not.toBeNull());
    act(() => tauri.handler?.({ payload: row('a3') }));
    expect(result.current).toHaveLength(3);
    act(() => tauri.handler?.({ payload: row('a1', { status: 'done' }) }));
    expect(result.current.map((r) => r.id)).toEqual(['a2', 'a3']);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(row('a1', { status: 'done' }));
  });

  it('does not bring back a call that ended before the first list arrived', async () => {
    let answer: (rows: AgentCallChange[]) => void = () => {};
    tauri.listRunningAgentCalls.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { result } = renderHook(() => useRunningAgentCalls());
    await waitFor(() => expect(tauri.handler).not.toBeNull());
    act(() => tauri.handler?.({ payload: row('a1', { status: 'done' }) }));
    await act(async () => answer([row('a1'), row('a2')]));
    expect(result.current.map((r) => r.id)).toEqual(['a2']);
  });
});
