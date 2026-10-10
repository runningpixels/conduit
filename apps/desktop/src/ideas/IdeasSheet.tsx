/// The Ideas page (docs/plans/ideas-and-discovery.md): tested starting points
/// by what you want to do, filtered to what this setup can run, plus the
/// Prompts library as "My prompts".
///
/// A sheet like Documents — the shell has no routing for non-chat views.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from '../shell/useFocusTrap';
import { PageFrame, PageEmpty, PageListItem } from '../shell/PageFrame';
import { useT } from '../i18n';
import { PromptsSection } from '../workspace/settings/PromptsSection';
import { IDEA_CATEGORIES, IDEAS, IDEAS_REVISION, type Capability, type Idea, type IdeaCategory } from './catalog';
import { SETUP_TARGET, type Capabilities, type SetupTarget } from './capabilities';
import { FreeApiList } from './FreeApiList';
import { FREE_APIS, ideaApiLabel } from './freeApis';
import {
  clearSpotlight,
  markRevisionSeen,
  resetIdeaState,
  setRowHidden,
  useIdeaState,
} from './ideaState';
import { forYou, ideaStatus, missingNeed, newIdeas, spotlightIdeas } from './selectIdeas';

export interface IdeasSheetProps {
  open: boolean;
  onClose: () => void;
  caps: Capabilities;
  /// Start a chat with this idea's prompt in the composer.
  onTry: (idea: Idea) => void;
  /// Open the place that sets a capability up.
  onSetup: (target: SetupTarget) => void;
  onInsertPrompt: (body: string) => void;
  onStatus: (message: string) => void;
  /// Which tab to open on.
  initialTab?: Tab;
  /// `page`: the Ideas rail destination — no scrim, no close button, no My
  /// prompts tab (prompts live under Library). `sheet` (default): the modal.
  variant?: 'sheet' | 'page';
}

/// `apis`: the free APIs ideas build on, each with its idea to try.
type Tab = 'ideas' | 'apis' | 'prompts';

export function IdeasSheet({
  open,
  onClose,
  caps,
  onTry,
  onSetup,
  onInsertPrompt,
  onStatus,
  initialTab = 'ideas',
  variant = 'sheet',
}: IdeasSheetProps) {
  const isPage = variant === 'page';
  const t = useT();
  const state = useIdeaState();
  const sheetRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [category, setCategory] = useState<IdeaCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);

  // What was new or in the spotlight when the page opened stays on screen
  // until it closes; closing marks it seen.
  const [openedWith, setOpenedWith] = useState<{ fresh: Idea[]; spot: Capability[] }>({ fresh: [], spot: [] });
  useEffect(() => {
    if (!open) return;
    setTab(initialTab);
    setOpenedWith({ fresh: newIdeas(state), spot: state.spotlight });
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    markRevisionSeen(IDEAS_REVISION);
    clearSpotlight();
  }, [open]);

  useEffect(() => {
    if (!open || isPage) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault();
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);
  useFocusTrap(sheetRef, open && !isPage);

  const text = (idea: Idea, part: 'title' | 'blurb' | 'prompt') => t(`ideas.item.${idea.id}.${part}`);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return IDEAS.filter((idea) => {
      if (category !== 'all' && idea.category !== category) return false;
      if (!showAll && ideaStatus(idea, caps) === 'off') return false;
      if (!q) return true;
      return `${text(idea, 'title')} ${text(idea, 'blurb')}`.toLowerCase().includes(q);
    });
    // text depends on t
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category, query, showAll, caps, t]);

  if (!open) return null;

  const spotlit = spotlightIdeas(caps, openedWith.spot);
  const picks = forYou(caps, state);
  const hiddenCount = IDEAS.filter((idea) => ideaStatus(idea, caps) === 'off').length;

  const card = (idea: Idea) => (
    <IdeaCard
      key={idea.id}
      idea={idea}
      caps={caps}
      tried={state.tried.includes(idea.id)}
      title={text(idea, 'title')}
      blurb={text(idea, 'blurb')}
      onTry={() => onTry(idea)}
      onSetup={(need) => onSetup(SETUP_TARGET[need])}
    />
  );

  const apiList = (
    <FreeApiList caps={caps} onTry={onTry} onSetup={(need) => onSetup(SETUP_TARGET[need])} onStatus={onStatus} />
  );

  const body = (
        <div className="sheet-main scroll">
          <div className="sheet-single-head">
            <h2 className="sheet-h">{t('ideas.sheet.heading')}</h2>
            {!isPage && (
              <button className="btn ghost" type="button" onClick={onClose}>
                {t('common.actions.close')}
              </button>
            )}
          </div>
          {!isPage && (
          <div className="ideas-tabs" role="tablist" aria-label={t('ideas.sheet.tabsAriaLabel')}>
            {(['ideas', 'apis', 'prompts'] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={`ideas-tab${tab === id ? ' active' : ''}`}
                onClick={() => setTab(id)}
              >
                {t(`ideas.sheet.tab.${id}`)}
              </button>
            ))}
          </div>
          )}

          {tab === 'apis' ? (
            <section className="ideas-section" aria-label={t('ideas.apis.heading')}>
              <p className="sheet-sub">{t('ideas.apis.intro')}</p>
              {apiList}
            </section>
          ) : tab === 'prompts' && !isPage ? (
            <>
              <p className="sheet-sub">{t('ideas.sheet.promptsIntro')}</p>
              <PromptsSection
                onStatus={onStatus}
                onInsertPrompt={(body) => {
                  onInsertPrompt(body);
                  onClose();
                }}
              />
            </>
          ) : (
            <>
              <p className="sheet-sub">{t('ideas.sheet.intro')}</p>

              {spotlit.length > 0 && (
                <section className="ideas-section ideas-spotlight" aria-label={t('ideas.sheet.spotlight')}>
                  <h3>{t('ideas.sheet.spotlight')}</h3>
                  <div className="ideas-grid">{spotlit.map(card)}</div>
                </section>
              )}
              {openedWith.fresh.length > 0 && (
                <section className="ideas-section" aria-label={t('ideas.sheet.new')}>
                  <h3>{t('ideas.sheet.new')}</h3>
                  <div className="ideas-grid">{openedWith.fresh.map(card)}</div>
                </section>
              )}
              {picks.length > 0 && category === 'all' && !query && (
                <section className="ideas-section" aria-label={t('ideas.sheet.forYou')}>
                  <h3>{t('ideas.sheet.forYou')}</h3>
                  <div className="ideas-grid">{picks.map(card)}</div>
                </section>
              )}

              <section className="ideas-section" aria-label={t('ideas.sheet.all')}>
                <div className="ideas-filters">
                  <input
                    type="search"
                    className="ideas-search"
                    value={query}
                    placeholder={t('ideas.sheet.searchPlaceholder')}
                    aria-label={t('ideas.sheet.searchPlaceholder')}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <div className="ideas-categories" role="group" aria-label={t('ideas.sheet.categoriesAriaLabel')}>
                    {(['all', ...IDEA_CATEGORIES] as const).map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={`ideas-category${category === c ? ' active' : ''}`}
                        aria-pressed={category === c}
                        onClick={() => setCategory(c)}
                      >
                        {t(`ideas.category.${c}`)}
                      </button>
                    ))}
                  </div>
                </div>
                {visible.length === 0 ? (
                  <p className="ideas-empty">{t('ideas.sheet.noMatch')}</p>
                ) : (
                  <div className="ideas-grid">{visible.map(card)}</div>
                )}
              </section>

              <footer className="ideas-footer">
                <p>{t('ideas.sheet.privacy')}</p>
                <label className="ideas-check">
                  <input type="checkbox" checked={!state.rowHidden} onChange={(e) => setRowHidden(!e.target.checked)} />
                  {t('ideas.sheet.showInNewChats')}
                </label>
                {hiddenCount > 0 && (
                  <label className="ideas-check">
                    <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                    {t('ideas.sheet.showUnavailable', { count: hiddenCount })}
                  </label>
                )}
                <button className="btn ghost" type="button" onClick={() => resetIdeaState()}>
                  {t('ideas.sheet.reset')}
                </button>
              </footer>
            </>
          )}
        </div>
  );

  if (isPage) {
    // A rail page: categories and search on the left, the grid using the
    // whole width, "For you" and what is new shown once, above All.
    const overview = category === 'all' && !query.trim();
    const countIn = (c: IdeaCategory | 'all') =>
      IDEAS.filter((idea) => (c === 'all' || idea.category === c) && (showAll || ideaStatus(idea, caps) !== 'off')).length;
    return (
      <PageFrame
        className="ideas-page"
        title={t('ideas.sheet.heading')}
        subtitle={t('ideas.sheet.intro')}
        listLabel={t('ideas.sheet.categoriesAriaLabel')}
        listHeader={
          <input
            type="search"
            className="ideas-search"
            value={query}
            placeholder={t('ideas.sheet.searchPlaceholder')}
            aria-label={t('ideas.sheet.searchPlaceholder')}
            onChange={(e) => {
              setTab('ideas');
              setQuery(e.target.value);
            }}
          />
        }
        list={
          <>
            {(['all', ...IDEA_CATEGORIES] as const).map((c) => (
              <PageListItem
                key={c}
                selected={tab !== 'apis' && category === c}
                onSelect={() => {
                  setTab('ideas');
                  setCategory(c);
                }}
                title={t(`ideas.category.${c}`)}
                status={countIn(c)}
              />
            ))}
            <PageListItem
              selected={tab === 'apis'}
              onSelect={() => setTab('apis')}
              title={t('ideas.sheet.tab.apis')}
              status={FREE_APIS.length}
            />
            <div className="ideas-page-prefs">
              <p>{t('ideas.sheet.privacy')}</p>
              <label className="ideas-check">
                <input type="checkbox" checked={!state.rowHidden} onChange={(e) => setRowHidden(!e.target.checked)} />
                {t('ideas.sheet.showInNewChats')}
              </label>
              {hiddenCount > 0 && (
                <label className="ideas-check">
                  <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                  {t('ideas.sheet.showUnavailable', { count: hiddenCount })}
                </label>
              )}
              <button className="btn ghost" type="button" onClick={() => resetIdeaState()}>
                {t('ideas.sheet.reset')}
              </button>
            </div>
          </>
        }
      >
        {tab === 'apis' ? (
          <section className="ideas-section" aria-label={t('ideas.apis.heading')}>
            <h3>{t('ideas.apis.heading')}</h3>
            <p className="sheet-sub">{t('ideas.apis.intro')}</p>
            {apiList}
          </section>
        ) : (
        <>
        {overview && spotlit.length > 0 && (
          <section className="ideas-section ideas-spotlight" aria-label={t('ideas.sheet.spotlight')}>
            <h3>{t('ideas.sheet.spotlight')}</h3>
            <div className="ideas-grid">{spotlit.map(card)}</div>
          </section>
        )}
        {overview && openedWith.fresh.length > 0 && (
          <section className="ideas-section" aria-label={t('ideas.sheet.new')}>
            <h3>{t('ideas.sheet.new')}</h3>
            <div className="ideas-grid">{openedWith.fresh.map(card)}</div>
          </section>
        )}
        {overview && picks.length > 0 && (
          <section className="ideas-section" aria-label={t('ideas.sheet.forYou')}>
            <h3>{t('ideas.sheet.forYou')}</h3>
            <div className="ideas-grid">{picks.map(card)}</div>
          </section>
        )}
        <section className="ideas-section" aria-label={t('ideas.sheet.all')}>
          <h3>{category === 'all' ? t('ideas.sheet.all') : t(`ideas.category.${category}`)}</h3>
          {visible.length === 0 ? (
            <PageEmpty title={t('ideas.sheet.noMatch')} />
          ) : (
            <div className="ideas-grid">
              {(overview ? visible.filter((idea) => !picks.includes(idea)) : visible).map(card)}
            </div>
          )}
        </section>
        </>
        )}
      </PageFrame>
    );
  }
  return (
    <div
      className="scrim"
      data-open="true"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={sheetRef} className="sheet sheet-single ideas-sheet" role="dialog" aria-modal="true" aria-label={t('ideas.sheet.heading')}>
        {body}
      </div>
    </div>
  );
}

function IdeaCard({
  idea,
  caps,
  tried,
  title,
  blurb,
  onTry,
  onSetup,
}: {
  idea: Idea;
  caps: Capabilities;
  tried: boolean;
  title: string;
  blurb: string;
  onTry: () => void;
  onSetup: (need: Capability) => void;
}) {
  const t = useT();
  const status = ideaStatus(idea, caps);
  const need = missingNeed(idea, caps);
  const cost = caps.localModel ? t('ideas.cost.local') : t(`ideas.cost.${idea.size}`);
  const apiLabel = ideaApiLabel(idea, t);
  return (
    <article className="idea-card" data-status={status} data-category={idea.category}>
      <div className="idea-card-head">
        <span className="idea-card-category">{t(`ideas.category.${idea.category}`)}</span>
        {tried && <span className="idea-card-tried">{t('ideas.card.tried')}</span>}
      </div>
      <h4>{title}</h4>
      <p>{blurb}</p>
      <ul className="idea-card-badges">
        {idea.page && <li>{t('ideas.badge.page')}</li>}
        {idea.needs.map((n) => (
          <li key={n} data-need={n}>
            {t(`ideas.badge.${n}`)}
          </li>
        ))}
        {apiLabel && <li data-api="">{apiLabel}</li>}
        <li className="idea-card-cost">{cost}</li>
      </ul>
      <div className="idea-card-actions">
        {status === 'ready' ? (
          <button className="btn primary" type="button" onClick={onTry} aria-label={t('ideas.card.tryAriaLabel', { title })}>
            {t('ideas.card.try')}
          </button>
        ) : status === 'setup' && need ? (
          <button className="btn" type="button" onClick={() => onSetup(need)}>
            {t(`ideas.setup.${need}`)}
          </button>
        ) : (
          <span className="idea-card-off">{t('ideas.card.unavailable')}</span>
        )}
      </div>
    </article>
  );
}
