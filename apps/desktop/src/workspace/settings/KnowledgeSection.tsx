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
import { providerDisplayName } from '../../lib/providerIdentity';

/**
 * The knowledge base's behaviour (t1-6), without its layout.
 *
 * This used to be `KnowledgeSection`, one component that both ran the flows
 * and drew them as a stack of cards. The Documents page now draws them as a
 * list of collections beside the selected one's documents, so the flows —
 * CRUD, the one-time PDF notice, per-provider embedding consent, batch import
 * of dropped files with progress, revoking consent — live here, and
 * `DocumentsPage` only arranges them.
 *
 * `local_only` is enforced by the backend (`commands/knowledge.rs`): creating
 * or embedding into a collection whose provider is not local is refused with
 * an error naming the provider, which reaches the user through `onStatus`.
 */
export interface KnowledgeBaseOptions {
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
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** Progress for a running import.
 *
 *  Determinate once the chunk count is known, indeterminate while the file is
 *  still being read — a bar that sits at 0% for five seconds and then jumps is
 *  worse than one that admits it doesn't know yet. `aria-busy` plus a live
 *  region means a screen reader hears the phase change without the percentage
 *  being announced on every batch.
 */
export function ImportProgressBar({ progress }: { progress: KnowledgeImportProgress }) {
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

/** A running import: which collection, which file, how far. */
export interface KnowledgeImporting {
  collectionId: string;
  path: string;
  progress: KnowledgeImportProgress;
}

export function useKnowledgeBase({
  settings,
  onUpdate,
  onStatus,
  pendingPaths = [],
  onPendingPathsHandled,
}: KnowledgeBaseOptions) {
  const t = useT();
  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [loaded, setLoaded] = useState(false);
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
  // looks broken. Keyed by collection, not by the selection: a dropped batch
  // can be running while the user looks at another collection.
  const [importing, setImporting] = useState<KnowledgeImporting | null>(null);

  // The first collection is selected by default, and again when the selected
  // one is deleted.
  const selected = collections.find((c) => c.id === selectedId) ?? collections[0] ?? null;
  const selectedKey = selected?.id ?? null;
  const selectedKeyRef = useRef<string | null>(null);
  selectedKeyRef.current = selectedKey;

  // Which collection `documents` belongs to, so a selection change fetches
  // once rather than again after `refresh` already did.
  const documentsKeyRef = useRef<string | null | undefined>(undefined);

  const loadDocuments = useCallback(
    async (collectionId: string | null) => {
      documentsKeyRef.current = collectionId;
      if (!collectionId) {
        setDocuments([]);
        return;
      }
      try {
        const docs = await listKnowledgeDocuments(collectionId);
        // A slow answer for a collection the user has since left is dropped.
        if (selectedKeyRef.current === collectionId) setDocuments(docs);
      } catch (e) {
        onStatus(t('settings.knowledge.status.loadDocumentsFailed', { error: String(e) }));
      }
    },
    [onStatus, t],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await listKnowledgeCollections();
      setCollections(next);
      const current = next.find((c) => c.id === selectedKeyRef.current) ?? next[0] ?? null;
      selectedKeyRef.current = current?.id ?? null;
      await loadDocuments(current?.id ?? null);
    } catch (e) {
      onStatus(t('settings.knowledge.status.loadFailed', { error: String(e) }));
    } finally {
      setLoaded(true);
    }
  }, [loadDocuments, onStatus, t]);

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!loaded || documentsKeyRef.current === selectedKey) return;
    setDocuments([]);
    void loadDocuments(selectedKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

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

  function createCollection() {
    const name = prompt(t('settings.knowledge.prompt.createName'))?.trim();
    if (!name) return;
    void run(t('settings.knowledge.status.created', { name }), async () => {
      const created = await createKnowledgeCollection(name);
      setSelectedId(created.id);
      selectedKeyRef.current = created.id;
      return created;
    });
  }

  function renameCollection(collection: KnowledgeCollection) {
    const name = prompt(t('settings.knowledge.prompt.renameName'), collection.name)?.trim();
    if (!name || name === collection.name) return;
    void run(t('settings.knowledge.status.renamed', { name }), async () => {
      await renameKnowledgeCollection(collection.id, name);
      return true;
    });
  }

  function deleteCollection(collection: KnowledgeCollection) {
    if (!confirm(t('settings.knowledge.confirm.deleteCollection', { name: collection.name }))) return;
    void run(t('settings.knowledge.status.deletedCollection', { name: collection.name }), async () => {
      await deleteKnowledgeCollection(collection.id);
      if (selectedKeyRef.current === collection.id) {
        setSelectedId(null);
        selectedKeyRef.current = null;
      }
      return true;
    });
  }

  function deleteDocument(doc: KnowledgeDocument) {
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
    setImporting({ collectionId, path, progress: { phase: 'reading', chunksDone: 0, chunksTotal: 0 } });
    try {
      const outcome = await importKnowledgeDocument(collectionId, path, (progress) =>
        setImporting({ collectionId, path, progress }),
      );
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
      setImporting(null);
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

  async function importDocument(collection: KnowledgeCollection) {
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

  /** The dropped files' target: the one picked in the banner, else the
   *  collection being looked at. */
  const dropTarget = collections.find((c) => c.id === dropTargetId) ?? selected;

  async function addDropped() {
    const target = dropTarget;
    if (!target) return;
    const paths = pendingPaths;
    onPendingPathsHandled?.();
    setSelectedId(target.id);
    await importPaths(target, paths);
  }

  /** Withdraw consent for one provider. The list is a full replace, so sending
   *  it without this provider is the whole operation. */
  function revokeConsent(providerId: string) {
    if (!confirm(t('settings.knowledge.consentList.revokeConfirm', { provider: providerDisplayName(providerId) }))) return;
    void persist({
      embeddingConsentProviders: settingsRef.current.embeddingConsentProviders.filter(
        (p) => p !== providerId,
      ),
    }).then((next) => {
      if (next) onStatus(t('settings.knowledge.consentList.revoked', { provider: providerDisplayName(providerId) }));
    });
  }

  /** The one-time dialogs the import flow awaits. Render once, anywhere. */
  const dialogs = (
    <>
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
    </>
  );

  return {
    collections,
    loaded,
    documents,
    selected,
    select: setSelectedId,
    busy,
    importing,
    dropTarget,
    setDropTargetId,
    createCollection,
    renameCollection,
    deleteCollection,
    deleteDocument,
    importDocument,
    addDropped,
    revokeConsent,
    dialogs,
  };
}
