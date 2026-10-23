/// The agent calls running now, across chats and workflow runs: read once at
/// start (`list_running_agent_calls`), then kept by the `agent-call-changed`
/// event the backend sends whenever a call starts or ends. No polling.

import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { listRunningAgentCalls } from '../ipc/client';
import type { AgentCallChange } from '../ipc/contracts';

export const AGENT_CALL_CHANGED_EVENT = 'agent-call-changed';

/// The running calls after `change`: added or updated while running, gone once ended.
export function applyAgentCallChange(
  running: readonly AgentCallChange[],
  change: AgentCallChange,
): AgentCallChange[] {
  const rest = running.filter((row) => row.id !== change.id);
  return change.status === 'running' ? [...rest, change] : rest;
}

/// Oldest first, the order they started in.
function byStart(rows: AgentCallChange[]): AgentCallChange[] {
  return [...rows].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/// The running agent calls, and `onChange` for every start and end as it happens.
export function useRunningAgentCalls(onChange?: (change: AgentCallChange) => void): AgentCallChange[] {
  const [running, setRunning] = useState<AgentCallChange[]>([]);
  const handler = useRef(onChange);
  handler.current = onChange;
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | undefined;
    // Calls that ended before the first read came back: that read may still list them.
    const ended = new Set<string>();
    if (isTauri()) {
      void listen<AgentCallChange>(AGENT_CALL_CHANGED_EVENT, (e) => {
        const change = e.payload;
        if (change.status !== 'running') ended.add(change.id);
        setRunning((current) => byStart(applyAgentCallChange(current, change)));
        handler.current?.(change);
      }).then((unlisten) => {
        if (cancelled) unlisten();
        else stop = unlisten;
      });
    }
    void Promise.resolve()
      .then(() => listRunningAgentCalls())
      .then((rows) => {
        if (cancelled || !Array.isArray(rows)) return;
        setRunning((current) => {
          const known = new Set(current.map((row) => row.id));
          const fresh = rows.filter((row) => row.status === 'running' && !known.has(row.id) && !ended.has(row.id));
          return byStart([...current, ...fresh]);
        });
      })
      .catch(() => {
        // An older backend without the command: the event alone keeps the list.
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
  return running;
}
