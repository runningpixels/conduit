/// Documents (rail destination): knowledge collections for chat (t1-6, t1-8).
///
/// List-and-detail: collections on the left; the selected one's documents,
/// actions and consent state on the right. The flows themselves live in
/// `useKnowledgeBase`; this file only arranges them.
import type { AppSettings, KnowledgeCollection, KnowledgeDocument } from '../ipc/contracts';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { PageEmpty, PageFrame, PageListItem } from '../shell/PageFrame';
import {
  ImportProgressBar,
  fileName,
  useKnowledgeBase,
  type KnowledgeImporting,
} from '../workspace/settings/KnowledgeSection';

export interface DocumentsPageProps {
  settings: AppSettings;
  /** Receives settings the page has already persisted — a plain setter. */
  onSettingsChange: (next: AppSettings) => void;
  onStatus: (message: string) => void;
  /** Files dropped onto the window, waiting for a collection. */
  pendingPaths: string[];
  onPendingPathsHandled: () => void;
}

/** A short type label from the file's extension: `PDF`, `MD`, `DOCX`. */
function typeLabel(doc: KnowledgeDocument): string {
  const name = fileName(doc.source);
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toUpperCase();
  return doc.mimeType ?? '';
}

export function DocumentsPage({
  settings,
  onSettingsChange,
  onStatus,
  pendingPaths,
  onPendingPathsHandled,
}: DocumentsPageProps) {
  const t = useT();
  const kb = useKnowledgeBase({
    settings,
    onUpdate: onSettingsChange,
    onStatus,
    pendingPaths,
    onPendingPathsHandled,
  });
  const { collections, selected, busy, importing } = kb;

  // Providers with consent that no collection uses any more: still revocable.
  const collectionProviders = new Set(collections.map((c) => c.providerId));
  const orphanConsents = settings.embeddingConsentProviders.filter((p) => !collectionProviders.has(p));

  const newCollection = (
    <button className="btn primary" type="button" disabled={busy} onClick={kb.createCollection}>
      {t('settings.knowledge.actions.createCollection')}
    </button>
  );

  const about = (
    <>
      <p>{t('shell.documentsSheet.intro')}</p>
      <p>{t('settings.knowledge.intro')}</p>
      <p>{t('settings.knowledge.consentList.intro')}</p>
    </>
  );

  const list =
    collections.length === 0 ? (
      <p className="docs-list-hint">{t('shell.documentsPage.emptyTitle')}</p>
    ) : (
      <>
        {collections.map((collection) => (
          <PageListItem
            key={collection.id}
            selected={selected?.id === collection.id}
            onSelect={() => kb.select(collection.id)}
            title={collection.name}
            status={importing?.collectionId === collection.id ? t('shell.documentsPage.importing') : undefined}
            meta={t('shell.documentsPage.collectionMeta', {
              documents: t('settings.knowledge.collection.docCount', { count: collection.documentCount }),
              provider: collection.providerId,
            })}
          />
        ))}
        {orphanConsents.length > 0 && (
          <div className="kb-consent-list">
            <div className="page-list-group">{t('shell.documentsPage.otherConsent')}</div>
            {orphanConsents.map((providerId) => (
              <div key={providerId} className="docs-consent-orphan">
                <span>{providerId}</span>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={busy}
                  aria-label={t('shell.documentsPage.revokeProvider', { provider: providerId })}
                  onClick={() => kb.revokeConsent(providerId)}
                >
                  {t('settings.knowledge.consentList.revoke')}
                </button>
              </div>
            ))}
          </div>
        )}
      </>
    );

  return (
    <PageFrame
      className="docs-page"
      title={t('shell.documentsSheet.heading')}
      subtitle={t('shell.documentsPage.subtitle')}
      actions={collections.length > 0 ? newCollection : undefined}
      about={about}
      list={list}
      listLabel={t('shell.documentsPage.listLabel')}
    >
      {pendingPaths.length > 0 && (
        <DropBanner
          pendingPaths={pendingPaths}
          collections={collections}
          target={kb.dropTarget}
          busy={busy}
          onTarget={kb.setDropTargetId}
          onAdd={() => void kb.addDropped()}
          onCancel={onPendingPathsHandled}
        />
      )}
      {selected ? (
        <CollectionDetail
          collection={selected}
          documents={kb.documents}
          consented={settings.embeddingConsentProviders.includes(selected.providerId)}
          importing={importing?.collectionId === selected.id ? importing : null}
          busy={busy}
          onImport={() => void kb.importDocument(selected)}
          onRename={() => kb.renameCollection(selected)}
          onDelete={() => kb.deleteCollection(selected)}
          onDeleteDocument={kb.deleteDocument}
          onRevoke={() => kb.revokeConsent(selected.providerId)}
        />
      ) : kb.loaded ? (
        <PageEmpty
          title={t('shell.documentsPage.emptyTitle')}
          body={t('shell.documentsPage.emptyBody')}
          action={
            <button className="btn primary" type="button" disabled={busy} onClick={kb.createCollection}>
              {t('shell.documentsPage.createFirst')}
            </button>
          }
        />
      ) : null}
      {kb.dialogs}
    </PageFrame>
  );
}

/** Files dropped onto the window, waiting for the user to pick a collection. */
function DropBanner({
  pendingPaths,
  collections,
  target,
  busy,
  onTarget,
  onAdd,
  onCancel,
}: {
  pendingPaths: string[];
  collections: KnowledgeCollection[];
  target: KnowledgeCollection | null;
  busy: boolean;
  onTarget: (id: string) => void;
  onAdd: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className="kb-drop-banner" role="region" aria-label={t('settings.knowledge.drop.ariaLabel')}>
      <p>{t('settings.knowledge.drop.intro', { count: pendingPaths.length })}</p>
      <ul>
        {pendingPaths.map((path) => (
          <li key={path}>{fileName(path)}</li>
        ))}
      </ul>
      {collections.length === 0 || !target ? (
        <p className="kb-drop-hint">{t('settings.knowledge.drop.needCollection')}</p>
      ) : null}
      <div className="kb-drop-actions">
        {collections.length > 0 && target ? (
          <>
            <label>
              {t('settings.knowledge.drop.target')}{' '}
              <select value={target.id} onChange={(e) => onTarget(e.target.value)}>
                {collections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn primary" type="button" disabled={busy} onClick={onAdd}>
              {t('settings.knowledge.drop.add')}
            </button>
          </>
        ) : null}
        <button className="btn ghost" type="button" onClick={onCancel}>
          {t('common.actions.cancel')}
        </button>
      </div>
    </div>
  );
}

function CollectionDetail({
  collection,
  documents,
  consented,
  importing,
  busy,
  onImport,
  onRename,
  onDelete,
  onDeleteDocument,
  onRevoke,
}: {
  collection: KnowledgeCollection;
  documents: KnowledgeDocument[];
  consented: boolean;
  importing: KnowledgeImporting | null;
  busy: boolean;
  onImport: () => void;
  onRename: () => void;
  onDelete: () => void;
  onDeleteDocument: (doc: KnowledgeDocument) => void;
  onRevoke: () => void;
}) {
  const t = useT();
  const fmt = useFormatters();
  return (
    <div className="docs-detail">
      <div className="docs-detail-head">
        <h3 className="docs-detail-title">{collection.name}</h3>
        <div className="docs-detail-actions">
          <button className="btn primary" type="button" disabled={busy} onClick={onImport}>
            {t('settings.knowledge.actions.importDocument')}
          </button>
          <button className="btn ghost" type="button" disabled={busy} onClick={onRename}>
            {t('common.actions.rename')}
          </button>
          <button className="btn ghost" type="button" disabled={busy} onClick={onDelete}>
            {t('common.actions.delete')}
          </button>
        </div>
      </div>
      <p className="docs-detail-meta">
        {t('settings.knowledge.collection.providerInfo', {
          provider: collection.providerId,
          model: collection.embeddingModel,
        })}
      </p>

      <section className="grp" aria-label={t('settings.knowledge.documents.heading', { name: collection.name })}>
        <div className="grp-label">{t('shell.documentsSheet.heading')}</div>
        {documents.length === 0 && !importing ? (
          <p className="docs-empty">{t('settings.knowledge.documents.empty')}</p>
        ) : (
          <ul className="docs-rows">
            {importing ? (
              <li className="docs-row">
                <div className="docs-row-main">
                  <span className="docs-row-title" title={importing.path}>{fileName(importing.path)}</span>
                  <ImportProgressBar progress={importing.progress} />
                </div>
              </li>
            ) : null}
            {documents.map((doc) => (
              <li key={doc.id} className="docs-row">
                <div className="docs-row-main">
                  <span className="docs-row-title" title={doc.source}>{doc.title}</span>
                  <span className="docs-row-meta">
                    {t('shell.documentsPage.documentMeta', {
                      size: fmt.size(doc.byteSize),
                      type: typeLabel(doc),
                      date: fmt.timeAgo(doc.importedAt),
                    })}
                  </span>
                </div>
                <span className="docs-row-state">
                  {t('shell.documentsPage.documentIndexed', { count: doc.chunkCount })}
                </span>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={busy}
                  aria-label={t('shell.documentsPage.removeDocument', { title: doc.title })}
                  onClick={() => onDeleteDocument(doc)}
                >
                  {t('common.actions.remove')}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="docs-drop-hint">{t('shell.documentsPage.dropHint')}</p>
      </section>

      <p className="docs-consent">
        {consented
          ? t('shell.documentsPage.consentGiven', { provider: collection.providerId })
          : t('shell.documentsPage.consentPending', { provider: collection.providerId })}
        {consented ? (
          <button
            className="btn ghost"
            type="button"
            disabled={busy}
            aria-label={t('shell.documentsPage.revokeProvider', { provider: collection.providerId })}
            onClick={onRevoke}
          >
            {t('settings.knowledge.consentList.revoke')}
          </button>
        ) : null}
      </p>
    </div>
  );
}
