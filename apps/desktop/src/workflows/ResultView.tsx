/// One run's result: what it saved, readable in place, with a way into the
/// chat, deck or draft it lives in.
///
/// Shared by the workflow page ("Latest result", compact) and the Results
/// inbox (full). A document is read from its artifact and shown as Markdown,
/// read-only; the chat opens it for questions and edits.

import { useEffect, useState } from 'react';
import { isHttpOrHttpsUrl } from '../artifacts/externalUrl';
import { MarkdownRenderer } from '../artifacts/renderers';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { getArtifact, openExternalUrl } from '../ipc/client';
import { OpenExternalLinkDialog } from '../workspace/OpenExternalLinkDialog';
import type { Artifact, WorkflowRun, WorkflowRunOutput } from '../ipc/contracts';
import { otherOutputs, outputKey, primaryOutput } from './results';

export function ResultView({
  run,
  workflowName,
  compact = false,
  onOpenDocument,
  onOpenDeck,
  onOpenDraft,
  onRunDetails,
}: {
  run: WorkflowRun;
  workflowName: string;
  /// Show the start of the document, with "Open full" to read the rest here.
  compact?: boolean;
  onOpenDocument?: (conversationId: string, artifactId: string) => void;
  onOpenDeck?: (deckId: string) => void;
  onOpenDraft?: (draftId: string) => void;
  /// Show this run on its workflow page, with every step.
  onRunDetails?: () => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  const [full, setFull] = useState(false);
  // A link in the document opens in the browser, after asking, as it does in
  // the document panel (the app's own window never navigates away).
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const openLink = (url: string) => {
    if (isHttpOrHttpsUrl(url)) setPendingUrl(url);
  };
  const confirmLink = () => {
    const url = pendingUrl;
    setPendingUrl(null);
    if (!url) return;
    setLinkError(null);
    openExternalUrl(url).catch((e: unknown) => setLinkError(e instanceof Error ? e.message : String(e)));
  };
  const primary = primaryOutput(run);
  const others = otherOutputs(run);
  const artifactId = primary?.kind === 'document' ? (primary.artifactId ?? null) : null;
  const wantContent = artifactId != null && (!compact || full);
  const content = useArtifactText(wantContent ? artifactId : null);
  const when = fmt.timeAgo(run.finishedAt ?? run.startedAt);
  const eyebrow = t('workspace.workflows.result.eyebrow', { name: workflowName, when });

  const open = (output: WorkflowRunOutput) => {
    if (output.kind === 'document' && output.conversationId && output.artifactId) {
      onOpenDocument?.(output.conversationId, output.artifactId);
    } else if (output.kind === 'deck' && output.deckId) {
      onOpenDeck?.(output.deckId);
    } else if (output.kind === 'draft' && output.draftId) {
      onOpenDraft?.(output.draftId);
    }
  };
  const canOpen = (output: WorkflowRunOutput) =>
    (output.kind === 'document' && !!output.conversationId && !!output.artifactId && !!onOpenDocument) ||
    (output.kind === 'deck' && !!output.deckId && !!onOpenDeck) ||
    (output.kind === 'draft' && !!output.draftId && !!onOpenDraft);
  const openLabel = (output: WorkflowRunOutput) =>
    output.kind === 'deck'
      ? t('workspace.workflows.runDetail.openDeck')
      : output.kind === 'draft'
        ? t('workspace.workflows.runDetail.openDraft')
        : t('workspace.workflows.result.openInChat');

  if (!primary) {
    // A stopped run records why ("Stopped before it finished"), but it didn't fail.
    const stopped = run.status === 'stopped';
    const failed = !stopped && (run.status === 'failed' || run.error != null);
    return (
      <article className="wf-result">
        <p className="wf-result-eyebrow">{eyebrow}</p>
        <h4 className="wf-result-title">
          {failed ? t('workspace.workflows.result.failedTitle', { name: workflowName }) : t('workspace.workflows.result.empty')}
        </h4>
        {run.error ? (
          <p className={stopped ? 'wf-muted' : 'wf-error'} role="status">
            {run.error}
          </p>
        ) : null}
        {onRunDetails ? (
          <div className="wf-result-actions">
            <button type="button" className="btn ghost" onClick={onRunDetails}>
              {t('workspace.workflows.result.runDetails')}
            </button>
          </div>
        ) : null}
      </article>
    );
  }

  // The artifact's text when it is something Markdown can show; a web page is
  // opened, not injected.
  const readable = content.artifact && (content.artifact.kind === 'markdown' || content.artifact.kind === 'text');
  const html = content.artifact?.kind === 'html';
  const text = readable ? (content.artifact?.contentText ?? '') : '';

  return (
    <article className="wf-result">
      <p className="wf-result-eyebrow">{eyebrow}</p>
      <h4 className="wf-result-title">{primary.title}</h4>
      {primary.kind === 'document' ? (
        <div className="wf-result-body">
          {readable && text ? (
            <MarkdownRenderer source={text} onExternalLink={openLink} />
          ) : (
            <>
              {primary.preview ? <p className="wf-result-preview">{primary.preview}</p> : null}
              {html ? <p className="wf-muted">{t('workspace.workflows.result.htmlNote')}</p> : null}
            </>
          )}
        </div>
      ) : primary.kind === 'file' && primary.path && primary.path !== primary.title ? (
        <p className="wf-result-file">
          <span className="wf-muted">{t('workspace.workflows.result.savedTo')}</span>{' '}
          <span className="wf-result-path">{primary.path ?? primary.title}</span>
        </p>
      ) : primary.preview ? (
        <p className="wf-result-preview">{primary.preview}</p>
      ) : null}
      <div className="wf-result-actions">
        {canOpen(primary) ? (
          <button type="button" className="btn primary" onClick={() => open(primary)}>
            {openLabel(primary)}
          </button>
        ) : null}
        {compact && !full && primary.kind === 'document' && artifactId ? (
          <button type="button" className="btn ghost" onClick={() => setFull(true)}>
            {t('workspace.workflows.result.openFull')}
          </button>
        ) : null}
        {onRunDetails ? (
          <button type="button" className="btn ghost" onClick={onRunDetails}>
            {t('workspace.workflows.result.runDetails')}
          </button>
        ) : null}
      </div>
      {others.length > 0 ? (
        <ul className="wf-result-others">
          {others.map((output) => (
            <li key={outputKey(output)}>
              {canOpen(output) ? (
                <button type="button" className="btn ghost" onClick={() => open(output)}>
                  {output.title}
                </button>
              ) : (
                <span className="wf-muted wf-result-path">{output.path ?? output.title}</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {linkError ? (
        <p className="wf-error" role="alert">
          {linkError}
        </p>
      ) : null}
      <OpenExternalLinkDialog url={pendingUrl} onConfirm={confirmLink} onCancel={() => setPendingUrl(null)} />
    </article>
  );
}

/// The artifact behind a document output, or nothing while it loads or when it
/// can't be read (the preview stands in).
function useArtifactText(artifactId: string | null): { artifact: Artifact | null } {
  const [state, setState] = useState<{ id: string | null; artifact: Artifact | null }>({ id: null, artifact: null });
  useEffect(() => {
    if (!artifactId) return;
    let cancelled = false;
    Promise.resolve()
      .then(() => getArtifact(artifactId))
      .then(
        (artifact) => {
          if (!cancelled) setState({ id: artifactId, artifact });
        },
        () => {
          if (!cancelled) setState({ id: artifactId, artifact: null });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [artifactId]);
  return { artifact: artifactId && state.id === artifactId ? state.artifact : null };
}
