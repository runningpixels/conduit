/// The draft's Sources tab: what the assistant may draw facts from while it
/// writes. Web search (local web_search and web_fetch), document collections
/// (attached to the draft's chat, as in any chat) and finished Research
/// reports (their verified claims go into each turn). Props-driven: App owns
/// every IPC call.

import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import type { KnowledgeCollection, ResearchReportSummary } from '../ipc/contracts';

export interface DraftSourcesPanelProps {
  webSearch: boolean;
  /** Why web search cannot be turned on (already translated), or null. */
  webDisabledReason: string | null;
  onToggleWeb: (on: boolean) => void;
  /** Null while loading. */
  collections: KnowledgeCollection[] | null;
  enabledCollectionIds: readonly string[];
  onToggleCollection: (collectionId: string, on: boolean) => void;
  /** Null while loading. */
  reports: ResearchReportSummary[] | null;
  attachedRunIds: readonly string[];
  onToggleReport: (runId: string, on: boolean) => void;
  /** A change is being saved: the controls wait. */
  saving?: boolean;
  error?: string | null;
}

export function DraftSourcesPanel({
  webSearch,
  webDisabledReason,
  onToggleWeb,
  collections,
  enabledCollectionIds,
  onToggleCollection,
  reports,
  attachedRunIds,
  onToggleReport,
  saving = false,
  error = null,
}: DraftSourcesPanelProps) {
  const t = useT();
  const fmt = useFormatters();
  const enabled = new Set(enabledCollectionIds);
  const attached = new Set(attachedRunIds);
  const webDisabled = webDisabledReason != null;

  return (
    <section className="draft-sources" aria-label={t('writing.sources.title')}>
      <header className="deck-history-head">
        <h3 className="deck-history-title">{t('writing.sources.title')}</h3>
      </header>
      <div className="draft-sources-body">
        <p className="draft-sources-help">{t('writing.sources.help')}</p>
        {error && (
          <p className="deck-history-error" role="alert">
            {error}
          </p>
        )}

        <div className="draft-sources-group">
          <label className="draft-sources-row" data-disabled={webDisabled ? 'true' : undefined}>
            <input
              type="checkbox"
              checked={webSearch && !webDisabled}
              disabled={webDisabled || saving}
              aria-describedby="draft-sources-web-note"
              onChange={(e) => onToggleWeb(e.target.checked)}
            />
            <span className="draft-sources-name" title={t('writing.sources.web.label')}>
              {t('writing.sources.web.label')}
            </span>
          </label>
          <p id="draft-sources-web-note" className="draft-sources-note">
            {webDisabledReason ?? t('writing.sources.web.hint')}
          </p>
        </div>

        <div className="draft-sources-group" role="group" aria-labelledby="draft-sources-docs-title">
          <h4 id="draft-sources-docs-title" className="draft-sources-subtitle">
            {t('writing.sources.documents.title')}
          </h4>
          {collections == null ? (
            <p className="draft-sources-note">{t('writing.sources.loading')}</p>
          ) : collections.length === 0 ? (
            <p className="draft-sources-note">{t('writing.sources.documents.empty')}</p>
          ) : (
            <ul className="draft-sources-list">
              {collections.map((collection) => (
                <li key={collection.id}>
                  <label className="draft-sources-row">
                    <input
                      type="checkbox"
                      checked={enabled.has(collection.id)}
                      disabled={saving}
                      onChange={(e) => onToggleCollection(collection.id, e.target.checked)}
                    />
                    <span className="draft-sources-name" title={collection.name}>
                      {collection.name}
                    </span>
                    <span className="draft-sources-meta">
                      {t('writing.sources.documents.count', { count: collection.documentCount })}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="draft-sources-group" role="group" aria-labelledby="draft-sources-reports-title">
          <h4 id="draft-sources-reports-title" className="draft-sources-subtitle">
            {t('writing.sources.reports.title')}
          </h4>
          {reports == null ? (
            <p className="draft-sources-note">{t('writing.sources.loading')}</p>
          ) : reports.length === 0 ? (
            <p className="draft-sources-note">{t('writing.sources.reports.empty')}</p>
          ) : (
            <ul className="draft-sources-list">
              {reports.map((report) => (
                <li key={report.runId}>
                  <label className="draft-sources-row">
                    <input
                      type="checkbox"
                      checked={attached.has(report.runId)}
                      disabled={saving}
                      onChange={(e) => onToggleReport(report.runId, e.target.checked)}
                    />
                    <span className="draft-sources-name" title={report.question}>
                      {report.question}
                    </span>
                    <span className="draft-sources-meta">
                      {t('writing.sources.reports.meta', { claims: report.claims, sources: report.citedSources })}
                      {report.finishedAt ? ` · ${fmt.timeAgo(report.finishedAt)}` : ''}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
