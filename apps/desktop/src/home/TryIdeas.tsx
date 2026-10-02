/// "Try something new": a few ideas that will work with this setup, in the
/// same card look as the new-chat gallery. Ideas added since the reader last
/// looked, or that a newly ready capability unlocked, come first and say so.

import { useId, useMemo } from 'react';
import { useT } from '../i18n';
import type { Idea } from '../ideas/catalog';
import type { Capabilities } from '../ideas/capabilities';
import type { IdeaState } from '../ideas/ideaState';
import { GLYPHS } from '../ideas/IdeaGallery';
import { forYou, ideaStatus, newIdeas, spotlightIdeas } from '../ideas/selectIdeas';

/// How many ideas Home offers.
export const HOME_IDEA_COUNT = 3;

export interface HomeIdea {
  idea: Idea;
  isNew: boolean;
}

/// New and spotlighted ideas first (ready and untried only), then "for you".
export function homeIdeas(caps: Capabilities, state: IdeaState, count = HOME_IDEA_COUNT): HomeIdea[] {
  const fresh: Idea[] = [];
  for (const idea of [...newIdeas(state).reverse(), ...spotlightIdeas(caps, state.spotlight)]) {
    if (state.tried.includes(idea.id) || ideaStatus(idea, caps) !== 'ready' || fresh.includes(idea)) continue;
    fresh.push(idea);
  }
  const out: HomeIdea[] = fresh.slice(0, count).map((idea) => ({ idea, isNew: true }));
  for (const idea of forYou(caps, state, count)) {
    if (out.length >= count) break;
    if (!out.some((o) => o.idea.id === idea.id)) out.push({ idea, isNew: false });
  }
  return out;
}

export interface TryIdeasProps {
  caps: Capabilities;
  state: IdeaState;
  onTryIdea: (idea: Idea) => void;
  onMoreIdeas: () => void;
}

export function TryIdeas({ caps, state, onTryIdea, onMoreIdeas }: TryIdeasProps) {
  const t = useT();
  const labelId = useId();
  const picks = useMemo(() => homeIdeas(caps, state), [caps, state]);
  if (state.rowHidden || picks.length === 0) return null;
  return (
    <section className="home-section" aria-labelledby={labelId}>
      <div className="home-section-head">
        <div className="home-section-heading">
          <h3 id={labelId} className="home-section-title">
            {t('home.ideas.title')}
          </h3>
          <p className="home-section-sub">{t('home.ideas.subtitle')}</p>
        </div>
        <div className="home-section-tools">
          <button type="button" className="home-link" onClick={onMoreIdeas}>
            {t('home.ideas.more')} →
          </button>
        </div>
      </div>
      <ul className="home-ideas">
        {picks.map(({ idea, isNew }) => {
          const title = t(`ideas.item.${idea.id}.title`);
          const cost = caps.localModel ? t('ideas.cost.local') : t(`ideas.cost.${idea.size}`);
          const meta = [cost, ...idea.needs.map((n) => t(`ideas.badge.${n}`))].join(' · ');
          return (
            <li key={idea.id} className="home-ideas-item">
              <button
                type="button"
                className="idea-gallery-card home-idea-card"
                data-category={idea.category}
                aria-label={t('ideas.card.tryAriaLabel', { title })}
                onClick={() => onTryIdea(idea)}
              >
                <span className="idea-gallery-tile" aria-hidden="true">
                  {GLYPHS[idea.id] ?? '·'}
                </span>
                <span className="idea-gallery-text">
                  <span className="idea-gallery-title">
                    {title}
                    {isNew && <span className="home-tag home-tag-new">{t('home.ideas.new')}</span>}
                  </span>
                  <span className="idea-gallery-blurb">{t(`ideas.item.${idea.id}.blurb`)}</span>
                  <span className="idea-gallery-meta" title={meta}>
                    {meta}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
