import { useMemo } from 'react';
import { HelperTotals } from '../agents/HelperTotals';
import { useNodeCosts, type NodeUsage } from '../agents/helperCost';
import { useNow } from '../agents/useNow';
import { AgentsIcon, ChevronRight } from '../icons';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { handoffNeedsApproval } from './agentViewModel';
import { allToolCalls, type AssistantStreamState, type HandoffState, type ToolCallState } from './streamState';

export const HANDOFF_STATUS_KEYS = {
  running: 'chat.handoff.status.running',
  done: 'chat.handoff.status.done',
  failed: 'chat.handoff.status.failed',
  stopped: 'chat.handoff.status.stopped',
} as const;

/** What every helper of a message used (nested ones too), by model; nothing when it has none. */
export function HandoffTotals({ state }: { state: AssistantStreamState }) {
  const t = useT();
  const nodes = useMemo<NodeUsage[]>(
    () =>
      allToolCalls(state).flatMap((tc) =>
        tc.handoff ? [{ model: tc.handoff.model, tokens: tc.handoff.tokens, ...tc.handoff.usage }] : [],
      ),
    [state],
  );
  if (nodes.length === 0) return null;
  return <HelperTotals nodes={nodes} title={t('chat.handoff.totals.title')} />;
}

/** A helper's tokens, cost and time so far ("1,234 tokens · $0.01 · 12s"). */
export function useHandoffNumbers(handoff: HandoffState): string {
  const t = useT();
  const fmt = useFormatters();
  const running = handoff.status === 'running';
  const now = useNow(running);
  const nodes = useMemo<NodeUsage[]>(
    () => [{ model: handoff.model, tokens: handoff.tokens, ...handoff.usage }],
    [handoff.model, handoff.tokens, handoff.usage],
  );
  const { costOf } = useNodeCosts(nodes);
  const cents = costOf(nodes[0]);
  const endedAt = handoff.endedAt ?? (running ? now : handoff.startedAt);
  return [
    handoff.tokens > 0 ? t('chat.handoff.tokens', { count: fmt.count(handoff.tokens) }) : '',
    cents !== null ? fmt.money(cents) : '',
    fmt.duration(Math.max(0, endedAt - handoff.startedAt)),
  ]
    .filter(Boolean)
    .join(' · ');
}

interface HandoffLineProps {
  toolCall: ToolCallState;
  /** Open this helper's own view. */
  onOpen?: () => void;
}

/** A piece of work the assistant handed to one of the user's agents, as one
 *  line: agent, task, status, tokens and cost, time. The line opens the
 *  agent's own view, where its work, approvals and controls are. */
export function HandoffLine({ toolCall, onOpen }: HandoffLineProps) {
  return toolCall.handoff ? <HandoffLineRow handoff={toolCall.handoff} onOpen={onOpen} /> : null;
}

function HandoffLineRow({ handoff, onOpen }: { handoff: HandoffState; onOpen?: () => void }) {
  const t = useT();
  const numbers = useHandoffNumbers(handoff);
  const needsApproval = handoff.status === 'running' && handoffNeedsApproval(handoff);
  const status = needsApproval ? t('chat.agentView.needsApproval') : t(HANDOFF_STATUS_KEYS[handoff.status]);
  return (
    <div
      className="handoff-line"
      data-status={handoff.status}
      data-approval={needsApproval ? 'true' : undefined}
    >
      <button
        type="button"
        className="handoff-line-main"
        title={handoff.task}
        aria-label={t('chat.agentView.openAria', { name: handoff.name, task: handoff.task })}
        onClick={onOpen}
      >
        <span className="handoff-line-icon" aria-hidden="true">
          <AgentsIcon />
        </span>
        <span className="handoff-line-name">{handoff.name}</span>
        <span className="handoff-line-task">{handoff.task}</span>
        <span className="handoff-line-status" data-status={needsApproval ? 'waiting' : handoff.status}>
          {status}
        </span>
        {numbers ? <span className="handoff-line-nums">{numbers}</span> : null}
        <ChevronRight className="handoff-line-chev" aria-hidden="true" />
      </button>
      {needsApproval ? (
        <button type="button" className="btn handoff-line-review" onClick={onOpen}>
          {t('chat.agentView.review')}
        </button>
      ) : null}
    </div>
  );
}

/** "Waiting for 3 agents", above the lines of a turn whose helpers run side by side. */
export function HandoffWaitingLabel({ count }: { count: number }) {
  const t = useT();
  return (
    <p className="handoff-waiting" role="status">
      {t('chat.agentView.waitingFor', { count })}
    </p>
  );
}
