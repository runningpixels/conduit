import { useEffect, useState } from 'react';
import { useT } from '../../i18n';
import { approveResearchBrief, cancelResearch, stopResearch } from '../../ipc/client';
import type { ResearchBrief, ResearchRun } from '../../ipc/contracts';
import { ChatProse } from '../ChatProse';
import { ResearchBriefEditor } from './ResearchBriefEditor';
import { ResearchSources } from './ResearchSources';
import { useResearchRun } from './useResearchRun';

const PHASE_ID: Record<string, string> = {
  searching: 'chat.research.phase.searching',
  reading: 'chat.research.phase.reading',
  extracting: 'chat.research.phase.extracting',
  'checking gaps': 'chat.research.phase.checkingGaps',
  writing: 'chat.research.phase.writing',
  verifying: 'chat.research.phase.verifying',
};

function hostOfUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

interface ResearchRunCardProps {
  runId: string;
  /** Open the report in the document panel (the same path an artifact chip uses). */
  onOpenArtifact: (artifactId: string) => void;
  onStatus?: (message: string) => void;
}

/**
 * The assistant turn of a Research run. One card, several faces: planning, the
 * brief to approve, live progress, the result, and what is left after a stop
 * or a failure. State lives in Rust; the card reads it with `useResearchRun`
 * and sends the user's decisions back as commands.
 */
export function ResearchRunCard({ runId, onOpenArtifact, onStatus }: ResearchRunCardProps) {
  const t = useT();
  const { run, loadError, accept, refresh } = useResearchRun(runId);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  // A stop request is over once the run has left `running`.
  const status = run?.status;
  useEffect(() => {
    if (status !== 'running') setStopping(false);
  }, [status]);

  async function start(brief: ResearchBrief) {
    setBusy(true);
    setActionError(null);
    try {
      accept(await approveResearchBrief(runId, brief));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setActionError(null);
    try {
      await cancelResearch(runId);
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    setStopping(true);
    setActionError(null);
    try {
      await stopResearch(runId);
      await refresh();
    } catch (error) {
      setStopping(false);
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }

  const title = run?.brief?.question;

  function planning() {
    return (
      <p className="research-wait" role="status">
        <span className="research-spinner" aria-hidden="true" />
        {t('chat.research.planning')}
      </p>
    );
  }

  function renderRunning(current: ResearchRun) {
    const p = current.progress;
    const host = hostOfUrl(p.currentUrl);
    const phaseId = PHASE_ID[p.phase];
    return (
      <div className="research-body">
        <p className="research-phase" role="status" aria-live="polite">
          <span className="research-spinner" aria-hidden="true" />
          {phaseId ? t(phaseId) : p.phase}
        </p>
        <dl className="research-stats">
          <div>
            <dt>{t('chat.research.progress.searches')}</dt>
            <dd>{t('chat.research.progress.ofLimit', { used: p.searchesUsed, limit: p.searchesLimit })}</dd>
          </div>
          <div>
            <dt>{t('chat.research.progress.pages')}</dt>
            <dd>{t('chat.research.progress.ofLimit', { used: p.pagesRead, limit: p.pagesLimit })}</dd>
          </div>
          <div>
            <dt>{t('chat.research.progress.claims')}</dt>
            <dd>{p.claims}</dd>
          </div>
        </dl>
        {host && <p className="research-current">{t('chat.research.progress.current', { host })}</p>}
        {actionError && (
          <p className="error-text" role="alert">
            {actionError}
          </p>
        )}
        <div className="row">
          <button type="button" className="btn" disabled={stopping} onClick={() => void stop()}>
            {stopping ? t('chat.research.stopping') : t('chat.research.stop')}
          </button>
        </div>
      </div>
    );
  }

  function renderFinished(current: ResearchRun) {
    const done = current.status === 'done';
    return (
      <div className="research-body">
        {!done && (
          <p className="research-outcome" role="status">
            {current.status === 'stopped' ? t('chat.research.stoppedNote') : t('chat.research.failedNote')}
          </p>
        )}
        {current.error && (
          <p className="error-text" role="alert">
            {current.error}
          </p>
        )}
        {current.summary && (
          <div className="research-summary">
            <ChatProse content={current.summary} />
          </div>
        )}
        {current.artifactId && (
          <div className="row">
            <button
              type="button"
              className={done ? 'btn primary' : 'btn'}
              onClick={() => onOpenArtifact(current.artifactId!)}
            >
              {t('chat.research.openReport')}
            </button>
          </div>
        )}
        {current.unverifiedDropped > 0 && (
          <p className="research-note">
            {t('chat.research.unverifiedDropped', { count: current.unverifiedDropped })}
          </p>
        )}
        {current.unanswered.length > 0 && (
          <div className="research-note">
            <p className="research-label">{t('chat.research.unanswered')}</p>
            <ul className="research-unanswered">
              {current.unanswered.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          </div>
        )}
        <ResearchSources sources={current.sources} onError={onStatus} />
      </div>
    );
  }

  function renderBody() {
    if (!run) {
      if (loadError) {
        return (
          <div className="research-body">
            <p className="error-text" role="alert">
              {loadError}
            </p>
            <div className="row">
              <button type="button" className="btn ghost" onClick={() => void refresh()}>
                {t('common.actions.retry')}
              </button>
            </div>
          </div>
        );
      }
      return (
        <p className="research-wait" role="status">
          <span className="research-spinner" aria-hidden="true" />
          {t('chat.research.loading')}
        </p>
      );
    }
    switch (run.status) {
      case 'planning':
        return planning();
      case 'awaitingApproval':
        return run.brief ? (
          <ResearchBriefEditor
            brief={run.brief}
            busy={busy}
            error={actionError}
            onStart={(brief) => void start(brief)}
            onCancel={() => void cancel()}
          />
        ) : (
          planning()
        );
      case 'running':
        return renderRunning(run);
      default:
        return renderFinished(run);
    }
  }

  return (
    <section
      className="research-card"
      data-status={run?.status ?? 'loading'}
      aria-label={t('chat.research.card.ariaLabel')}
    >
      <header className="research-head">
        <span className="research-badge">{t('chat.research.badge')}</span>
        {title && (
          <span className="research-title" title={title}>
            {title}
          </span>
        )}
      </header>
      {renderBody()}
    </section>
  );
}
