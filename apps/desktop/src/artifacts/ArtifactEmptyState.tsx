import { BrandMark } from '../icons';

/**
 * Orientation empty state for the artifact pane when no document is open.
 * Prompt chips live only in the chat empty state — this panel explains what
 * the column is for without duplicating interactive starters.
 *
 * No toolbar. The bar this used to render held nothing but a flex spacer and a
 * collapse chevron — 44px of raised fill and a border, blank, at the top of a
 * panel that already says it is empty. Hiding the panel is the top bar's
 * button (and ⌘J); an in-panel control earns its place only once there is
 * something in the panel to sit beside.
 */
export function ArtifactEmptyState() {
  return (
    <section className="doc-panel doc-panel-empty" aria-label="Document panel">
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
