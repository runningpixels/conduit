import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ReasoningBlock } from './ReasoningBlock';
import { ChatProse } from './ChatProse';
import { TurnModelLine } from './TurnModelLine';
import { ThinkingIndicator } from './ThinkingIndicator';
import type {
  AssistantStreamState,
  ContentBlockState,
  ToolCallState,
  TurnSegment,
} from './streamState';
import type { Artifact, FileState } from '../ipc/contracts';
import { detectArtifactCandidates, type ArtifactCandidate } from './artifactCandidates';
import { inlineArtifactIds } from './inlineArtifact';
import { CheckIcon, CopyIcon, ForkIcon, PencilIcon, TrashIcon } from '../icons';
import { InterruptedBanner } from './InterruptedBanner';
import { ToolCallBlock } from './ToolCallBlock';
import { AskUserBlock } from './AskUserBlock';
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
  /// Active conversation for approval-memory remember scopes.
  conversationId?: string | null;
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

/**
 * Stale in-memory fixtures may lack `segments`. Synthesize the old bucket order
 * so they still render; new streams always append segments as events arrive.
 */
export function synthesizeSegments(state: AssistantStreamState): TurnSegment[] {
  if (state.segments.length > 0) return state.segments;

  const useHostedSearchUi = state.searchBackend !== 'local';
  const out: TurnSegment[] = [];
  for (const block of state.reasoning) {
    out.push({ kind: 'reasoning', blockId: block.blockId });
  }
  if (useHostedSearchUi) {
    for (const tc of state.toolCalls) {
      if (isWebSearchToolCall(tc)) out.push({ kind: 'tool', toolCallId: tc.toolCallId });
    }
  }
  for (const block of state.blocks) {
    out.push({ kind: 'text', blockId: block.blockId });
  }
  for (const tc of state.toolCalls) {
    if (useHostedSearchUi && isWebSearchToolCall(tc)) continue;
    out.push({ kind: 'tool', toolCallId: tc.toolCallId });
  }
  if (state.askUser) {
    out.push({ kind: 'askUser', toolCallId: state.askUser.toolCallId });
  }
  return out;
}

/** Resolve the nth text/reasoning segment with a reused blockId to the matching array entry. */
function resolveBlockByOrdinal(
  blocks: ContentBlockState[],
  blockId: string,
  occurrence: number,
): ContentBlockState | undefined {
  let seen = 0;
  for (const block of blocks) {
    if (block.blockId !== blockId) continue;
    if (seen === occurrence) return block;
    seen += 1;
  }
  return undefined;
}

type TimelineItem =
  | { kind: 'reasoning'; block: ContentBlockState; key: string }
  | { kind: 'text'; block: ContentBlockState; key: string; blockIndex: number }
  | { kind: 'tools'; calls: ToolCallState[]; key: string }
  | { kind: 'askUser'; toolCallId: string; key: string };

function buildTimelineItems(
  state: AssistantStreamState,
  segments: TurnSegment[],
): TimelineItem[] {
  const useHostedSearchUi = state.searchBackend !== 'local';
  const items: TimelineItem[] = [];
  const textOccurrence = new Map<string, number>();
  const reasoningOccurrence = new Map<string, number>();

  let i = 0;
  while (i < segments.length) {
    const seg = segments[i];
    if (seg.kind === 'reasoning') {
      const occ = reasoningOccurrence.get(seg.blockId) ?? 0;
      reasoningOccurrence.set(seg.blockId, occ + 1);
      const block = resolveBlockByOrdinal(state.reasoning, seg.blockId, occ);
      if (block) {
        items.push({ kind: 'reasoning', block, key: `reasoning-${seg.blockId}-${occ}` });
      }
      i += 1;
      continue;
    }
    if (seg.kind === 'text') {
      const occ = textOccurrence.get(seg.blockId) ?? 0;
      textOccurrence.set(seg.blockId, occ + 1);
      const block = resolveBlockByOrdinal(state.blocks, seg.blockId, occ);
      // Skip empty prose slots (e.g. a contentBlockStart that never received
      // tokens) so they cannot sit above a Thought chip or tool card in the DOM.
      if (block && block.content.length > 0) {
        const blockIndex = state.blocks.indexOf(block);
        items.push({
          kind: 'text',
          block,
          key: `text-${seg.blockId}-${occ}`,
          blockIndex,
        });
      }
      i += 1;
      continue;
    }
    if (seg.kind === 'askUser') {
      items.push({ kind: 'askUser', toolCallId: seg.toolCallId, key: `ask-${seg.toolCallId}` });
      i += 1;
      continue;
    }

    // Coalesce consecutive tool segments the same way groupToolCalls would.
    const run: ToolCallState[] = [];
    let runName = '';
    let runIsHostedSearch = false;
    while (i < segments.length && segments[i].kind === 'tool') {
      const toolSeg = segments[i] as Extract<TurnSegment, { kind: 'tool' }>;
      const tc = state.toolCalls.find((c) => c.toolCallId === toolSeg.toolCallId);
      if (!tc) {
        i += 1;
        continue;
      }
      const hostedSearch = useHostedSearchUi && isWebSearchToolCall(tc);
      if (run.length === 0) {
        run.push(tc);
        runName = tc.name;
        runIsHostedSearch = hostedSearch;
        i += 1;
        continue;
      }
      // Hosted search groups with other hosted search; ordinary tools group by name.
      if (runIsHostedSearch && hostedSearch) {
        run.push(tc);
        i += 1;
        continue;
      }
      if (!runIsHostedSearch && !hostedSearch && tc.name === runName) {
        run.push(tc);
        i += 1;
        continue;
      }
      break;
    }
    if (run.length > 0) {
      items.push({
        kind: 'tools',
        calls: run,
        key: `tools-${run.map((c) => c.toolCallId).join('-')}`,
      });
    }
  }
  return items;
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
  conversationId = null,
}: AssistantMessageProps) {
  const [copied, setCopied] = useState(false);
  const text = state.blocks
    .filter((b) => b.blockKind !== 'thinking' && b.blockKind !== 'reasoning')
    .map((b) => b.content)
    .join('');
  const useHostedSearchUi = state.searchBackend !== 'local';
  const segments = useMemo(() => synthesizeSegments(state), [state]);
  const timeline = useMemo(() => buildTimelineItems(state, segments), [state, segments]);
  const elapsed = useLiveElapsed(state.streaming);
  const tokenCount = Math.round(text.length / 4);

  const producingText = state.blocks.some(
    (b) =>
      b.content.length > 0 && b.blockKind !== 'thinking' && b.blockKind !== 'reasoning',
  );

  // Caret on the last text item only when nothing follows it on the timeline
  // (no later tools / ask_user / more text). Otherwise the live tail carries it.
  const lastTextItemIndex = (() => {
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      if (timeline[i].kind === 'text') return i;
    }
    return -1;
  })();
  const proseCaretVisible =
    state.streaming &&
    producingText &&
    lastTextItemIndex >= 0 &&
    lastTextItemIndex === timeline.length - 1;

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

  const body: ReactNode[] = [];
  if (timeline.length === 0 && !producingText) {
    body.push(
      <ChatProse
        key="empty-prose"
        content={text}
        streaming={false}
        messageId={messageId}
        artifacts={artifacts}
        fileStateMap={fileStateMap}
        onPromoteArtifact={onPromoteArtifact}
        onOpenArtifact={onOpenArtifact}
        onStatus={onStatus}
      />,
    );
  }
  for (let ti = 0; ti < timeline.length; ti += 1) {
    const item = timeline[ti];
    if (item.kind === 'reasoning') {
      body.push(<ReasoningBlock key={item.key} block={item.block} />);
      continue;
    }
    if (item.kind === 'text') {
      body.push(
        <ChatProse
          key={item.key}
          content={item.block.content}
          citations={item.block.citations}
          streaming={proseCaretVisible && ti === lastTextItemIndex}
          messageId={messageId}
          artifacts={artifacts}
          fileStateMap={fileStateMap}
          onPromoteArtifact={onPromoteArtifact}
          onOpenArtifact={onOpenArtifact}
          onStatus={onStatus}
        />,
      );
      continue;
    }
    if (item.kind === 'askUser') {
      if (state.askUser && state.askUser.toolCallId === item.toolCallId) {
        body.push(
          <AskUserBlock
            key={item.key}
            toolCallId={state.askUser.toolCallId}
            title={state.askUser.title}
            fields={state.askUser.fields}
          />,
        );
      }
      continue;
    }
    // tools
    const hostedSearch = useHostedSearchUi && item.calls.every(isWebSearchToolCall);
    if (hostedSearch) {
      body.push(
        <SearchCallGroup
          key={item.key}
          toolCalls={item.calls}
          unavailable={state.searchUnavailable}
          cost={state.searchCost}
        />,
      );
    } else if (item.calls.length > 1) {
      body.push(
        <ToolCallBlock
          key={item.key}
          toolCall={item.calls[0]}
          group={{ name: item.calls[0].name, calls: item.calls }}
          conversationId={conversationId}
        />,
      );
    } else {
      body.push(
        <ToolCallBlock
          key={item.key}
          toolCall={item.calls[0]}
          conversationId={conversationId}
        />,
      );
    }
  }

  // If ask_user is pending but missing from the timeline (stale edge case), show it last.
  if (
    state.askUser &&
    !timeline.some((item) => item.kind === 'askUser' && item.toolCallId === state.askUser?.toolCallId)
  ) {
    body.push(
      <AskUserBlock
        key={`ask-fallback-${state.askUser.toolCallId}`}
        toolCallId={state.askUser.toolCallId}
        title={state.askUser.title}
        fields={state.askUser.fields}
      />,
    );
  }

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
      {body}
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

      {(onCopy || showActions || onFork || state.usage) && (
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
        <UsageSummary usage={state.usage} searchCost={state.searchCost} />
      </div>
      )}
    </article>
  );
}
