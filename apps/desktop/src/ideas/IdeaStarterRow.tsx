/// Three ideas under the empty chat's greeting — one quiet line, not the card
/// grid the V9 pass removed. It stops appearing after a few chats started
/// without it, and ✕ turns it off (the Ideas page turns it back on).

import { useT } from '../i18n';
import type { Idea } from './catalog';

export function IdeaStarterRow({
  ideas,
  onPick,
  onMore,
  onHide,
}: {
  ideas: readonly Idea[];
  onPick: (idea: Idea) => void;
  onMore?: () => void;
  onHide?: () => void;
}) {
  const t = useT();
  return (
    <div className="idea-starters" role="group" aria-label={t('ideas.starters.ariaLabel')}>
      <span className="idea-starters-label">{t('ideas.starters.label')}</span>
      {ideas.map((idea) => (
        <button key={idea.id} type="button" className="idea-starter" onClick={() => onPick(idea)}>
          {t(`ideas.item.${idea.id}.title`)}
        </button>
      ))}
      {onMore && (
        <button type="button" className="idea-starter idea-starter-more" onClick={onMore}>
          {t('ideas.starters.more')}
        </button>
      )}
      {onHide && (
        <button
          type="button"
          className="idea-starters-hide"
          aria-label={t('ideas.starters.hide')}
          title={t('ideas.starters.hide')}
          onClick={onHide}
        >
          ×
        </button>
      )}
    </div>
  );
}
