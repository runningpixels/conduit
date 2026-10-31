import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { TurnModelLine } from './TurnModelLine';
import { ThinkingIndicator } from './ThinkingIndicator';
import { streamStalled } from './documentWriteScan';
import { allToolCalls, type AssistantStreamState } from './streamState';
import type { Artifact, FileState } from '../ipc/contracts';
import { detectArtifactCandidates, type ArtifactCandidate } from './artifactCandidates';
import { inlineArtifactIds } from './inlineArtifact';
import { CheckIcon, CopyIcon, ForkIcon, RetryIcon, TrashIcon } from '../icons';
import { InterruptedBanner } from './InterruptedBanner';
import { HandoffTotals } from './HandoffLine';
import { UsageSummary } from './UsageSummary';
import { AssistantArtifactStrip } from './ArtifactResultCard';
import { providerHueId } from '../lib/providerIdentity';
import { useT } from '../i18n';
import { TurnBody, proseCarriesCaret } from './TurnBody';
import { ScheduleThisButton } from './ScheduleThisButton';

export { groupToolCalls, synthesizeSegments, toolCallStaysInline } from './TurnBody';

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
  /** Write this reply further from where the output limit cut it off. Pass it
   *  only while no turn is running; it shows on the last reply only. */
  onContinue?: () => void;
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
  /// A reply one of the user's agents gave: "Schedule this…" opens the routine form.
  onSchedule?: { name: string; run: () => void };
  /// The reply's version switcher (`‹ 2 / 3 ›`), when Retry has kept earlier versions.
  versions?: ReactNode;
  /// Retry ▾ next to Retry: retry this reply with another model.
  retryWithModel?: ReactNode;
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
  /** Open a hand-off's own view (the agent view), by the lead's tool call id. */
  onOpenHandoff?: (toolCallId: string) => void;
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
  onContinue,
  onRetryWithoutLimit,
  outputLimit,
  onDelete,
  onCopy,
  onFork,
  onSchedule,
  versions,
  retryWithModel,
  isLast = true,
  conversationId = null,
  documentWriteHeld = false,
  turnId,
  onOpenActivity,
  compact = false,
  deckSlideIds,
  onOpenHandoff,
}: AssistantMessageProps) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const text = state.blocks
    .filter((b) => b.blockKind !== 'thinking' && b.blockKind !== 'reasoning')
    .map((b) => b.content)
    .join('');
  const elapsed = useLiveElapsed(state.streaming);
  // Reasoning and tool arguments are model output too. Counting only prose
  // held this at "0 tok" through visibly streaming reasoning, and froze it for
  // the whole time a document was written into a tool call.
  const argumentChars = state.toolCalls.reduce((n, tc) => n + tc.argumentsText.length, 0);
  const reasoningChars = state.reasoning.reduce((n, b) => n + b.content.length, 0);
  const tokenCount = Math.round((text.length + argumentChars + reasoningChars) / 4);
  // `elapsed` ticks every second while streaming, so this re-evaluates on its own.
  const stalled = state.streaming && streamStalled(state.lastEventAt, Date.now());
  const awaitingApproval = allToolCalls(state).some((tc) => tc.sideEffecting && tc.consent === 'pending');
  const waitingOnReader = Boolean(state.askUser) || awaitingApproval;

  const producingText = state.blocks.some(
    (b) =>
      b.content.length > 0 && b.blockKind !== 'thinking' && b.blockKind !== 'reasoning',
  );
  const proseCaretVisible = useMemo(() => proseCarriesCaret(state), [state]);

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
      <TurnBody
        state={state}
        messageId={messageId}
        artifacts={artifacts}
        fileStateMap={fileStateMap}
        onPromoteArtifact={onPromoteArtifact}
        onOpenArtifact={onOpenArtifact}
        onStatus={onStatus}
        conversationId={conversationId}
        turnId={turnId}
        onOpenActivity={onOpenActivity}
        compact={compact}
        deckSlideIds={deckSlideIds}
        onOpenHandoff={onOpenHandoff}
      />
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
      {/* Continue writes the same reply further, from where it stopped. Only
          the last reply, and only when no turn is running (the caller passes
          `onContinue` only then). */}
      {!state.streaming &&
        !state.error &&
        state.finishReason === 'length' &&
        isLast &&
        onContinue && (
          <button
            type="button"
            className="act turn-continue-building"
            aria-label={t('chat.assistant.continueReplyLabel')}
            title={t('chat.assistant.continueReplyLabel')}
            onClick={onContinue}
          >
            {t('chat.assistant.continueReply')}
          </button>
        )}
      {state.toolCalls.some((tc) => tc.handoff) && <HandoffTotals state={state} />}
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

      {(onCopy || showActions || onFork || onSchedule || state.usage || versions) && (
      <div className="turn-actions">
        {versions}
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
        {showActions && onRetry && retryWithModel}
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
        {onSchedule ? <ScheduleThisButton name={onSchedule.name} onClick={onSchedule.run} /> : null}
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
