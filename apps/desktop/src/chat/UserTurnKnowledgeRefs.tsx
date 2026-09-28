import type { KnowledgeRef } from './composerTypes';
import { useT } from '../i18n';

interface UserTurnKnowledgeRefsProps {
  refs: KnowledgeRef[];
}

/** Small read-only chips under a sent user message naming what it referenced
 *  (t1-8 M3, D7): "the sent message keeps showing what it referenced." */
export function UserTurnKnowledgeRefs({ refs }: UserTurnKnowledgeRefsProps) {
  const t = useT();
  if (refs.length === 0) return null;
  return (
    <div className="turn-knowledge-refs" aria-label={t('chat.knowledge.reference.turnAriaLabel')}>
      {refs.map((ref) => (
        <span
          key={ref.documentId}
          className="turn-knowledge-ref-chip"
          title={t('chat.knowledge.reference.chipLabel', { title: ref.title, collection: ref.collectionName })}
        >
          {t('chat.knowledge.reference.chipLabel', { title: ref.title, collection: ref.collectionName })}
        </span>
      ))}
    </div>
  );
}
