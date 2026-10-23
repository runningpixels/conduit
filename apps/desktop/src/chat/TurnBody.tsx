/// The body of an assistant turn: its text, thinking, questions and tool calls
/// in the order they happened, with the calls folded into one step line. The
/// main thread's replies and the agent view's transcripts both render through
/// it; a hand-off is one line that opens that helper's own view.

import { useMemo, useState, type ReactNode } from 'react';
import { ReasoningBlock } from './ReasoningBlock';
import { ChatProse } from './ChatProse';
import type { AssistantStreamState, ContentBlockState, ToolCallState, TurnSegment } from './streamState';
import type { Artifact, FileState } from '../ipc/contracts';
import type { ArtifactCandidate } from './artifactCandidates';
import { ChevronRight } from '../icons';
import { ToolCallBlock } from './ToolCallBlock';
import { HandoffLine, HandoffWaitingLabel } from './HandoffLine';
import { AskUserBlock } from './AskUserBlock';
import { SearchCallGroup } from './SearchCallGroup';
import { isWebSearchToolCall } from './SearchCallBlock';
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
import { runningHandoffs } from './agentViewModel';

/** Steps shown as rows in the reply before the rest fold into the summary line. */
const INLINE_STEP_ROWS = 3;

const NO_SLIDE_IDS: readonly string[] = [];

/** Tool calls that need the reader (an approval gate) or show live progress
 *  the reader watches (a document still being written) stay inline; every
 *  other call folds into the turn's compact step line. */
export function toolCallStaysInline(tc: ToolCallState, streaming: boolean): boolean {
  if (tc.handoff) return true;
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

function lastTextIndex(timeline: TimelineItem[]): number {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    if (timeline[i].kind === 'text') return i;
  }
  return -1;
}

/** Whether streaming prose carries the caret: text is the newest thing in the turn. */
function caretInProse(state: AssistantStreamState, timeline: TimelineItem[]): boolean {
  const producingText = state.blocks.some(
    (b) => b.content.length > 0 && b.blockKind !== 'thinking' && b.blockKind !== 'reasoning',
  );
  const last = lastTextIndex(timeline);
  return state.streaming && producingText && last >= 0 && last === timeline.length - 1;
}

/** `caretInProse` for a whole turn: the live tail draws the caret when the prose doesn't. */
export function proseCarriesCaret(state: AssistantStreamState): boolean {
  return caretInProse(state, buildTimelineItems(state, synthesizeSegments(state)));
}

export interface TurnBodyProps {
  state: AssistantStreamState;
  /// Real persisted message id (for artifact linkage); absent while streaming.
  messageId?: string;
  artifacts?: Artifact[];
  fileStateMap?: Record<string, FileState>;
  onPromoteArtifact?: (messageId: string, candidate: ArtifactCandidate) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onStatus?: (message: string) => void;
  /// Active conversation for approval-memory remember scopes.
  conversationId?: string | null;
  /** Id the step line reports to `onOpenActivity`; defaults to `messageId`, then the request id. */
  turnId?: string;
  /** Open the inspector's Activity tab for this turn. Without it the step
   *  line expands the tool cards in place instead. */
  onOpenActivity?: (turnId: string) => void;
  /** Slides studio dock: the text reply, then one summary line for the rest. */
  compact?: boolean;
  deckSlideIds?: readonly string[];
  /** Open a hand-off's own view, by the lead's tool call id. */
  onOpenHandoff?: (toolCallId: string) => void;
}

export function TurnBody({
  state,
  messageId,
  artifacts,
  fileStateMap,
  onPromoteArtifact,
  onOpenArtifact,
  onStatus,
  conversationId = null,
  turnId,
  onOpenActivity,
  compact = false,
  deckSlideIds = NO_SLIDE_IDS,
  onOpenHandoff,
}: TurnBodyProps) {
  const t = useT();
  const fmt = useFormatters();
  const [stepsOpen, setStepsOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  // Hand-offs have their own lines, so the step line leaves them out: its
  // rows and its count are the turn's other steps.
  const ownSteps = useMemo(() => {
    const handedOff = new Set(state.toolCalls.filter((tc) => tc.handoff).map((tc) => tc.toolCallId));
    return deriveActivitySteps(state).filter((step) => step.kind !== 'error' && !handedOff.has(step.id));
  }, [state]);
  const activity = useMemo(() => {
    const summary = summarizeStreamState(state);
    return {
      ...summary,
      steps: ownSteps.length,
      failed: ownSteps.filter((step) => step.status === 'failed').length,
      needsYou: ownSteps.some((step) => step.status === 'waiting'),
    };
  }, [state, ownSteps]);
  // The first few steps show as rows in the reply (ADR-011); the rest are
  // behind the summary line, which opens the full activity. Errors are
  // excluded, as in the summary: they already show inline.
  const shownSteps = useMemo(() => ownSteps.slice(0, INLINE_STEP_ROWS), [ownSteps]);
  const text = state.blocks
    .filter((b) => b.blockKind !== 'thinking' && b.blockKind !== 'reasoning')
    .map((b) => b.content)
    .join('');
  const useHostedSearchUi = state.searchBackend !== 'local';
  const segments = useMemo(() => synthesizeSegments(state), [state]);
  const timeline = useMemo(() => buildTimelineItems(state, segments), [state, segments]);
  // Helpers working side by side: one label above their lines.
  const helpersRunning = runningHandoffs(state);
  let waitingShown = false;

  const producingText = state.blocks.some(
    (b) =>
      b.content.length > 0 && b.blockKind !== 'thinking' && b.blockKind !== 'reasoning',
  );

  // Caret on the last text item only when nothing follows it on the timeline
  // (no later tools / ask_user / more text). Otherwise the live tail carries it.
  const lastTextItemIndex = lastTextIndex(timeline);
  const proseCaretVisible = caretInProse(state, timeline);

  function renderCall(call: ToolCallState, key: string): ReactNode {
    if (!call.handoff) return <ToolCallBlock key={key} toolCall={call} conversationId={conversationId} />;
    const line = (
      <HandoffLine
        key={key}
        toolCall={call}
        onOpen={onOpenHandoff ? () => onOpenHandoff(call.toolCallId) : undefined}
      />
    );
    if (waitingShown || helpersRunning < 2 || call.handoff.status !== 'running') return line;
    waitingShown = true;
    return [<HandoffWaitingLabel key={`${key}-waiting`} count={helpersRunning} />, line];
  }

  function renderToolItem(calls: ToolCallState[], key: string): ReactNode {
    if (calls.some((c) => c.handoff)) {
      return <div key={key}>{calls.map((c) => renderCall(c, c.toolCallId))}</div>;
    }
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
        body.push(renderCall(call, `${item.key}-${call.toolCallId}`));
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
      body.push(renderCall(call, `${item.key}-${call.toolCallId}`));
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

  return <>{body}</>;
}
