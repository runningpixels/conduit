/// The line at the top of a chat a scheduled run saved: "Scheduled task · <name> · Open task". The
/// run marks its chat with the conversation metadata `{ scheduled: { workflowId, runId } }`.

import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { getWorkflow } from '../ipc/client';
import { ClockIcon } from '../icons';

/// Which scheduled run saved a chat, read from its metadata; null for an ordinary chat.
export function scheduledFrom(metadata: Record<string, unknown> | undefined | null): { workflowId: string; runId: string | null } | null {
  const scheduled = metadata?.scheduled;
  if (!scheduled || typeof scheduled !== 'object') return null;
  const { workflowId, runId } = scheduled as { workflowId?: unknown; runId?: unknown };
  if (typeof workflowId !== 'string' || workflowId === '') return null;
  return { workflowId, runId: typeof runId === 'string' ? runId : null };
}

export function ScheduledChatLine({ workflowId, onOpen }: { workflowId: string; onOpen?: (workflowId: string) => void }) {
  const t = useT();
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setName(null);
    Promise.resolve()
      .then(() => getWorkflow(workflowId))
      .then((record) => {
        if (!cancelled) setName(record.name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workflowId]);
  return (
    <p className="sched-chat-line">
      <ClockIcon aria-hidden="true" />
      <span>{t('shell.scheduled.chatLine')}</span>
      {name ? (
        <>
          <span aria-hidden="true">·</span>
          <b>{name}</b>
        </>
      ) : null}
      {onOpen ? (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" className="sched-chat-open" onClick={() => onOpen(workflowId)}>
            {t('shell.scheduled.openTask')}
          </button>
        </>
      ) : null}
    </p>
  );
}
