import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ReasoningBlock } from './ReasoningBlock';
import { ChatProse } from './ChatProse';
import { TurnModelLine } from './TurnModelLine';
import { ThinkingIndicator } from './ThinkingIndicator';
import { streamStalled } from './documentWriteScan';
import type {
  AssistantStreamState,
  ContentBlockState,
  ToolCallState,
  TurnSegment,
} from './streamState';
import type { Artifact, FileState } from '../ipc/contracts';
import { detectArtifactCandidates, type ArtifactCandidate } from './artifactCandidates';
import { inlineArtifactIds } from './inlineArtifact';
import { CheckIcon, ChevronRight, CopyIcon, ForkIcon, RetryIcon, TrashIcon } from '../icons';
import { InterruptedBanner } from './InterruptedBanner';
import { ToolCallBlock } from './ToolCallBlock';
import { AskUserBlock } from './AskUserBlock';
import { SearchCallGroup } from './SearchCallGroup';
import { isWebSearchToolCall } from './SearchCallBlock';
import { UsageSummary } from './UsageSummary';
import { AssistantArtifactStrip } from './ArtifactResultCard';
import { providerHueId } from '../lib/providerIdentity';
import { useT } from '../i18n';
import {
  deriveActivitySteps,
  summarizeStreamState,
  type ActivityStepStatus,
  type TurnSummary,
} from '../inspector/turnActivity';
import { StepStatusIcon, formatStepDuration, stepDetail, stepStatusLabel } from '../inspector/stepPresentation';
import { useFormatters } from '../i18n/formatters';
import { deckChangeSummary, liveSummary, thoughtSummary } from './compactTurnSummary';

/** Steps shown as rows in the reply before the rest fold into the summary line. */
const INLINE_STEP_ROWS = 3;

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
  /** Continue a document build that stopped at the turn time limit. */
  onContinueBuilding?: () => void;
  /** Send the last prompt again without the Max tokens limit that cut this
   *  turn short. Only passed when such a limit is set. */
  onRetryWithoutLimit?: () => void;
  /** The Max tokens limit in effect for this turn, shown next to the live
   *  token count so a limit being used up is visible before it cuts in. */
  outputLimit?: number;
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
  /// Live turn only: this model delivers documents all at once and this turn
  /// offers document tools, so a long silence is explained up front.
  documentWriteHeld?: boolean;
  /** Id the compact step line reports to `onOpenActivity`. Pass the chat
   *  turn's id (`turn.id`); defaults to `messageId`, then the request id. */
  turnId?: string;
  /** Open the inspector's Activity tab for this turn. Without it the compact
   *  step line expands the tool cards in place instead. */
  onOpenActivity?: (turnId: string) => void;
  /** Slides studio dock: show the text reply, then one summary line for the
   *  thinking and tool calls, collapsed until clicked. */
  compact?: boolean;
  /** Compact only: the open deck's slide ids in order, so the summary can say
   *  "slides 2, 4" rather than ids. */
  deckSlideIds?: readonly string[];
}

const NO_SLIDE_IDS: readonly string[] = [];

/** Tool calls that need the reader (an approval gate) or show live progress
 *  the reader watches (a document still being written) stay inline; every
 *  other call folds into the turn's compact step line. */
export function toolCallStaysInline(tc: ToolCallState, streaming: boolean): boolean {
  if (tc.sideEffecting && tc.consent === 'pending') return true;
  return (
    streaming &&
    tc.documentWrite !== undefined &&
    tc.arguments === undefined &&
    !tc.complete &&
    !tc.status
  );
}

function stepLineStatus(summary: TurnSummary): ActivityStepStatus {
  if (summary.needsYou) return 'waiting';
  if (summary.running) return 'running';
  if (summary.failed > 0) return 'failed';
  return 'done';
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
  onContinueBuilding,
  onRetryWithoutLimit,
  outputLimit,
  onDelete,
  onCopy,
  onFork,
  isLast = true,
  conversationId = null,
  documentWriteHeld = false,
  turnId,
  onOpenActivity,
  compact = false,
  deckSlideIds = NO_SLIDE_IDS,
}: AssistantMessageProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const activity = useMemo(() => summarizeStreamState(state), [state]);
  // The first few steps show as rows in the reply (ADR-011); the rest are
  // behind the summary line, which opens the full activity. Errors are
  // excluded, as in the summary: they already show inline.
  const shownSteps = useMemo(
    () => deriveActivitySteps(state).filter((step) => step.kind !== 'error').slice(0, INLINE_STEP_ROWS),
    [state],
  );
  const fmt = useFormatters();
  const text = state.blocks
    .filter((b) => b.blockKind !== 'thinking' && b.blockKind !== 'reasoning')
    .map((b) => b.content)
    .join('');
  const useHostedSearchUi = state.searchBackend !== 'local';
  const segments = useMemo(() => synthesizeSegments(state), [state]);
  const timeline = useMemo(() => buildTimelineItems(state, segments), [state, segments]);
  const elapsed = useLiveElapsed(state.streaming);
  // Reasoning and tool arguments are model output too. Counting only prose
  // held this at "0 tok" through visibly streaming reasoning, and froze it for
  // the whole time a document was written into a tool call.
  const argumentChars = state.toolCalls.reduce((n, tc) => n + tc.argumentsText.length, 0);
  const reasoningChars = state.reasoning.reduce((n, b) => n + b.content.length, 0);
  const tokenCount = Math.round((text.length + argumentChars + reasoningChars) / 4);
  // `elapsed` ticks every second while streaming, so this re-evaluates on its own.
  const stalled = state.streaming && streamStalled(state.lastEventAt, Date.now());
  const awaitingApproval = state.toolCalls.some((tc) => tc.sideEffecting && tc.consent === 'pending');
  const waitingOnReader = Boolean(state.askUser) || awaitingApproval;

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

  function renderToolItem(calls: ToolCallState[], key: string): ReactNode {
    const hostedSearch = useHostedSearchUi && calls.every(isWebSearchToolCall);
    if (hostedSearch) {
      return (
        <SearchCallGroup
          key={key}
          toolCalls={calls}
          unavailable={state.searchUnavailable}
          cost={state.searchCost}
        />
      );
    }
    if (calls.length > 1) {
      return (
        <ToolCallBlock
          key={key}
          toolCall={calls[0]}
          group={{ name: calls[0].name, calls }}
          conversationId={conversationId}
        />
      );
    }
    return <ToolCallBlock key={key} toolCall={calls[0]} conversationId={conversationId} />;
  }

  const lineStatus = stepLineStatus(activity);
  const stepLineText = [
    t('chat.activity.steps', { count: activity.steps }),
    activity.sites > 0 ? t('chat.activity.sites', { count: activity.sites }) : '',
    activity.failed > 0 ? t('chat.activity.failed', { count: activity.failed }) : '',
    activity.needsYou ? t('chat.activity.needsYou') : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const activityTurnId = turnId ?? messageId ?? state.requestId;
  const openSteps = () => {
    if (onOpenActivity) onOpenActivity(activityTurnId);
    else setStepsOpen((v) => !v);
  };
  const summaryLine = (
    <button
      key="turn-steps"
      type="button"
      className="turn-steps"
      data-status={lineStatus}
      data-open={!onOpenActivity && stepsOpen ? 'true' : 'false'}
      title={onOpenActivity ? t('chat.activity.open') : undefined}
      {...(onOpenActivity ? {} : { 'aria-expanded': stepsOpen })}
      onClick={openSteps}
    >
      <StepStatusIcon status={lineStatus} />
      <span className="turn-steps-label" title={stepLineText}>
        {stepLineText}
      </span>
      <ChevronRight className="turn-steps-chev" />
    </button>
  );
  const stepLine = (
    <div key="turn-steps-block" className="turn-step-block">
      <ol className="turn-step-rows">
        {shownSteps.map((step) => {
          const detail = stepDetail(step, t, fmt);
          return (
            <li key={step.id}>
              <button
                type="button"
                className="turn-step-row"
                data-status={step.status}
                title={onOpenActivity ? t('chat.activity.open') : undefined}
                {...(onOpenActivity ? {} : { 'aria-expanded': stepsOpen })}
                onClick={openSteps}
              >
                <StepStatusIcon status={step.status} />
                <span className="sr-only">{stepStatusLabel(step.status, t)}</span>
                <span className="turn-step-name" title={step.name || undefined}>
                  {step.name || t('inspector.activity.errorName')}
                </span>
                {detail && (
                  <span className="turn-step-detail" title={detail}>
                    {detail}
                  </span>
                )}
                <span className="turn-step-dur">
                  {step.status === 'running' ? '…' : formatStepDuration(step.durationMs)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {/* The summary line is how to reach the rest, and it carries "needs
          you", which must not vanish on a short turn. */}
      {(activity.steps > shownSteps.length || activity.needsYou) && summaryLine}
    </div>
  );
  let stepLineShown = false;

  const body: ReactNode[] = [];
  // Compact turns: everything but the reply text waits behind one line.
  const details: ReactNode[] = [];
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
      // Live only while it is the newest thing in the turn: once text or a
      // tool call follows, the model has stopped thinking in this block.
      const live = state.streaming && ti === timeline.length - 1;
      (compact ? details : body).push(<ReasoningBlock key={item.key} block={item.block} live={live} />);
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
    if (compact) {
      for (const call of item.calls.filter((c) => toolCallStaysInline(c, state.streaming))) {
        body.push(<ToolCallBlock key={`${item.key}-${call.toolCallId}`} toolCall={call} conversationId={conversationId} />);
      }
      const folded = item.calls.filter((c) => !toolCallStaysInline(c, state.streaming));
      if (folded.length > 0) details.push(renderToolItem(folded, item.key));
      continue;
    }
    // tools — one compact step line per turn, at the first tool position.
    if (!stepLineShown && activity.steps > 0) {
      body.push(stepLine);
      stepLineShown = true;
    }
    const inline = item.calls.filter((c) => toolCallStaysInline(c, state.streaming));
    const folded = item.calls.filter((c) => !toolCallStaysInline(c, state.streaming));
    for (const call of inline) {
      body.push(<ToolCallBlock key={`${item.key}-${call.toolCallId}`} toolCall={call} conversationId={conversationId} />);
    }
    if (folded.length > 0 && stepsOpen && !onOpenActivity) {
      body.push(renderToolItem(folded, item.key));
    }
  }
  if (!compact && !stepLineShown && activity.steps > 0) {
    body.push(stepLine);
  }
  if (compact && (activity.steps > 0 || state.reasoning.length > 0)) {
    let label: string;
    if (state.streaming) {
      label = liveSummary(state, deckSlideIds, t);
    } else if (activity.steps > 0) {
      const deckPart = deckChangeSummary(state, deckSlideIds, t);
      const detailed = activity.steps > 1 || activity.failed > 0 || activity.needsYou;
      label = deckPart === '' ? stepLineText : detailed ? `${deckPart} · ${stepLineText}` : deckPart;
    } else {
      label = thoughtSummary(state, t, fmt.duration);
    }
    body.push(
      <div key="turn-compact" className="turn-step-block turn-compact">
        <button
          type="button"
          className="turn-steps turn-steps-compact"
          data-status={lineStatus}
          data-open={compactOpen ? 'true' : 'false'}
          aria-expanded={compactOpen}
          onClick={() => setCompactOpen((v) => !v)}
        >
          <StepStatusIcon status={lineStatus} />
          <span className="turn-steps-label" title={label}>
            {label}
          </span>
          <ChevronRight className="turn-steps-chev" />
        </button>
        {compactOpen && <div className="turn-compact-details">{details}</div>}
      </div>,
    );
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
      data-role-label={t('chat.turn.roleLabel.assistant')}
      {...(messageId ? { 'data-message-id': messageId } : {})}
    >
      {/* P5.2 — visually-hidden live region announcing stream completion */}
      <span className="sr-only" role="status" aria-live="polite">
        {state.streaming
          ? t('chat.assistant.status.inProgress')
          : state.error
            ? t('chat.assistant.status.error')
            : state.interrupted
              ? t('chat.assistant.status.stopped')
              : text.trim()
                ? t('chat.assistant.status.complete')
                : ''}
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
            {outputLimit
              ? t('chat.assistant.liveMetaLimit', { elapsed, tokenCount, limit: outputLimit })
              : t('chat.assistant.liveMeta', { elapsed, tokenCount })}
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
            // A question waiting on the reader is not work in progress. Live it
            // read "Running 1 tool… still working · 301s — some models send long
            // responses all at once" under the form, for as long as nobody
            // answered.
            // The same goes for a tool waiting on its approval card.
            message={
              state.askUser
                ? t('chat.askUser.waiting')
                : awaitingApproval
                  ? t('chat.toolCall.consent.waiting')
                  : undefined
            }
            phase={waitingOnReader ? undefined : state.agentPhase}
            lastActivityAt={waitingOnReader ? undefined : state.lastEventAt}
            heldDocument={documentWriteHeld}
            // Prose earlier in the turn must not hide the one signal that work
            // is still happening: while a document is written into a tool
            // call, or while the provider has gone quiet.
            visible={
              !producingText || state.agentPhase?.subPhase === 'writing_document' || stalled
            }
          />
          {!proseCaretVisible && <span className="streaming thinking-trailing" aria-hidden="true" />}
        </div>
      )}
      {state.error && <p className="error-text">{state.error}</p>}
      {/* The document is saved as far as it got; one click picks the build up
          where it stopped instead of asking the user to phrase a follow-up. */}
      {state.error &&
        state.errorCode === 'turn_time_limit_building' &&
        isLast &&
        !state.streaming &&
        onContinueBuilding && (
          <button type="button" className="act turn-continue-building" onClick={onContinueBuilding}>
            {t('chat.documentBuild.continue')}
          </button>
        )}
      {state.error &&
        state.errorCode?.startsWith('output_limit') &&
        isLast &&
        !state.streaming &&
        onRetryWithoutLimit && (
          <button type="button" className="act turn-continue-building" onClick={onRetryWithoutLimit}>
            {t('chat.assistant.retryWithoutLimit')}
          </button>
        )}
      {/* The provider stopped this reply at its output-token limit. The text
          above is all there is; without this it reads as a finished answer. */}
      {!state.streaming && !state.error && state.finishReason === 'length' && (
        <p className="turn-cutoff-note" role="status">
          {t('chat.assistant.cutOff')}
        </p>
      )}
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
            aria-label={copied ? t('chat.assistant.actions.copiedLabel') : t('chat.assistant.actions.copyLabel')}
            title={copied ? t('chat.assistant.actions.copiedLabel') : t('chat.assistant.actions.copyLabel')}
            onClick={onCopy}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {t('common.actions.copy')}
          </button>
        ) : (
          <button
            type="button"
            className="act"
            aria-label={copied ? t('chat.assistant.actions.copiedLabel') : t('chat.assistant.actions.copyLabel')}
            title={copied ? t('chat.assistant.actions.copiedLabel') : t('chat.assistant.actions.copyLabel')}
            onClick={() => void handleCopy()}
            disabled={!text}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
            {t('common.actions.copy')}
          </button>
        )}
        {showActions && onRetry && (
          <button
            type="button"
            className="act"
            aria-label={t('common.actions.retry')}
            title={t('chat.assistant.actions.retryTitle')}
            onClick={onRetry}
          >
            <RetryIcon />
            {t('common.actions.retry')}
          </button>
        )}
        {onFork && (
          <button
            type="button"
            className="act"
            aria-label={t('chat.assistant.actions.forkLabel')}
            title={t('chat.assistant.actions.forkLabel')}
            onClick={onFork}
          >
            <ForkIcon />
            {t('common.actions.fork')}
          </button>
        )}
        {showActions && onDelete && (
          <button
            type="button"
            className="act"
            aria-label={t('common.actions.delete')}
            title={t('chat.assistant.actions.deleteTitle')}
            onClick={onDelete}
          >
            <TrashIcon />
            {t('common.actions.delete')}
          </button>
        )}
        <UsageSummary usage={state.usage} searchCost={state.searchCost} />
      </div>
      )}
    </article>
  );
}
