import type { KnowledgeCitation } from '../ipc/contracts';
import { useT } from '../i18n';

interface KnowledgeCitationsProps {
  citations: KnowledgeCitation[];
}

/** Documents this turn's knowledge retrieval drew on, shown on the user
 *  bubble that triggered the retrieval. Structural sibling of
 *  `UserTurnAttachments`: a small chip strip, not inline markers -- the
 *  chunks were retrieved before the send, not annotated onto the assistant's
 *  own output the way web-search `CitationMarker`s are. */
export function KnowledgeCitations({ citations }: KnowledgeCitationsProps) {
  const t = useT();
  if (citations.length === 0) return null;

  const byDocument = new Map<string, { title: string; count: number }>();
  for (const c of citations) {
    const entry = byDocument.get(c.documentId);
    if (entry) entry.count += 1;
    else byDocument.set(c.documentId, { title: c.documentTitle, count: 1 });
  }

  return (
    <div className="turn-citations" aria-label={t('chat.knowledge.citations.ariaLabel')}>
      {[...byDocument.values()].map(({ title, count }) => (
        <span key={title} className="turn-citation-chip" title={title}>
          {t('chat.knowledge.citations.chip', { title, count })}
        </span>
      ))}
    </div>
  );
}
