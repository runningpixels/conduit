/// The new-chat idea gallery (ADR-011): category chips over a grid of idea
/// cards, under the centred composer. It replaces the one-line starter row.
///
/// Only ideas that are ready to run with the current setup are shown — this is
/// a place to start, not a setup checklist. "More ideas" opens the Ideas page,
/// which lists everything, with the setup each one needs.
///
/// Picking a card puts its prompt in the composer (App's `tryIdea`); nothing
/// is sent until the user sends it.

import { useId, useMemo, useState } from 'react';
import { useT, type Translate } from '../i18n';
import { IDEA_CATEGORIES, IDEAS, type Idea, type IdeaCategory } from './catalog';
import { ideaApiLabel } from './freeApis';
import type { Capabilities } from './capabilities';
import type { IdeaState } from './ideaState';
import { forYou, ideaStatus } from './selectIdeas';

/// How many cards the gallery shows: two rows of three.
export const GALLERY_SIZE = 6;

/// A short typographic mark per idea for the card's tile. Symbols and numbers
/// only, so nothing here needs translating.
export const GLYPHS: Record<string, string> = {
  pomodoroTimer: '25:00',
  budgetTracker: '+ −',
  unitConverter: '⇄',
  weatherDashboard: '18°',
  currencyConverter: '€ $',
  githubViewer: '</>',
  morningBriefing: '7:30',
  periodicTable: 'Fe',
  flashcards: 'Q/A',
  compoundInterest: '%',
  cheatSheet: '⌘',
  snakeGame: '▚▚▚',
  capitalsQuiz: '?',
  memoryGame: '◆◇',
  pitchDeck: '1/10',
  landingPage: '▭',
  weekInReview: '7d',
  askDocuments: '[1]',
  improveReadme: '.md',
  bakeryLogo: '◐',
  storyIllustration: '✦',
  bookFinder: '§',
  recipeFinder: '⅔',
  holidayCalendar: '31',
  foodLabel: '|||',
  tvShowFinder: '▶',
  imageSearch: '▦',
  npmPackageCard: 'npm',
  airQuality: 'AQI',
  goldenHour: '☀',
  earthquakeTracker: 'M5',
  cryptoTicker: '₿',
  issTracker: 'ISS',
  spaceLaunches: 'T−10',
  hackerNewsReader: 'Y',
  onThisDay: '1969',
  wildlifeSightings: '✿',
  wordExplorer: 'Aa',
  artGallery: '◫',
  poemOfTheDay: '❝',
  triviaQuiz: '?!',
  blackjack: '21',
  pokedex: '◓',
};

type Filter = 'all' | IdeaCategory;

export interface IdeaGalleryProps {
  caps: Capabilities;
  state: IdeaState;
  onPick: (idea: Idea) => void;
  onMore?: () => void;
  onHide?: () => void;
  /** Ideas with a ready-made starter app: their card gets "Open app". */
  readyMade?: ReadonlySet<string>;
  onOpenReadyMade?: (idea: Idea) => void;
}

/// A card's meta line: cost, then what it needs. An idea built on a free API
/// names it instead of the generic network badge — the gallery shows only
/// ideas that are ready, so network access is already on.
export function ideaMeta(idea: Idea, cost: string, t: Translate): string {
  const api = ideaApiLabel(idea, t);
  const needs = idea.needs.filter((n) => !(api && n === 'network')).map((n) => t(`ideas.badge.${n}`));
  return [cost, ...needs, ...(api ? [api] : [])].join(' · ');
}

/// The ideas the gallery shows for `filter`: "All" is the Ideas page's "For
/// you" ranking (ready, untried, one per category first); a category is its
/// ready ideas in catalog order.
export function galleryIdeas(filter: Filter, caps: Capabilities, state: IdeaState): Idea[] {
  if (filter === 'all') return forYou(caps, state, GALLERY_SIZE);
  return IDEAS.filter((idea) => idea.category === filter && ideaStatus(idea, caps) === 'ready').slice(0, GALLERY_SIZE);
}

export function IdeaGallery({ caps, state, onPick, onMore, onHide, readyMade, onOpenReadyMade }: IdeaGalleryProps) {
  const t = useT();
  const labelId = useId();
  const [filter, setFilter] = useState<Filter>('all');
  const ideas = useMemo(() => galleryIdeas(filter, caps, state), [filter, caps, state]);
  const filters: Filter[] = ['all', ...IDEA_CATEGORIES];

  return (
    <section className="idea-gallery" aria-labelledby={labelId}>
      <div className="idea-gallery-head">
        <h2 id={labelId} className="idea-gallery-label">{t('ideas.starters.ariaLabel')}</h2>
        <div className="idea-gallery-links">
          {onMore && (
            <button type="button" className="idea-gallery-link" onClick={onMore}>
              {t('ideas.starters.more')} →
            </button>
          )}
          {onHide && (
            <button type="button" className="idea-gallery-link" onClick={onHide}>
              {t('ideas.starters.hide')}
            </button>
          )}
        </div>
      </div>
      <div className="idea-gallery-filters" role="group" aria-label={t('ideas.sheet.categoriesAriaLabel')}>
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            className="idea-gallery-filter"
            aria-pressed={f === filter}
            onClick={() => setFilter(f)}
          >
            {t(`ideas.category.${f}`)}
          </button>
        ))}
      </div>
      {ideas.length === 0 ? (
        <p className="idea-gallery-empty">{t('ideas.sheet.noMatch')}</p>
      ) : (
        <ul className="idea-gallery-grid">
          {ideas.map((idea) => {
            const title = t(`ideas.item.${idea.id}.title`);
            const cost = caps.localModel ? t('ideas.cost.local') : t(`ideas.cost.${idea.size}`);
            const meta = ideaMeta(idea, cost, t);
            return (
              <li key={idea.id} className="idea-gallery-item">
                <button
                  type="button"
                  className="idea-gallery-card"
                  data-category={idea.category}
                  aria-label={t('ideas.card.tryAriaLabel', { title })}
                  onClick={() => onPick(idea)}
                >
                  <span className="idea-gallery-tile" aria-hidden="true">
                    {GLYPHS[idea.id] ?? '·'}
                  </span>
                  <span className="idea-gallery-text">
                    <span className="idea-gallery-title">{title}</span>
                    <span className="idea-gallery-blurb">{t(`ideas.item.${idea.id}.blurb`)}</span>
                    <span className="idea-gallery-meta" title={meta}>
                      {meta}
                    </span>
                  </span>
                </button>
                {onOpenReadyMade && readyMade?.has(idea.id) && (
                  <button
                    type="button"
                    className="idea-gallery-open"
                    aria-label={t('ideas.card.openAppAriaLabel', { title })}
                    onClick={() => onOpenReadyMade(idea)}
                  >
                    {t('ideas.card.openApp')}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
