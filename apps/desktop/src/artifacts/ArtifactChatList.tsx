import type { ReactNode } from 'react';
import type { Artifact } from '../ipc/contracts';
import { ChevronRight, FilePlainIcon } from '../icons';
import { useT } from '../i18n';
import { ImageRenderer } from './ImageRenderer';
import { useFormatters } from '../i18n/formatters';
import { documentKindLabel } from '../lib/documentKind';

/** A chat's artifacts, newest first: the order the list and the header
 *  switcher both show. */
export function newestFirst(artifacts: readonly Artifact[]): Artifact[] {
  return [...artifacts].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

export interface ArtifactChatListProps {
  /** The open chat's artifacts, in any order. */
  artifacts: readonly Artifact[];
  onOpen: (artifactId: string) => void;
  onCollapsePanel?: () => void;
  collapseShortcutHint?: string;
  /** The inspector's tab strip, shown at the top of the panel. */
  inspectorTabs?: ReactNode;
}

/**
 * What the panel shows for a chat that has artifacts when none is open:
 * opening such a chat, or closing its artifact, used to land on the generic
 * "Artifacts live here" card, and the reader had to scroll the thread back
 * to a card to see what the chat had made. A chat with none keeps that card.
 */
export function ArtifactChatList({
  artifacts,
  onOpen,
  onCollapsePanel,
  collapseShortcutHint,
  inspectorTabs,
}: ArtifactChatListProps) {
  const t = useT();
  const fmt = useFormatters();
  const rows = newestFirst(artifacts);

  return (
    <section className="doc-panel doc-panel-list" aria-label={t('workspace.documentPanel.ariaLabel')}>
      {inspectorTabs}
      <div className="doc-toolbar">
        <div className="doc-title">
          <h2 className="artifact-list-heading">{t('workspace.documentPanel.chatList.title')}</h2>
          <small>{t('workspace.documentPanel.chatList.count', { count: rows.length })}</small>
        </div>
        <span className="doc-toolbar-spacer" />
        {onCollapsePanel && (
          <div className="doc-actions">
            <button
              className="icon-btn"
              type="button"
              aria-label={t('workspace.documentPanel.hidePanelAriaLabel')}
              aria-pressed={false}
              title={
                collapseShortcutHint
                  ? t('workspace.documentPanel.hidePanelTitleWithShortcut', { shortcut: collapseShortcutHint })
                  : t('workspace.documentPanel.hidePanelAriaLabel')
              }
              onClick={onCollapsePanel}
            >
              <ChevronRight />
            </button>
          </div>
        )}
      </div>
      <div className="doc-body scroll">
        <ul className="artifact-list" aria-label={t('workspace.documentPanel.chatList.ariaLabel')}>
          {rows.map((artifact) => {
            const title = artifact.title?.trim() || t('workspace.documentPanel.untitledArtifact');
            const when = artifact.updatedAt ?? artifact.createdAt;
            const meta = [documentKindLabel(artifact.kind, t), fmt.size(artifact.sizeBytes, '')]
              .filter(Boolean)
              .join(' · ');
            return (
              <li key={artifact.id} className="artifact-list-row">
                <span
                  className={artifact.kind === 'image' ? 'artifact-card-icon artifact-card-icon--image' : 'artifact-card-icon'}
                  aria-hidden="true"
                >
                  {artifact.kind === 'image' ? <ImageRenderer artifact={artifact} /> : <FilePlainIcon />}
                </span>
                <div className="artifact-list-body">
                  <span className="artifact-list-name" title={title}>{title}</span>
                  <span className="artifact-list-meta">
                    {meta} ·{' '}
                    <time dateTime={when} title={new Date(when).toLocaleString(fmt.locale)}>
                      {fmt.timeAgo(when)}
                    </time>
                  </span>
                </div>
                {/* The button stretches over the row (CSS), so the whole row
                    opens it while the keyboard still meets a real button. */}
                <button
                  type="button"
                  className="btn artifact-list-open"
                  aria-label={t('workspace.documentPanel.chatList.openAriaLabel', { title })}
                  onClick={() => onOpen(artifact.id)}
                >
                  {t('common.actions.open')}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
