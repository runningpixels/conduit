import { BrandMark, ChevronRight } from '../icons';

interface ArtifactEmptyStateProps {
  onCollapsePanel?: () => void;
  collapseShortcutHint?: string;
}

/**
 * Orientation empty state for the artifact pane when no document is open.
 * Prompt chips live only in the chat empty state — this panel explains what
 * the column is for without duplicating interactive starters.
 */
export function ArtifactEmptyState({
  onCollapsePanel,
  collapseShortcutHint,
}: ArtifactEmptyStateProps) {
  return (
    <section className="doc-panel doc-panel-empty" aria-label="Document panel">
      {onCollapsePanel && (
        <div className="doc-toolbar">
          <span className="doc-toolbar-spacer" />
          <div className="doc-actions">
            <button
              className="icon-btn"
              type="button"
              aria-label="Hide artifact panel"
              aria-pressed={false}
              title={
                collapseShortcutHint
                  ? `Hide artifact panel (${collapseShortcutHint})`
                  : 'Hide artifact panel'
              }
              onClick={onCollapsePanel}
            >
              <ChevronRight />
            </button>
          </div>
        </div>
      )}
      <div className="doc-body scroll">
        <div className="artifact-empty">
          <div className="artifact-empty-icon" aria-hidden="true">
            <BrandMark />
          </div>
          <h2 className="artifact-empty-title">Artifacts live here</h2>
          <p className="artifact-empty-copy">
            When you promote a reply — markdown, HTML, JSON, or code — it opens
            in this panel for preview, edit, and export. Start from chat; results
            show up here.
          </p>
        </div>
      </div>
    </section>
  );
}
