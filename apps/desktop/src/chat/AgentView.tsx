/// One helper's own view, in place of the chat's thread: where it sits (a
/// breadcrumb back to the chat), who it is and how it is doing, its task, and
/// its transcript live, with nested helpers as lines that open a level deeper.
/// A strip at the bottom says what the main chat is doing and leads back.

import { useState } from 'react';
import { ProviderBadge, splitModel } from '../agents/ProviderBadge';
import { AgentsIcon, ChevronLeft, ChevronRight } from '../icons';
import { useT } from '../i18n';
import { stopAgentCall } from '../ipc/client';
import type { Artifact, FileState } from '../ipc/contracts';
import { ChatProse } from './ChatProse';
import { HANDOFF_STATUS_KEYS, useHandoffNumbers } from './HandoffLine';
import { TurnBody } from './TurnBody';
import { shortTask, streamedText, type AgentLevel } from './agentViewModel';
import type { ArtifactCandidate } from './artifactCandidates';

/// What the main chat is doing, for the strip at the bottom.
export type MainChatState = { kind: 'waiting'; count: number } | { kind: 'working' } | { kind: 'replied' };

interface AgentViewProps {
  /// The open path, outermost first; the last level is the helper shown.
  levels: AgentLevel[];
  main: MainChatState;
  conversationId: string | null;
  /// What the user told this helper from the composer, oldest first.
  notes: readonly string[];
  /// Why the last message to this helper did not reach it, if it didn't.
  sendError: string | null;
  /// Show the path's first `depth` levels: 0 is the main chat.
  onNavigate: (depth: number) => void;
  /// Up one level (the Back button and Escape).
  onBack: () => void;
  /// Open a hand-off inside the shown helper, one level deeper.
  onOpenHandoff: (toolCallId: string) => void;
  artifacts?: Artifact[];
  fileStateMap?: Record<string, FileState>;
  onPromoteArtifact?: (messageId: string, candidate: ArtifactCandidate) => void;
  onOpenArtifact?: (artifactId: string) => void;
  onStatus?: (message: string) => void;
}

export function AgentView({
  levels,
  main,
  conversationId,
  notes,
  sendError,
  onNavigate,
  onBack,
  onOpenHandoff,
  artifacts,
  fileStateMap,
  onPromoteArtifact,
  onOpenArtifact,
  onStatus,
}: AgentViewProps) {
  const t = useT();
  const { handoff } = levels[levels.length - 1];
  const { inner } = handoff;
  const running = handoff.status === 'running';
  const numbers = useHandoffNumbers(handoff);
  const { modelId } = splitModel(handoff.model);
  const [stopFailed, setStopFailed] = useState(false);
  const [stopping, setStopping] = useState(false);
  const pathKey = levels.map((l) => l.toolCallId).join('/');
  const hasText = streamedText(inner);
  const empty = inner.toolCalls.length === 0 && inner.reasoning.length === 0 && !hasText;

  async function stop() {
    setStopping(true);
    try {
      await stopAgentCall(handoff.callId);
      setStopFailed(false);
    } catch {
      setStopFailed(true);
    } finally {
      setStopping(false);
    }
  }

  const mainText =
    main.kind === 'waiting'
      ? t('chat.agentView.mainWaiting', { count: main.count })
      : main.kind === 'working'
        ? t('chat.agentView.mainWorking')
        : t('chat.agentView.mainReplied');

  return (
    <section className="agent-view" aria-label={t('chat.agentView.regionAria', { name: handoff.name })}>
      {/* Sticky together: the live view follows the newest output, and the name, status and Stop must not scroll away. */}
      <div className="agent-view-top">
        <nav className="agent-view-crumbs" aria-label={t('chat.agentView.breadcrumbAria')}>
          <button type="button" className="agent-view-back" onClick={onBack}>
            <ChevronLeft aria-hidden="true" />
            <span>{t('chat.agentView.back')}</span>
          </button>
          <ol>
            <li>
              <button
                type="button"
                className="agent-view-crumb"
                title={t('chat.agentView.chat')}
                onClick={() => onNavigate(0)}
              >
                {t('chat.agentView.chat')}
              </button>
            </li>
            {levels.map((level, i) => {
              const last = i === levels.length - 1;
              const label = [level.handoff.name, shortTask(level.handoff.task)].filter(Boolean).join(' · ');
              return (
                <li key={level.toolCallId}>
                  <ChevronRight className="agent-view-sep" aria-hidden="true" />
                  <button
                    type="button"
                    className="agent-view-crumb"
                    title={level.handoff.task}
                    aria-current={last ? 'page' : undefined}
                    onClick={() => (last ? undefined : onNavigate(i + 1))}
                  >
                    {label}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <header className="agent-view-head" data-status={handoff.status}>
          <span className="agent-view-icon" aria-hidden="true">
            <AgentsIcon />
          </span>
          <h2 className="agent-view-name">{handoff.name}</h2>
          <ProviderBadge model={handoff.model} />
          {modelId ? (
            <span className="agent-view-model" title={modelId}>
              {modelId}
            </span>
          ) : null}
          <span className="agent-view-status" data-status={handoff.status}>
            {t(HANDOFF_STATUS_KEYS[handoff.status])}
          </span>
          {numbers ? <span className="agent-view-nums">{numbers}</span> : null}
          {running && handoff.callId ? (
            <button
              type="button"
              className="btn ghost helper-btn agent-view-stop"
              disabled={stopping}
              aria-label={t('chat.handoff.stopAria', { name: handoff.name })}
              onClick={() => void stop()}
            >
              {t('chat.handoff.stop')}
            </button>
          ) : null}
        </header>
      </div>
      {stopFailed ? (
        <p className="helper-error" role="status">
          {t('chat.handoff.controlFailed', { name: handoff.name })}
        </p>
      ) : null}

      {/* A lead writes long tasks: three lines until clicked. */}
      <details className="handoff-task agent-view-task" key={`task-${pathKey}`}>
        <summary>
          <span className="handoff-task-label">{t('chat.handoff.task')}</span>
          <span className="handoff-task-text">{handoff.task}</span>
        </summary>
      </details>

      <div className="agent-view-body">
        <TurnBody
          key={pathKey}
          state={inner}
          conversationId={conversationId}
          onOpenHandoff={onOpenHandoff}
          artifacts={artifacts}
          fileStateMap={fileStateMap}
          onPromoteArtifact={onPromoteArtifact}
          onOpenArtifact={onOpenArtifact}
          onStatus={onStatus}
        />
        {/* A reloaded helper keeps its tool calls but not its streamed text. */}
        {!hasText && handoff.answer ? <ChatProse content={handoff.answer} streaming={false} /> : null}
        {running && empty ? <p className="handoff-note">{t('chat.handoff.status.running')}</p> : null}
        {handoff.error ? <p className="error-text">{handoff.error}</p> : null}
        {notes.map((note, i) => (
          <p key={i} className="agent-view-note">
            {t('chat.agentView.you', { text: note })}
          </p>
        ))}
        {sendError ? (
          <p className="helper-error" role="status">
            {sendError}
          </p>
        ) : null}
        {running ? <span className="streaming thinking-trailing" aria-hidden="true" /> : null}
      </div>

      <button type="button" className="agent-view-main" data-state={main.kind} onClick={() => onNavigate(0)}>
        <span className="agent-view-main-text">{mainText}</span>
        <span className="agent-view-main-back">
          {t('chat.agentView.toChat')}
          <ChevronRight aria-hidden="true" />
        </span>
      </button>
    </section>
  );
}
