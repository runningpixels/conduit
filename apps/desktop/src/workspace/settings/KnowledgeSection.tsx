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
  /** Files dropped onto the window, waiting for the user to pick a collection.
   *  Absolute paths from Tauri's native drop event. */
  pendingPaths?: string[];
  /** Called once the dropped files have been added or dismissed. */
  onPendingPathsHandled?: () => void;
}

/** Extension check only -- the real format dispatch happens in Rust. This
 *  decides whether to raise the one-time notice, nothing more. */
function isPdf(path: string): boolean {
  return path.toLowerCase().endsWith('.pdf');
}

/** The file name from an absolute path, on either separator. */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
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
export function KnowledgeSection({
  settings,
  onUpdate,
  onStatus,
  pendingPaths = [],
  onPendingPathsHandled,
}: KnowledgeSectionProps) {
  const t = useT();
  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Each one-time dialog is awaited rather than threaded through state: the
  // resolver is parked here while the dialog is up. That keeps the import a
  // single linear function, which a batch of dropped files needs.
  const [pdfNoticeResolve, setPdfNoticeResolve] = useState<((ok: boolean) => void) | null>(null);
  const [consentRequest, setConsentRequest] = useState<{
    providerId: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  // The latest persisted settings. The `settings` prop lags a render behind an
  // `updateSettings` call, and a batch import reads consent between awaits.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [dropTargetId, setDropTargetId] = useState<string>('');
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

  function askPdfNotice(): Promise<boolean> {
    return new Promise((resolve) => setPdfNoticeResolve(() => resolve));
  }

  function askConsent(providerId: string): Promise<boolean> {
    return new Promise((resolve) => setConsentRequest({ providerId, resolve }));
  }

  function persist(patch: Parameters<typeof updateSettings>[0]): Promise<AppSettings | null> {
    return updateSettings(patch)
      .then((next) => {
        settingsRef.current = next;
        onUpdate(next);
        return next;
      })
      .catch((e: unknown) => {
        onStatus(t('settings.knowledge.status.consentFailed', { error: String(e) }));
        return null;
      });
  }

  /** Import one or more files into a collection: the one-time PDF notice if
   *  any file is a PDF, embedding consent if this provider hasn't been agreed
   *  to, then each file in turn with progress.
   *
   *  The PDF notice comes first because it is about what happens *locally*
   *  (extraction quality), while consent is about what leaves the machine.
   *  Both are asked once for the whole batch, not per file. */
  async function importPaths(collection: KnowledgeCollection, paths: string[]) {
    if (paths.length === 0) return;
    let current = settingsRef.current;

    if (paths.some(isPdf) && !current.pdfImportNoticeAcknowledged) {
      if (!(await askPdfNotice())) {
        onStatus(t('settings.knowledge.status.declinedImport'));
        return;
      }
      const next = await persist({ pdfImportNoticeAcknowledged: true });
      if (!next) return;
      current = next;
    }

    if (!current.embeddingConsentProviders.includes(collection.providerId)) {
      if (!(await askConsent(collection.providerId))) {
        onStatus(t('settings.knowledge.status.declinedImport'));
        return;
      }
      const next = await persist({
        embeddingConsentProviders: [...current.embeddingConsentProviders, collection.providerId],
      });
      if (!next) return;
    }

    for (const path of paths) {
      await proceedImport(collection.id, path);
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
    await importPaths(collection, [path]);
  }

  async function handleAddDropped() {
    const target = collections.find((c) => c.id === dropTargetId) ?? collections[0];
    if (!target) return;
    const paths = pendingPaths;
    onPendingPathsHandled?.();
    setSelectedId(target.id);
    await importPaths(target, paths);
  }

  /** Withdraw consent for one provider. The list is a full replace, so sending
   *  it without this provider is the whole operation. */
  function handleRevokeConsent(providerId: string) {
    if (!confirm(t('settings.knowledge.consentList.revokeConfirm', { provider: providerId }))) return;
    void persist({
      embeddingConsentProviders: settingsRef.current.embeddingConsentProviders.filter(
        (p) => p !== providerId,
      ),
    }).then((next) => {
      if (next) onStatus(t('settings.knowledge.consentList.revoked', { provider: providerId }));
    });
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
      {pendingPaths.length > 0 && (
        <div className="kb-drop-banner" role="region" aria-label={t('settings.knowledge.drop.ariaLabel')}>
          <p>
            {t('settings.knowledge.drop.intro', { count: pendingPaths.length })}
          </p>
          <ul>
            {pendingPaths.map((path) => (
              <li key={path}>{fileName(path)}</li>
            ))}
          </ul>
          {collections.length === 0 ? (
            <p className="kb-drop-hint">{t('settings.knowledge.drop.needCollection')}</p>
          ) : (
            <div className="kb-drop-actions">
              <label>
                {t('settings.knowledge.drop.target')}{' '}
                <select
                  value={dropTargetId || collections[0].id}
                  onChange={(e) => setDropTargetId(e.target.value)}
                >
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn primary"
                type="button"
                disabled={busy}
                onClick={() => void handleAddDropped()}
              >
                {t('settings.knowledge.drop.add')}
              </button>
            </div>
          )}
          <button className="btn ghost" type="button" onClick={() => onPendingPathsHandled?.()}>
            {t('common.actions.cancel')}
          </button>
        </div>
      )}

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

      {settings.embeddingConsentProviders.length > 0 && (
        <section className="kb-consent-list" aria-labelledby="kb-consent-heading">
          <h3 id="kb-consent-heading" className="sheet-h" style={{ fontSize: 'var(--fs-5xl)' }}>
            {t('settings.knowledge.consentList.heading')}
          </h3>
          <p className="sheet-sub">{t('settings.knowledge.consentList.intro')}</p>
          <ul className="skill-list">
            {settings.embeddingConsentProviders.map((providerId) => (
              <li key={providerId} className="skill-row">
                <div className="skill-row-main">
                  <b>{providerId}</b>
                </div>
                <div className="skill-row-actions">
                  <button
                    className="btn ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => handleRevokeConsent(providerId)}
                  >
                    {t('settings.knowledge.consentList.revoke')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PdfImportNoticeDialog
        visible={pdfNoticeResolve != null}
        onContinue={() => {
          const resolve = pdfNoticeResolve;
          setPdfNoticeResolve(null);
          resolve?.(true);
        }}
        onCancel={() => {
          const resolve = pdfNoticeResolve;
          setPdfNoticeResolve(null);
          resolve?.(false);
        }}
      />

      <EmbeddingConsentDialog
        visible={consentRequest != null}
        providerId={consentRequest?.providerId ?? null}
        onAllow={() => {
          const request = consentRequest;
          setConsentRequest(null);
          request?.resolve(true);
        }}
        onDeny={() => {
          const request = consentRequest;
          setConsentRequest(null);
          request?.resolve(false);
        }}
      />
    </div>
  );
}
