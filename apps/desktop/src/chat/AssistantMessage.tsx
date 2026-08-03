import { useEffect, useRef, useState } from 'react';
import { ReasoningBlock } from './ReasoningBlock';
import { ChatProse } from './ChatProse';
import { TurnModelLine } from './TurnModelLine';
import { ThinkingIndicator } from './ThinkingIndicator';
import type { AssistantStreamState, ToolCallState } from './streamState';
import type { Artifact, FileState } from '../ipc/contracts';
import type { ArtifactCandidate } from './artifactCandidates';
import { CheckIcon, CopyIcon, ForkIcon, PencilIcon, TrashIcon } from '../icons';
import { InterruptedBanner } from './InterruptedBanner';
import { ToolCallBlock } from './ToolCallBlock';
import { SearchCallGroup } from './SearchCallGroup';
import { isWebSearchToolCall } from './SearchCallBlock';
import { UsageSummary } from './UsageSummary';
import { AssistantArtifactStrip } from './ArtifactRefChip';
import { providerHueId } from '../lib/providerIdentity';

interface AssistantMessageProps {
  state: AssistantStreamState;
  /** Provider adapter id that produced this turn (drives data-provider hue). */
  provider: string;
  /** Model id that produced this turn. */
  modelId?: string;
  /** Turn timestamp, passed to the conditional model line. */
  time?: string;
  /** Previous provider id when the provider differs from the preceding turn. */
  switchedFrom?: string;
  /** Whether the conditional model line (§6.4) should render for this turn. */
  showModelLine?: boolean;
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
  /// Copy this turn's text (wired from ChatView's clipboard handler).
  onCopy?: () => void;
  /// Fork the conversation at this message.
  onFork?: () => void;
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

/** V7 assistant turn (§8.3): full width, flat, identified only by a 2px
 *  provider rule on the left (the hue). No avatar, no role name. The model
 *  line renders only when the provider/model differs from the preceding
 *  assistant turn (§6.4). Actions appear on hover/focus. */
export function AssistantMessage({
  state,
  provider,
  modelId,
  time,
  switchedFrom,
  showModelLine = true,
  messageId,
  artifacts,
  fileStateMap,
  onPromoteArtifact,
  onOpenArtifact,
  onRetry,
  onDelete,
  onCopy,
  onFork,
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
    <article
      className={`turn assistant${state.streaming ? ' active' : ''}`}
      data-provider={providerHueId(provider)}
      {...(messageId ? { 'data-message-id': messageId } : {})}
    >
      {/* P5.2 — visually-hidden live region announcing stream completion */}
      <span className="sr-only" role="status" aria-live="polite">
        {state.streaming ? 'Response in progress.' : state.error ? 'Response finished with an error.' : state.interrupted ? 'Response stopped.' : text.trim() ? 'Response complete.' : ''}
      </span>

      {showModelLine && (
        <TurnModelLine provider={provider} model={modelId ?? ''} time={time} switchedFrom={switchedFrom} />
      )}

      {/* Live generation meta + agent phase: transient mono facts, shown only
          while streaming or in the agent loop. */}
      {(state.agentPhase || (state.streaming && elapsed > 0)) && (
        <div className="turn-meta">
          {state.agentPhase && (
            <span className="phase-badge" title={state.agentPhase.subPhase}>
              Round {state.agentPhase.round}
              {state.agentPhase.totalRounds ? `/${state.agentPhase.totalRounds}` : ''}
            </span>
          )}
          {state.streaming && (
            <span className="msg-meta">
              <span className="live-dot" aria-hidden="true" />
              {elapsed}s · {tokenCount} tok
            </span>
          )}
        </div>
      )}

      <InterruptedBanner visible={state.interrupted} onRetry={showActions ? onRetry : undefined} />
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
          Once real text starts streaming, the .streaming caret takes over. */}
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
      {/* Trailing caret shown while streaming with no text yet, paired with the
          thinking dots above so the turn reads as alive before the first delta. */}
      {state.streaming && state.blocks.every((b) => b.content.length === 0) && (
        <span className="streaming thinking-trailing" aria-hidden="true" />
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

      {(onCopy || showActions || onFork) && (
      <div className="turn-actions">
        {onCopy ? (
          <button
            type="button"
            className="act"
            aria-label={copied ? 'Copied' : 'Copy message'}
            title={copied ? 'Copied' : 'Copy message'}
            onClick={onCopy}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            Copy
          </button>
        ) : (
          <button
            type="button"
            className="act"
            aria-label={copied ? 'Copied' : 'Copy message'}
            title={copied ? 'Copied' : 'Copy message'}
            onClick={() => void handleCopy()}
            disabled={!text}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            Copy
          </button>
        )}
        {showActions && onRetry && (
          <button
            type="button"
            className="act"
            aria-label="Retry"
            title="Retry this response"
            onClick={onRetry}
          >
            <PencilIcon />
            Retry
          </button>
        )}
        {onFork && (
          <button
            type="button"
            className="act"
            aria-label="Fork conversation at this message"
            title="Fork conversation at this message"
            onClick={onFork}
          >
            <ForkIcon />
            Fork
          </button>
        )}
        {showActions && onDelete && (
          <button
            type="button"
            className="act"
            aria-label="Delete"
            title="Delete this response"
            onClick={onDelete}
          >
            <TrashIcon />
            Delete
          </button>
        )}
      </div>
      )}
    </article>
  );
}
