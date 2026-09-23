import { useEffect, useRef, useState } from 'react';
import type { KnowledgeCitation, KnowledgePassage } from '../ipc/contracts';
import { getKnowledgePassage } from '../ipc/client';
import { useT } from '../i18n';

interface KnowledgeCitationsProps {
  citations: KnowledgeCitation[];
}

interface DocumentGroup {
  documentId: string;
  title: string;
  /** Citations for this document, in retrieval rank order. */
  cited: KnowledgeCitation[];
}

/** 1-based section numbers as a short list: "3", "1, 3", "1, 3, 7 +2". */
function sectionList(cited: KnowledgeCitation[]): string {
  const numbers = [...new Set(cited.map((c) => c.ordinal + 1))].sort((a, b) => a - b);
  const shown = numbers.slice(0, 3).join(', ');
  return numbers.length > 3 ? `${shown} +${numbers.length - 3}` : shown;
}

/**
 * Documents this turn's retrieval drew on, shown on the user bubble that
 * triggered it — and **where** in each document (t1-8).
 *
 * t1-6 acceptance criterion 1 asks for the document name *and location* in
 * the thread. The first version showed only a name and an excerpt count,
 * throwing away the chunk positions it was handed. Each chip now names the
 * sections it drew on and opens the passage itself.
 *
 * The passage opens in its own small viewer rather than the document panel.
 * The panel is built around saved artifacts — its tab strip only lists them,
 * and Save, Export and Delete all call the backend by artifact id — so a
 * passage dressed up as an artifact would break every one of those actions.
 */
export function KnowledgeCitations({ citations }: KnowledgeCitationsProps) {
  const t = useT();
  const [open, setOpen] = useState<{ group: DocumentGroup; chunkId: string } | null>(null);

  if (citations.length === 0) return null;

  const groups = new Map<string, DocumentGroup>();
  for (const c of citations) {
    const group = groups.get(c.documentId);
    if (group) group.cited.push(c);
    else groups.set(c.documentId, { documentId: c.documentId, title: c.documentTitle, cited: [c] });
  }

  return (
    <>
      <div className="turn-citations" aria-label={t('chat.knowledge.citations.ariaLabel')}>
        {[...groups.values()].map((group) => (
          <button
            key={group.documentId}
            type="button"
            className="turn-citation-chip"
            title={t('chat.knowledge.citations.open', { title: group.title })}
            onClick={() => setOpen({ group, chunkId: group.cited[0].chunkId })}
          >
            {t('chat.knowledge.citations.chipSections', {
              title: group.title,
              count: new Set(group.cited.map((c) => c.ordinal)).size,
              sections: sectionList(group.cited),
            })}
          </button>
        ))}
      </div>
      {open && (
        <PassageViewer
          group={open.group}
          chunkId={open.chunkId}
          onSelect={(chunkId) => setOpen({ group: open.group, chunkId })}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

function PassageViewer({
  group,
  chunkId,
  onSelect,
  onClose,
}: {
  group: DocumentGroup;
  chunkId: string;
  onSelect: (chunkId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);
  // undefined while loading; null when the document has since been deleted.
  const [passage, setPassage] = useState<KnowledgePassage | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setPassage(undefined);
    setFailed(false);
    getKnowledgePassage(chunkId)
      .then((p) => {
        if (!cancelled) setPassage(p);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [chunkId]);

  useEffect(() => {
    closeRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const sections = [...new Map(group.cited.map((c) => [c.ordinal, c])).values()].sort(
    (a, b) => a.ordinal - b.ordinal,
  );

  return (
    <div
      className="consent-overlay kb-passage-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="kb-passage"
        role="dialog"
        aria-modal="true"
        aria-label={t('chat.knowledge.passage.ariaLabel', { title: group.title })}
      >
        <header className="kb-passage-head">
          <div>
            <h2>{group.title}</h2>
            {passage && (
              <small>
                {t('chat.knowledge.passage.position', {
                  section: passage.ordinal + 1,
                  total: passage.documentChunkCount,
                })}
              </small>
            )}
          </div>
          <button ref={closeRef} className="btn ghost" type="button" onClick={onClose}>
            {t('common.actions.close')}
          </button>
        </header>

        {sections.length > 1 && (
          <div className="kb-passage-sections" role="tablist">
            {sections.map((c) => (
              <button
                key={c.chunkId}
                type="button"
                role="tab"
                aria-selected={c.chunkId === chunkId}
                className="btn ghost"
                onClick={() => onSelect(c.chunkId)}
              >
                {t('chat.knowledge.passage.section', { section: c.ordinal + 1 })}
              </button>
            ))}
          </div>
        )}

        {failed ? (
          <p className="kb-passage-note">{t('chat.knowledge.passage.failed')}</p>
        ) : passage === undefined ? (
          <p className="kb-passage-note">{t('chat.knowledge.passage.loading')}</p>
        ) : passage === null ? (
          <p className="kb-passage-note">{t('chat.knowledge.passage.gone')}</p>
        ) : (
          <>
            {/* The user's own file content, rendered as text — never as markup. */}
            <pre className="kb-passage-text">{passage.content}</pre>
            <small className="kb-passage-source" title={passage.source}>
              {passage.source}
            </small>
          </>
        )}
      </div>
    </div>
  );
}
