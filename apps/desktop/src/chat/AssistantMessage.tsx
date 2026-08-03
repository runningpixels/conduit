import { useEffect, useRef, useState } from 'react';
import { ReasoningBlock } from './ReasoningBlock';
import { ChatProse } from './ChatProse';
import { ThinkingIndicator } from './ThinkingIndicator';
import type { AssistantStreamState, ToolCallState } from './streamState';
import type { Artifact, FileState } from '../ipc/contracts';
import type { ArtifactCandidate } from './artifactCandidates';
import { BotGlyph, CheckIcon, CopyIcon, PencilIcon, TrashIcon } from '../icons';
import { InterruptedBanner } from './InterruptedBanner';
import { ToolCallBlock } from './ToolCallBlock';
import { SearchCallGroup } from './SearchCallGroup';
import { isWebSearchToolCall } from './SearchCallBlock';
import { UsageSummary } from './UsageSummary';
import { AssistantArtifactStrip } from './ArtifactRefChip';

interface AssistantMessageProps {
  state: AssistantStreamState;
  modelId?: string;
  /// Real persisted message id (for artifact linkage). Absent for the
  /// still-streaming live message — the strip hides promote affordances then.
  messageId?: string;
  /// Conversation artifacts, for the in-chat reference chips.
  artifacts?: Artifact[];
  /// Per-artifact file-state, for the chip state dots.
  fileStateMap?: Record<string, FileState>;
  /// Promote a detected fenced-block candidate to an artifact (App handles the
  /// create + setContent + open flow).
  onPromoteArtifact?: (messageId: string, candidate: ArtifactCandidate) => void;
  /// Open an existing artifact in the DocumentPanel (chip click).
  onOpenArtifact?: (artifactId: string) => void;
  /// P3.1 — retry this turn (remove last assistant turn + resend the prompt).
  onRetry?: () => void;
  /// P3.2 — delete this turn (removes the last assistant turn from local history).
  onDelete?: () => void;
  /// Whether this is the last persisted turn (gates retry/delete affordances).
  isLast?: boolean;
}

/** P3.3 — group consecutive same-name tool calls into one collapsible card. */
export function groupToolCalls(calls: ToolCallState[]): (ToolCallState | { group: true; name: string; calls: ToolCallState[] })[] {
  const out: (ToolCallState | { group: true; name: string; calls: ToolCallState[] })[] = [];
  let run: ToolCallState[] = [];
  let runName = '';
  for (const call of calls) {
    if (run.length === 0 || call.name === runName) {
      run.push(call);
      runName = call.name;
    } else {
      out.push(run.length > 1 ? { group: true, name: runName, calls: run } : run[0]);
      run = [call];
      runName = call.name;
    }
  }
  if (run.length > 0) {
    out.push(run.length > 1 ? { group: true, name: runName, calls: run } : run[0]);
  }
  return out;
}

/** P3.9 — live elapsed-time counter for the streaming header. */
function useLiveElapsed(active: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef<number>(Date.now());
  useEffect(() => {
    if (!active) {
      startRef.current = Date.now();
      setElapsed(0);
      return;
    }
    startRef.current = Date.now();
    setElapsed(0);
    const id = window.setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return elapsed;
}

/** v5 assistant message: av-role bot avatar, prose body with inline code chips,
 *  streaming `.active` accent bar + blinking `.cursor` caret, `enter` fade-up.
 *  Deliberate delta from the mockup: a copy affordance on assistant messages.
 *  V6 adds: retry/delete actions (P3.1/P3.2), live elapsed·tokens meta (P3.9),
 *  grouped collapsible tool calls (P3.3/3.4), and a streaming live region (P5.2). */
export function AssistantMessage({
  state,
  modelId,
  messageId,
  artifacts,
  fileStateMap,
  onPromoteArtifact,
  onOpenArtifact,
  onRetry,
  onDelete,
  isLast = true,
}: AssistantMessageProps) {
  const [copied, setCopied] = useState(false);
  const text = state.blocks.map((b) => b.content).join('');
  const webSearchCalls = state.toolCalls.filter(isWebSearchToolCall);
  const otherToolCalls = state.toolCalls.filter((tc) => !isWebSearchToolCall(tc));
  const grouped = groupToolCalls(otherToolCalls);
  const elapsed = useLiveElapsed(state.streaming);
  const tokenCount = Math.round(text.length / 4);

  async function handleCopy() {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard may be unavailable; fail silently */
    }
  }

  const showActions = !!messageId && isLast && !state.streaming;

  return (
    <div
      className={`msg${state.streaming ? ' active enter' : ' enter'}`}
      {...(messageId ? { 'data-message-id': messageId } : {})}
    >
      {/* P5.2 — visually-hidden live region announcing stream completion */}
      <span className="sr-only" role="status" aria-live="polite">
        {state.streaming ? 'Response in progress.' : state.error ? 'Response finished with an error.' : state.interrupted ? 'Response stopped.' : text.trim() ? 'Response complete.' : ''}
      </span>
      <div className="av-role bot">
        <BotGlyph />
      </div>
      <div className="msg-body">
        <div className="msg-from">
          <b>Assistant</b>
          {modelId && <span className="model">{modelId}</span>}
          {state.agentPhase && (
            <span className="phase-badge" title={state.agentPhase.subPhase}>
              Round {state.agentPhase.round}
              {state.agentPhase.totalRounds ? `/${state.agentPhase.totalRounds}` : ''}
            </span>
          )}
          {/* P3.9 — live generation meta */}
          {state.streaming && (
            <span className="msg-meta">
              <span className="live-dot" aria-hidden="true" />
              {elapsed}s · {tokenCount} tok
            </span>
          )}
          <div className="msg-actions">
            <button
              type="button"
              className="icon-btn"
              aria-label={copied ? 'Copied' : 'Copy message'}
              title={copied ? 'Copied' : 'Copy message'}
              onClick={handleCopy}
              disabled={!text}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
            {showActions && onRetry && (
              <button
                type="button"
                className="icon-btn"
                aria-label="Retry"
                title="Retry this response"
                onClick={onRetry}
              >
                <PencilIcon />
              </button>
            )}
            {showActions && onDelete && (
              <button
                type="button"
                className="icon-btn"
                aria-label="Delete"
                title="Delete this response"
                onClick={onDelete}
              >
                <TrashIcon />
              </button>
            )}
          </div>
        </div>
        <InterruptedBanner visible={state.interrupted} />
        {state.reasoning.map((block) => (
          <ReasoningBlock key={block.blockId} block={block} />
        ))}
        {webSearchCalls.length > 0 && (
          <SearchCallGroup
            toolCalls={webSearchCalls}
            unavailable={state.searchUnavailable}
            cost={state.searchCost}
          />
        )}
        {/* Show the thinking indicator across the whole streaming lifecycle whenever
            the assistant isn't actively emitting text — including the tool-execution
            gap and the post-tool "reviewing results" pause before the next text delta.
            Once real text starts streaming, ChatProse's blinking .cursor takes over.
            `producingText` = there is at least one content block that already has
            content; a freshly created empty block (provider sent contentBlockStart
            but no delta yet) does NOT count, so the dots stay during that gap too. */}
        {(() => {
          const producingText = state.blocks.some((b) => b.content.length > 0);
          const thinkingVisible = state.streaming && !producingText;
          return (
            <ThinkingIndicator
              modelId={modelId}
              phase={state.agentPhase}
              visible={thinkingVisible}
            />
          );
        })()}
        {/* Trailing blinking caret shown while streaming with no text yet, paired
            with the thinking dots above so the message bubble reads as alive even
            before the first content delta. Reuses the existing .cursor blink anim. */}
        {state.streaming && state.blocks.every((b) => b.content.length === 0) && (
          <span className="cursor thinking-trailing" aria-hidden="true" />
        )}
        {state.blocks.length > 0 ? (
          state.blocks.map((block) => (
            <ChatProse
              key={block.blockId}
              content={block.content}
              citations={block.citations}
              streaming={state.streaming}
              messageId={messageId}
              artifacts={artifacts}
              onPromoteArtifact={onPromoteArtifact}
              onOpenArtifact={onOpenArtifact}
            />
          ))
        ) : (
          <ChatProse
            content={text}
            streaming={state.streaming}
            messageId={messageId}
            artifacts={artifacts}
            onPromoteArtifact={onPromoteArtifact}
            onOpenArtifact={onOpenArtifact}
          />
        )}
        {grouped.map((entry, i) =>
          'group' in entry ? (
            <ToolCallBlock
              key={`grp-${entry.name}-${i}`}
              toolCall={entry.calls[0]}
              group={{ name: entry.name, calls: entry.calls }}
            />
          ) : (
            <ToolCallBlock key={entry.toolCallId} toolCall={entry} />
          ),
        )}
        {state.error && <p className="error-text">{state.error}</p>}
        <UsageSummary usage={state.usage} searchCost={state.searchCost} />
        {messageId && onOpenArtifact && (
          <AssistantArtifactStrip
            messageId={messageId}
            artifacts={artifacts ?? []}
            fileStateMap={fileStateMap}
            onOpenArtifact={onOpenArtifact}
          />
        )}
      </div>
    </div>
  );
}
