import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { HelperControls } from '../agents/HelperControls';
import { HelperTotals } from '../agents/HelperTotals';
import { useNodeCosts, type NodeUsage } from '../agents/helperCost';
import { ProviderBadge, splitModel } from '../agents/ProviderBadge';
import { useNow } from '../agents/useNow';
import { AgentsIcon } from '../icons';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { ChatProse } from './ChatProse';
import { ToolCallBlock } from './ToolCallBlock';
import { allToolCalls, currentTool, type AssistantStreamState, type ToolCallState } from './streamState';

interface HandoffBlockProps {
  toolCall: ToolCallState;
  conversationId?: string | null;
}

const STATUS_KEYS = {
  running: 'chat.handoff.status.running',
  done: 'chat.handoff.status.done',
  failed: 'chat.handoff.status.failed',
  stopped: 'chat.handoff.status.stopped',
} as const;

/** The nth block with this id: agent rounds reuse block ids. */
function blockByOrdinal(inner: AssistantStreamState, blockId: string, occurrence: number) {
  let seen = 0;
  for (const block of inner.blocks) {
    if (block.blockId !== blockId) continue;
    if (seen === occurrence) return block;
    seen += 1;
  }
  return undefined;
}

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

/** One tool call from inside a hand-off: another hand-off, or an ordinary call. */
function renderCall(call: ToolCallState, conversationId: string | null | undefined): ReactNode {
  return call.handoff ? (
    <HandoffBlock key={call.toolCallId} toolCall={call} conversationId={conversationId} />
  ) : (
    <ToolCallBlock key={call.toolCallId} toolCall={call} conversationId={conversationId} />
  );
}

/** A piece of work the assistant handed to one of the user's agents: one
 *  collapsible line (agent, task, status, model, tokens, time) whose body is that
 *  agent's own tool calls and answer. Shares the tool card's structure and CSS. */
export function HandoffBlock({ toolCall, conversationId = null }: HandoffBlockProps) {
  const t = useT();
  const fmt = useFormatters();
  const handoff = toolCall.handoff;
  const running = handoff?.status === 'running';
  const needsApproval = handoff
    ? allToolCalls(handoff.inner).some((tc) => tc.sideEffecting && tc.consent === 'pending')
    : false;
  const [open, setOpen] = useState(running || needsApproval);
  useEffect(() => {
    if (running || needsApproval) setOpen(true);
  }, [running, needsApproval]);
  const now = useNow(Boolean(running));
  const nodes = useMemo<NodeUsage[]>(
    () =>
      handoff
        ? [{ model: handoff.model, tokens: handoff.tokens, ...handoff.usage }]
        : [],
    [handoff],
  );
  const { costOf } = useNodeCosts(nodes);
  if (!handoff) return null;

  const failed = handoff.status === 'failed';
  const statusText = t(STATUS_KEYS[handoff.status]);
  const endedAt = handoff.endedAt ?? (running ? now : handoff.startedAt);
  const elapsed = fmt.duration(Math.max(0, endedAt - handoff.startedAt));
  const tool = running ? currentTool(handoff.inner) : null;
  const cents = nodes[0] ? costOf(nodes[0]) : null;
  const summary = [
    handoff.task,
    statusText,
    tool,
    splitModel(handoff.model).modelId,
    handoff.tokens > 0 ? t('chat.handoff.tokens', { count: fmt.count(handoff.tokens) }) : '',
    cents !== null ? fmt.money(cents) : '',
    elapsed,
  ]
    .filter(Boolean)
    .join(' · ');

  const { inner } = handoff;
  const occurrences = new Map<string, number>();
  const body: ReactNode[] = [];
  const shown = new Set<string>();
  let streamedText = false;
  inner.segments.forEach((seg, index) => {
    if (seg.kind === 'text') {
      const occ = occurrences.get(seg.blockId) ?? 0;
      occurrences.set(seg.blockId, occ + 1);
      const block = blockByOrdinal(inner, seg.blockId, occ);
      if (block && block.content.length > 0) {
        streamedText = true;
        body.push(
          <ChatProse
            key={`text-${seg.blockId}-${occ}`}
            content={block.content}
            citations={block.citations}
            streaming={Boolean(running) && index === inner.segments.length - 1}
          />,
        );
      }
    } else if (seg.kind === 'tool') {
      const call = inner.toolCalls.find((c) => c.toolCallId === seg.toolCallId);
      if (call && !shown.has(call.toolCallId)) {
        shown.add(call.toolCallId);
        body.push(renderCall(call, conversationId));
      }
    }
  });
  // A reloaded turn keeps the agent's tool calls but not its streamed text.
  if (!streamedText && handoff.answer) {
    body.push(<ChatProse key="answer" content={handoff.answer} streaming={false} />);
  }

  return (
    <div className={`tool handoff${running ? ' running' : ''}`} data-open={open ? 'true' : 'false'}>
      {/* Stays in view while a long hand-off scrolls past, so Stop and
          Redirect are always at hand. */}
      <div className="handoff-top">
        <button
          type="button"
          className="tool-head"
          aria-expanded={open}
          title={handoff.task}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="tool-icon">
            <AgentsIcon />
          </span>
          <span className="tool-name">{handoff.name}</span>
          <ProviderBadge model={handoff.model} />
          <span className={`tool-sum${failed ? ' err' : ''}`} title={summary}>
            {summary}
          </span>
          <svg className="tool-chev" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m9 6 6 6-6 6" /></svg>
        </button>
        {running && handoff.callId ? <HelperControls callId={handoff.callId} name={handoff.name} /> : null}
      </div>
      <div className="tool-body">
        <div>
          <div className="tool-inner handoff-inner">
            {/* A lead writes long tasks: three lines until clicked. */}
            <details className="handoff-task">
              <summary>
                <span className="handoff-task-label">{t('chat.handoff.task')}</span>
                <span className="handoff-task-text">{handoff.task}</span>
              </summary>
            </details>
            {body}
            {running && body.length === 0 ? (
              <p className="handoff-note">{t('chat.handoff.status.running')}</p>
            ) : null}
            {handoff.error ? <div className="tool-out tool-out-prose">{handoff.error}</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
