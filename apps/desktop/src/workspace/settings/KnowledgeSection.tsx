import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings } from '../../ipc/contracts';
import type {
  KnowledgeCollection,
  KnowledgeDocument,
  KnowledgeImportProgress,
} from '../../ipc/contracts';
import {
  createKnowledgeCollection,
  deleteKnowledgeCollection,
  deleteKnowledgeDocument,
  importKnowledgeDocument,
  listKnowledgeCollections,
  listKnowledgeDocuments,
  pickKnowledgeDocument,
  renameKnowledgeCollection,
  updateSettings,
} from '../../ipc/client';
import { EmbeddingConsentDialog } from './EmbeddingConsentDialog';
import { PdfImportNoticeDialog } from './PdfImportNoticeDialog';
import { useT } from '../../i18n';

interface KnowledgeSectionProps {
  settings: AppSettings;
  onUpdate: (next: AppSettings) => void;
  onStatus: (message: string) => void;
}

interface PendingImport {
  collectionId: string;
  path: string;
  providerId: string;
}

/** Extension check only -- the real format dispatch happens in Rust. This
 *  decides whether to raise the one-time notice, nothing more. */
function isPdf(path: string): boolean {
  return path.toLowerCase().endsWith('.pdf');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}


/** Progress for a running import.
 *
 *  Determinate once the chunk count is known, indeterminate while the file is
 *  still being read — a bar that sits at 0% for five seconds and then jumps is
 *  worse than one that admits it doesn't know yet. `aria-busy` plus a live
 *  region means a screen reader hears the phase change without the percentage
 *  being announced on every batch.
 */
function ImportProgressBar({ progress }: { progress: KnowledgeImportProgress }) {
  const t = useT();
  const determinate = progress.phase === 'embedding' && progress.chunksTotal > 0;
  const percent = determinate
    ? Math.round((progress.chunksDone / progress.chunksTotal) * 100)
    : 0;
  return (
    <div className="kb-import-progress" role="status" aria-live="polite" aria-busy="true">
      <div
        className="kb-import-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        {...(determinate ? { 'aria-valuenow': percent } : {})}
      >
        <div
          className={`kb-import-progress-fill${determinate ? '' : ' indeterminate'}`}
          style={determinate ? { width: `${percent}%` } : undefined}
        />
      </div>
      <small>
        {determinate
          ? t('settings.knowledge.progress.embedding', {
              done: progress.chunksDone,
              total: progress.chunksTotal,
            })
          : t('settings.knowledge.progress.reading')}
      </small>
    </div>
  );
}

/** Knowledge base collections + documents CRUD (t1-6). */
export function KnowledgeSection({ settings, onUpdate, onStatus }: KnowledgeSectionProps) {
  const t = useT();
  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(null);
  const [pendingPdfNotice, setPendingPdfNotice] = useState<PendingImport | null>(null);
  // Non-null only while an import is running. Embedding a long document takes
  // tens of seconds against the provider, and a button that just sits there
  // looks broken.
  const [progress, setProgress] = useState<KnowledgeImportProgress | null>(null);
  // Which collection the running import belongs to. Deliberately not
  // `selectedId`: "Import document" acts on its own row without selecting it,
  // so keying the bar off the selection hid it for every unselected row.
  const [importingId, setImportingId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const refresh = useCallback(async () => {
    try {
      setCollections(await listKnowledgeCollections());
    } catch (e) {
      onStatus(t('settings.knowledge.status.loadFailed', { error: String(e) }));
    }
    const sel = selectedIdRef.current;
    if (sel) {
      try {
        setDocuments(await listKnowledgeDocuments(sel));
      } catch (e) {
        onStatus(t('settings.knowledge.status.loadDocumentsFailed', { error: String(e) }));
      }
    } else {
      setDocuments([]);
    }
  }, [onStatus, t]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  async function run(label: string, action: () => Promise<unknown>) {
    setBusy(true);
    try {
      const result = await action();
      if (result !== null && result !== undefined) {
        onStatus(label);
      }
      await refresh();
    } catch (e) {
      onStatus(t('settings.knowledge.status.actionFailed', { label, error: String(e) }));
    } finally {
      setBusy(false);
    }
  }

  function handleCreateCollection() {
    const name = prompt(t('settings.knowledge.prompt.createName'))?.trim();
    if (!name) return;
    void run(t('settings.knowledge.status.created', { name }), async () => {
      const created = await createKnowledgeCollection(name);
      setSelectedId(created.id);
      return created;
    });
  }

  function handleRenameCollection(collection: KnowledgeCollection) {
    const name = prompt(t('settings.knowledge.prompt.renameName'), collection.name)?.trim();
    if (!name || name === collection.name) return;
    void run(t('settings.knowledge.status.renamed', { name }), async () => {
      await renameKnowledgeCollection(collection.id, name);
      return true;
    });
  }

  function handleDeleteCollection(collection: KnowledgeCollection) {
    if (!confirm(t('settings.knowledge.confirm.deleteCollection', { name: collection.name }))) return;
    void run(t('settings.knowledge.status.deletedCollection', { name: collection.name }), async () => {
      await deleteKnowledgeCollection(collection.id);
      if (selectedIdRef.current === collection.id) setSelectedId(null);
      return true;
    });
  }

  function handleDeleteDocument(doc: KnowledgeDocument) {
    if (!confirm(t('settings.knowledge.confirm.deleteDocument', { title: doc.title }))) return;
    void run(t('settings.knowledge.status.deletedDocument', { title: doc.title }), async () => {
      await deleteKnowledgeDocument(doc.id);
      return true;
    });
  }

  /** Runs the actual import call, shared by the direct path and the
   *  consent-then-import path. Not routed through `run()`: the status
   *  message depends on the outcome (imported vs. duplicate), which `run()`'s
   *  static label can't express. */
  async function proceedImport(collectionId: string, path: string) {
    setBusy(true);
    setImportingId(collectionId);
    setProgress({ phase: 'reading', chunksDone: 0, chunksTotal: 0 });
    try {
      const outcome = await importKnowledgeDocument(collectionId, path, setProgress);
      onStatus(
        outcome.status === 'duplicate'
          ? t('settings.knowledge.status.duplicate', { title: outcome.title })
          : t('settings.knowledge.status.imported', {
              title: outcome.title,
              count: outcome.chunkCount,
            }),
      );
      await refresh();
    } catch (e) {
      onStatus(t('settings.knowledge.status.importFailed', { error: String(e) }));
    } finally {
      setProgress(null);
      setImportingId(null);
      setBusy(false);
    }
  }

  async function handleImport(collection: KnowledgeCollection) {
    let path: string | null;
    try {
      path = await pickKnowledgeDocument();
    } catch (e) {
      onStatus(t('settings.knowledge.status.pickFailed', { error: String(e) }));
      return;
    }
    if (!path) return; // cancelled
    // The PDF notice comes first because it is about what happens *locally*
    // (extraction quality), while embedding consent is about what leaves the
    // machine. Both are one-time, so a first PDF on a fresh install shows two
    // dialogs once and never again.
    if (isPdf(path) && !settings.pdfImportNoticeAcknowledged) {
      setPendingPdfNotice({
        collectionId: collection.id,
        path,
        providerId: collection.providerId,
      });
      return;
    }
    await continueImportAfterPdfNotice({
      collectionId: collection.id,
      path,
      providerId: collection.providerId,
    });
  }

  /** The rest of the import once the PDF notice is out of the way: embedding
   *  consent if this provider hasn't been agreed to, otherwise straight in. */
  async function continueImportAfterPdfNotice(pending: PendingImport) {
    if (!settings.embeddingConsentProviders.includes(pending.providerId)) {
      setPendingImport(pending);
      return;
    }
    await proceedImport(pending.collectionId, pending.path);
  }

  function handlePdfNoticeContinue() {
    const pending = pendingPdfNotice;
    if (!pending) return;
    setPendingPdfNotice(null);
    void (async () => {
      let persisted: AppSettings;
      try {
        persisted = await updateSettings({ pdfImportNoticeAcknowledged: true });
        onUpdate(persisted);
      } catch (e) {
        onStatus(t('settings.knowledge.status.consentFailed', { error: String(e) }));
        return;
      }
      // Read the consent list off the freshly persisted settings rather than
      // the `settings` prop, which is still the pre-update render's value.
      if (!persisted.embeddingConsentProviders.includes(pending.providerId)) {
        setPendingImport(pending);
        return;
      }
      await proceedImport(pending.collectionId, pending.path);
    })();
  }

  function handlePdfNoticeCancel() {
    setPendingPdfNotice(null);
    onStatus(t('settings.knowledge.status.declinedImport'));
  }

  function handleConsentAllow() {
    const pending = pendingImport;
    if (!pending) return;
    setPendingImport(null);
    void (async () => {
      try {
        const persisted = await updateSettings({
          embeddingConsentProviders: [
            ...settings.embeddingConsentProviders,
            pending.providerId,
          ],
        });
        onUpdate(persisted);
      } catch (e) {
        onStatus(t('settings.knowledge.status.consentFailed', { error: String(e) }));
        return;
      }
      await proceedImport(pending.collectionId, pending.path);
    })();
  }

  function handleConsentDeny() {
    setPendingImport(null);
    onStatus(t('settings.knowledge.status.declinedImport'));
  }

  const selected = collections.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="settings-section">
      <p className="sheet-sub" style={{ marginTop: 0 }}>
        {t('settings.knowledge.intro')}
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <button
          className="btn primary"
          type="button"
          disabled={busy}
          onClick={handleCreateCollection}
        >
          {t('settings.knowledge.actions.createCollection')}
        </button>
      </div>
      {collections.length === 0 ? (
        <p style={{ fontSize: 'var(--fs-xl)', color: 'var(--ink-3)' }}>
          {t('settings.knowledge.empty.hint')}
        </p>
      ) : (
        <ul className="skill-list">
          {collections.map((collection) => (
            <li key={collection.id} className="skill-row">
              <div className="skill-row-main">
                <div className="skill-row-title">
                  <button
                    type="button"
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: 0,
                      font: 'inherit',
                      color: 'inherit',
                      cursor: 'pointer',
                      textDecoration: selectedId === collection.id ? 'underline' : 'none',
                    }}
                    aria-pressed={selectedId === collection.id}
                    onClick={() =>
                      setSelectedId(selectedId === collection.id ? null : collection.id)
                    }
                  >
                    <b>{collection.name}</b>
                  </button>
                  <span className="skill-source">
                    {t('settings.knowledge.collection.docCount', {
                      count: collection.documentCount,
                    })}
                  </span>
                </div>
                <small>
                  {t('settings.knowledge.collection.providerInfo', {
                    provider: collection.providerId,
                    model: collection.embeddingModel,
                  })}
                </small>
                {progress && importingId === collection.id ? (
                  <ImportProgressBar progress={progress} />
                ) : null}
              </div>
              <div className="skill-row-actions">
                <button
                  className="btn ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => void handleImport(collection)}
                >
                  {t('settings.knowledge.actions.importDocument')}
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => handleRenameCollection(collection)}
                >
                  {t('common.actions.rename')}
                </button>
                <button
                  className="btn ghost"
                  type="button"
                  disabled={busy}
                  onClick={() => handleDeleteCollection(collection)}
                >
                  {t('common.actions.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <div style={{ marginTop: 20 }}>
          <h3 className="sheet-h" style={{ fontSize: 'var(--fs-5xl)' }}>
            {t('settings.knowledge.documents.heading', { name: selected.name })}
          </h3>
          {documents.length === 0 ? (
            <p style={{ fontSize: 'var(--fs-xl)', color: 'var(--ink-3)' }}>
              {t('settings.knowledge.documents.empty')}
            </p>
          ) : (
            <ul className="skill-list">
              {documents.map((doc) => (
                <li key={doc.id} className="skill-row">
                  <div className="skill-row-main">
                    <div className="skill-row-title">
                      <b>{doc.title}</b>
                    </div>
                    <small>
                      {t('settings.knowledge.documents.meta', {
                        size: formatBytes(doc.byteSize),
                        chunks: doc.chunkCount,
                      })}
                    </small>
                  </div>
                  <div className="skill-row-actions">
                    <button
                      className="btn ghost"
                      type="button"
                      disabled={busy}
                      onClick={() => handleDeleteDocument(doc)}
                    >
                      {t('common.actions.delete')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <PdfImportNoticeDialog
        visible={pendingPdfNotice != null}
        onContinue={handlePdfNoticeContinue}
        onCancel={handlePdfNoticeCancel}
      />

      <EmbeddingConsentDialog
        visible={pendingImport != null}
        providerId={pendingImport?.providerId ?? null}
        onAllow={handleConsentAllow}
        onDeny={handleConsentDeny}
      />
    </div>
  );
}
