import { useState } from 'react';
import type { KnowledgeCollection, KnowledgeDocument } from '../ipc/contracts';
import { listKnowledgeDocuments } from '../ipc/client';
import { ChevronDown, ChevronRight } from '../icons';
import { useT } from '../i18n';

interface ComposerCollectionsProps {
  open: boolean;
  streaming: boolean;
  collections: KnowledgeCollection[];
  enabledIds: string[];
  onClose: () => void;
  onToggle: (collectionId: string, enabled: boolean) => void;
  /** M2 (t1-8, D1/D2): documents this chat leaves out, and the toggle that
   *  flips one. Absent hides the expand affordance entirely. */
  excludedDocumentIds?: string[];
  onToggleDocument?: (documentId: string, excluded: boolean) => void;
  onOpenSettings?: () => void;
  onRefresh?: () => void;
}

type DocsState = 'loading' | 'error' | KnowledgeDocument[];

/** Per-conversation knowledge base collection attachment popover (t1-6),
 *  extended for t1-8 M2: an attached row expands into its documents, each
 *  with a checkbox (checked = included in this chat's retrieval). */
export function ComposerCollections({
  open,
  streaming,
  collections,
  enabledIds,
  onClose,
  onToggle,
  excludedDocumentIds = [],
  onToggleDocument,
  onOpenSettings,
  onRefresh,
}: ComposerCollectionsProps) {
  const t = useT();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [docsByCollection, setDocsByCollection] = useState<Record<string, DocsState>>({});

  if (!open) return null;

  const enabled = new Set(enabledIds);
  const excluded = new Set(excludedDocumentIds);

  function toggleExpand(collectionId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(collectionId)) next.delete(collectionId);
      else next.add(collectionId);
      return next;
    });
    if (!(collectionId in docsByCollection)) {
      setDocsByCollection((current) => ({ ...current, [collectionId]: 'loading' }));
      listKnowledgeDocuments(collectionId)
        .then((docs) => setDocsByCollection((current) => ({ ...current, [collectionId]: docs })))
        .catch(() => setDocsByCollection((current) => ({ ...current, [collectionId]: 'error' })));
    }
  }

  return (
    <div
      id="composer-collections"
      role="dialog"
      aria-label={t('chat.knowledge.ariaLabel')}
      className="chat-settings-pop"
    >
      <p className="chat-settings-pop-lead">{t('chat.knowledge.intro')}</p>
      {collections.length === 0 ? (
        <p className="chat-settings-pop-lead">{t('chat.knowledge.noneDiscovered')}</p>
      ) : (
        <ul className="composer-skill-list composer-collection-list">
          {collections.map((collection) => {
            const on = enabled.has(collection.id);
            const isExpanded = expanded.has(collection.id);
            const docsState = docsByCollection[collection.id];
            const docs = Array.isArray(docsState) ? docsState : null;
            const includedCount = docs
              ? docs.filter((doc) => !excluded.has(doc.id)).length
              : null;
            const showIncludedCount = docs != null && includedCount !== docs.length;
            return (
              <li key={collection.id}>
                <div className="composer-collection-row">
                  <button
                    className="toggle"
                    type="button"
                    role="switch"
                    aria-pressed={on}
                    aria-label={t('chat.knowledge.toggleAriaLabel', {
                      action: on ? 'disable' : 'enable',
                      name: collection.name,
                    })}
                    disabled={streaming}
                    onClick={() => onToggle(collection.id, !on)}
                  />
                  <span>
                    <b>{collection.name}</b>
                    <small>
                      {showIncludedCount
                        ? t('chat.knowledge.documentsIncludedCount', {
                            included: includedCount,
                            total: docs!.length,
                          })
                        : t('chat.knowledge.documentCount', { count: collection.documentCount })}
                    </small>
                  </span>
                  {on && onToggleDocument ? (
                    <button
                      type="button"
                      className="composer-collection-expand"
                      aria-expanded={isExpanded}
                      aria-controls={`composer-collection-docs-${collection.id}`}
                      aria-label={t('chat.knowledge.expandAriaLabel', {
                        action: isExpanded ? 'hide' : 'show',
                        name: collection.name,
                      })}
                      onClick={() => toggleExpand(collection.id)}
                    >
                      {isExpanded ? <ChevronDown /> : <ChevronRight />}
                    </button>
                  ) : null}
                </div>
                {on && onToggleDocument && isExpanded ? (
                  <ul id={`composer-collection-docs-${collection.id}`} className="composer-doc-list">
                    {docsState === 'loading' ? (
                      <li className="composer-doc-list-note">{t('chat.knowledge.documentsLoading')}</li>
                    ) : docsState === 'error' ? (
                      <li className="composer-doc-list-note">{t('chat.knowledge.documentsLoadFailed')}</li>
                    ) : (
                      (docs ?? []).map((doc) => {
                        const included = !excluded.has(doc.id);
                        return (
                          <li key={doc.id}>
                            <label>
                              <input
                                type="checkbox"
                                checked={included}
                                disabled={streaming}
                                onChange={() => onToggleDocument(doc.id, included)}
                              />
                              {doc.title}
                            </label>
                          </li>
                        );
                      })
                    )}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <div className="chat-settings-pop-actions">
        <button className="btn ghost" type="button" onClick={onClose}>
          {t('common.actions.close')}
        </button>
        {onRefresh ? (
          <button className="btn ghost" type="button" onClick={onRefresh}>
            {t('chat.knowledge.refresh')}
          </button>
        ) : null}
        {onOpenSettings ? (
          <button
            className="btn ghost"
            type="button"
            onClick={() => {
              onClose();
              onOpenSettings();
            }}
          >
            {t('chat.knowledge.manageInSettings')}
          </button>
        ) : null}
      </div>
    </div>
  );
}
