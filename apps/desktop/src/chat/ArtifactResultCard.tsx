/// In-chat artifact affordances:
///   * `ArtifactResultCard` — a full-width card for one artifact. Rendered
///     inline by `InlineArtifactCard` where the document was produced, and by
///     the strip below for artifacts with no corresponding fence.
///   * `AssistantArtifactStrip` — stacks the end-of-turn cards.
///
/// The card replaces the ≤280px reference pill this file used to render. The
/// pill opened the context panel on click, but nothing on screen said so — a
/// produced document is a result, not a tag, so it gets a stated primary action
/// and the same ⋯ actions the panel head carries.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, ArtifactKind, FileState } from '../ipc/contracts';
import { exportArtifact, getArtifactContentBytes, revealPath } from '../ipc/client';
import { inlineArtifactText } from '../artifacts/format';
import { readExportMetadata } from '../shell/uiPrefs';
import { Menu } from '../workspace/Menu';
import { CopyIcon, DownloadIcon, FilePlainIcon, MoreIcon } from '../icons';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { documentKindLabel } from '../lib/documentKind';

// Artifact kind names — format identifiers, not prose, so they are not passed
// through `t()` (D7 treats `Markdown`/`JSON`/`HTML` this way already; `Code`
// and `Text` ride along for consistency with the same map elsewhere).
const STATE_DOT_CLASS: Record<FileState, string> = {
  ok: 'dot ok',
  modified: 'dot warn',
  missing: 'dot bad',
  noFileContent: 'dot hold',
};

const STATE_TITLE_ID: Record<FileState, string> = {
  ok: 'chat.artifactCard.state.ok',
  modified: 'chat.artifactCard.state.modified',
  missing: 'chat.artifactCard.state.missing',
  noFileContent: 'chat.artifactCard.state.noFileContent',
};

interface ArtifactResultCardProps {
  artifact: Artifact;
  fileState?: FileState;
  onOpen: (artifactId: string) => void;
  /** Surfaces IPC failures + export destinations on the app status line. */
  onStatus?: (message: string) => void;
}

/** Full-width result card for an artifact produced by this message. */
export function ArtifactResultCard({ artifact, fileState, onOpen, onStatus }: ArtifactResultCardProps) {
  const t = useT();
  const fmt = useFormatters();
  const [menuOpen, setMenuOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);

  const title = artifact.title ?? t('chat.artifactCard.untitled');
  const kindLabel = documentKindLabel(artifact.kind, t);
  // '' rather than the panel's em dash: an unknown size should drop out of the
  // subtitle entirely, not render as a placeholder next to the kind.
  const size = fmt.size(artifact.sizeBytes, '');

  useEffect(() => {
    if (!menuOpen) return;
    function handleClick(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  async function handleCopy() {
    setMenuOpen(false);
    try {
      // Artifacts reach the transcript from `listArtifacts`, which may carry
      // metadata only, so fall back to fetching the stored bytes.
      let text = inlineArtifactText(artifact);
      if (!text) {
        const bytes = await getArtifactContentBytes(artifact.id);
        text = new TextDecoder().decode(Uint8Array.from(bytes));
      }
      await navigator.clipboard.writeText(text);
      onStatus?.(t('chat.artifactCard.copied'));
    } catch (e) {
      onStatus?.(e instanceof Error ? e.message : t('chat.artifactCard.copyFailed'));
    }
  }

  /// Export, then show the user where the file landed.
  ///
  /// This absorbs the old "Reveal in Explorer" item, which could never work: an
  /// artifact's payload lives in the database as text, `content_path` is never
  /// populated, and file payloads are encrypted on disk. Export is the only step
  /// that produces a readable file, so revealing is only meaningful after it.
  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    try {
      const result = await exportArtifact(artifact.id, readExportMetadata() === 'on');
      onStatus?.(t('chat.artifactCard.exportedTo', { path: result.exportedTo }));
      setMenuOpen(false);
      // The file is written at this point. A file manager that refuses to open
      // must not make a successful export look like a failure.
      try {
        await revealPath();
      } catch {
        /* export succeeded; revealing is a convenience */
      }
    } catch (e) {
      onStatus?.(e instanceof Error ? e.message : t('chat.artifactCard.exportFailed'));
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="artifact-card">
      <span className="artifact-card-icon" aria-hidden="true">
        <FilePlainIcon />
      </span>
      <div className="artifact-card-body">
        <div className="artifact-card-title">
          <span className="artifact-card-name" title={title}>{title}</span>
          {fileState && (
            <span className={STATE_DOT_CLASS[fileState]} title={t(STATE_TITLE_ID[fileState])} />
          )}
        </div>
        <div className="artifact-card-meta">{size ? `${kindLabel} · ${size}` : kindLabel}</div>
      </div>
      <button
        type="button"
        className="btn artifact-card-open"
        title={t('chat.artifactCard.openTitle', { title })}
        onClick={() => onOpen(artifact.id)}
      >
        {t('common.actions.open')}
      </button>
      <div className="artifact-card-overflow" ref={menuRef}>
        <button
          ref={menuTriggerRef}
          type="button"
          className="icon-btn"
          aria-label={t('chat.artifactCard.moreActionsLabel', { title })}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <MoreIcon />
        </button>
        <Menu
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          triggerRef={menuTriggerRef}
          className="menu artifact-card-menu"
          label={t('chat.artifactCard.menuLabel')}
        >
          <button className="menu-item" type="button" role="menuitem" onClick={() => void handleCopy()}>
            <CopyIcon />
            {t('chat.artifactCard.copyContents')}
          </button>
          <button
            className="menu-item"
            type="button"
            role="menuitem"
            disabled={exporting}
            onClick={() => void handleExport()}
          >
            <DownloadIcon />
            {exporting ? t('chat.artifactCard.exporting') : t('chat.artifactCard.saveCopy')}
          </button>
        </Menu>
      </div>
    </div>
  );
}

interface AssistantArtifactStripProps {
  messageId: string;
  artifacts: Artifact[];
  fileStateMap?: Record<string, FileState>;
  /// Artifacts already rendered as a card inside the message body (§8.5), so
  /// they are not reported a second time at the end of the turn.
  excludeArtifactIds?: ReadonlySet<string>;
  onOpenArtifact: (artifactId: string) => void;
  onStatus?: (message: string) => void;
}

/** Result cards for artifacts linked to this assistant turn that have no
 *  in-body card of their own — chiefly the tool-created case, where nothing in
 *  the reply text corresponds to the artifact. */
export function AssistantArtifactStrip({
  messageId,
  artifacts,
  fileStateMap,
  excludeArtifactIds,
  onOpenArtifact,
  onStatus,
}: AssistantArtifactStripProps) {
  const promoted = useMemo(
    () =>
      artifacts.filter(
        (a) => a.sourceMessageId === messageId && !excludeArtifactIds?.has(a.id),
      ),
    [artifacts, messageId, excludeArtifactIds],
  );

  if (promoted.length === 0) return null;

  return (
    <div className="artifact-strip">
      {promoted.map((artifact) => (
        <ArtifactResultCard
          key={artifact.id}
          artifact={artifact}
          fileState={fileStateMap?.[artifact.id]}
          onOpen={onOpenArtifact}
          onStatus={onStatus}
        />
      ))}
    </div>
  );
}
