import { useEffect, useMemo, useRef, useState } from 'react';
import { ReasoningBlock } from './ReasoningBlock';
import { ChatProse } from './ChatProse';
import { TurnModelLine } from './TurnModelLine';
import { ThinkingIndicator } from './ThinkingIndicator';
import type { AssistantStreamState, ToolCallState } from './streamState';
import type { Artifact, FileState } from '../ipc/contracts';
import { detectArtifactCandidates, type ArtifactCandidate } from './artifactCandidates';
import { inlineArtifactIds } from './inlineArtifact';
import { CheckIcon, CopyIcon, ForkIcon, PencilIcon, TrashIcon } from '../icons';
import { InterruptedBanner } from './InterruptedBanner';
import { ToolCallBlock } from './ToolCallBlock';
import { SearchCallGroup } from './SearchCallGroup';
import { isWebSearchToolCall } from './SearchCallBlock';
import { UsageSummary } from './UsageSummary';
import { AssistantArtifactStrip } from './ArtifactResultCard';
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
  /// Conversation artifacts, for the in-chat result cards.
  artifacts?: Artifact[];
  /// Per-artifact file-state, for the card state dots.
  fileStateMap?: Record<string, FileState>;
  /// Promote a detected fenced-block candidate to an artifact (App handles the
  /// create + setContent + open flow).
  onPromoteArtifact?: (messageId: string, candidate: ArtifactCandidate) => void;
  /// Open an existing artifact in the DocumentPanel (result-card primary action).
  onOpenArtifact?: (artifactId: string) => void;
  /// Surface artifact-card IPC results (export destination, failures) on the
  /// app status line.
  onStatus?: (message: string) => void;
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
  onStatus,
  onRetry,
  onDelete,
  onCopy,
  onFork,
  isLast = true,
}: AssistantMessageProps) {
  const [copied, setCopied] = useState(false);
  const text = state.blocks.map((b) => b.content).join('');
  // SearchCallGroup is for provider-hosted search only. Local DuckDuckGo
  // web_search renders as an ordinary ToolCallBlock with JSON results.
  const useHostedSearchUi = state.searchBackend !== 'local';
  const webSearchCalls = useHostedSearchUi
    ? state.toolCalls.filter(isWebSearchToolCall)
    : [];
  const otherToolCalls = useHostedSearchUi
    ? state.toolCalls.filter((tc) => !isWebSearchToolCall(tc))
    : state.toolCalls;
  const grouped = groupToolCalls(otherToolCalls);
  const elapsed = useLiveElapsed(state.streaming);
  const tokenCount = Math.round(text.length / 4);

  // The caret belongs to whatever is last in the turn. It rides the end of the
  // prose in the common no-tool case, and moves down to the live tail as soon
  // as tool cards render below the text — otherwise the cursor would sit above
  // content that is still arriving. Only the *last* block ever gets it; passing
  // `streaming` to every block drew one caret per block.
  const producingText = state.blocks.some((b) => b.content.length > 0);
  const proseCaretVisible = state.streaming && producingText && grouped.length === 0;

  // Artifacts already shown as a card inside the message body. Without this the
  // same artifact appears twice in one turn — once where it was produced and
  // again in the end-of-turn strip.
  const inlineCardIds = useMemo(
    () => inlineArtifactIds(detectArtifactCandidates(text), artifacts ?? [], messageId),
    [text, artifacts, messageId],
  );

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

      {/* Live generation meta: transient, streaming-only. The "Round n/m" badge
          that used to sit here reported the agent-loop step against `max_steps`
          — a ceiling that is essentially never approached, so it read as
          alarming progress toward a limit that was not real. `ThinkingIndicator`
          still surfaces the phase in words ("Running 2 tools…"). */}
      {state.streaming && elapsed > 0 && (
        <div className="turn-meta">
          <span className="msg-meta">
            <span className="live-dot" aria-hidden="true" />
            {elapsed}s · {tokenCount} tok
          </span>
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
      {state.blocks.length > 0 ? (
        state.blocks.map((block, i) => (
          <ChatProse
            key={block.blockId}
            content={block.content}
            citations={block.citations}
            streaming={proseCaretVisible && i === state.blocks.length - 1}
            messageId={messageId}
            artifacts={artifacts}
            fileStateMap={fileStateMap}
            onPromoteArtifact={onPromoteArtifact}
            onOpenArtifact={onOpenArtifact}
            onStatus={onStatus}
          />
        ))
      ) : (
        <ChatProse
          content={text}
          streaming={proseCaretVisible}
          messageId={messageId}
          artifacts={artifacts}
          fileStateMap={fileStateMap}
          onPromoteArtifact={onPromoteArtifact}
          onOpenArtifact={onOpenArtifact}
          onStatus={onStatus}
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
      {/* Live tail — the single "still working" affordance, always the last node
          of the turn. It used to sit above the prose and the tool cards, so new
          cards kept appearing *below* the cursor while the turn ran and the
          frontier of generation read as somewhere in the middle. The dots +
          phase label ("Continuing…") show whenever the assistant isn't emitting
          text; the caret shows for the whole streaming lifecycle unless the
          prose is carrying it (see `proseCaretVisible`). `state.error` implies
          `streaming: false`, so the two never render together. */}
      {state.streaming && (
        <div className="turn-live-tail">
          <ThinkingIndicator
            modelId={modelId}
            phase={state.agentPhase}
            visible={!producingText}
          />
          {!proseCaretVisible && <span className="streaming thinking-trailing" aria-hidden="true" />}
        </div>
      )}
      {state.error && <p className="error-text">{state.error}</p>}
      <UsageSummary usage={state.usage} searchCost={state.searchCost} />
      {messageId && onOpenArtifact && (
        <AssistantArtifactStrip
          messageId={messageId}
          artifacts={artifacts ?? []}
          fileStateMap={fileStateMap}
          excludeArtifactIds={inlineCardIds}
          onOpenArtifact={onOpenArtifact}
          onStatus={onStatus}
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
