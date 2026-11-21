/// Artifacts (rail destination): everything you have made, in one place —
/// pages and apps, decks, documents, spreadsheets and images, from every chat
/// and from Slides, Writing and Apps.
///
/// Tabs by kind (each with its count), a search over titles and the chats
/// they came from, newest or A–Z, and a grid or list. Opening an item goes
/// where it lives: a chat's artifact opens in its chat's panel, a deck in
/// Slides, a draft in Writing, an app in Apps. Making something new is Home's
/// job, so the page sends you there rather than repeating its tiles.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { listAllArtifacts, listDecks, listDrafts } from '../ipc/client';
import type { AppSummary, Artifact, ConversationSummary, DeckSummary, DraftSummary } from '../ipc/contracts';
import { FileIcon, ImageIcon, SearchIcon, SheetIcon, SlidesIcon, WindowIcon, WritingIcon } from '../icons';
import { PageEmpty, PageFrame } from '../shell/PageFrame';
import {
  ARTIFACT_TABS,
  buildArtifactItems,
  countByTab,
  filterArtifactItems,
  type ArtifactItem,
  type ArtifactItemKind,
  type ArtifactOpen,
  type ArtifactSort,
  type ArtifactTab,
} from '../artifacts/artifactItems';

export interface ArtifactsPageProps {
  conversations: readonly ConversationSummary[];
  savedApps: readonly AppSummary[];
  onOpen: (target: ArtifactOpen) => void;
  /** Go to Home, where new things are started. */
  onMakeNew: () => void;
}

const KIND_ICONS: Record<ArtifactItemKind, ReactNode> = {
  page: <FileIcon />,
  app: <WindowIcon />,
  deck: <SlidesIcon />,
  document: <WritingIcon />,
  sheet: <SheetIcon />,
  image: <ImageIcon />,
  code: <FileIcon />,
};

type View = 'grid' | 'list';
const VIEW_KEY = 'conduit.artifacts.view';

function readView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

/** A list that failed to load is an empty list: the page shows what it has. */
async function listOr<T>(read: () => Promise<T[]>): Promise<T[]> {
  try {
    const rows = await read();
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export function ArtifactsPage({ conversations, savedApps, onOpen, onMakeNew }: ArtifactsPageProps) {
  const t = useT();
  const fmt = useFormatters();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<ArtifactTab>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ArtifactSort>('recent');
  const [view, setViewState] = useState<View>(readView);
  const tabRefs = useRef<Partial<Record<ArtifactTab, HTMLButtonElement | null>>>({});

  const setView = (next: View) => {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // A per-viewer convenience; the page works without it.
    }
  };

  // Read on open and again when the window regains focus (a chat elsewhere
  // may have made something meanwhile).
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void Promise.all([listOr(listAllArtifacts), listOr(listDecks), listOr(listDrafts)]).then(([a, d, dr]) => {
        if (cancelled) return;
        setArtifacts(a);
        setDecks(d);
        setDrafts(dr);
        setLoaded(true);
      });
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', load);
    };
  }, []);

  const items = useMemo(
    () => buildArtifactItems(artifacts, decks, drafts, savedApps, conversations),
    [artifacts, decks, drafts, savedApps, conversations],
  );
  const counts = useMemo(() => countByTab(items), [items]);
  const untitled = t('artifacts.page.untitled');
  const shown = useMemo(() => filterArtifactItems(items, tab, query, sort, untitled), [items, tab, query, sort, untitled]);

  const selectTab = useCallback((next: ArtifactTab, focus = false) => {
    setTab(next);
    if (focus) requestAnimationFrame(() => tabRefs.current[next]?.focus());
  }, []);
  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = ARTIFACT_TABS.indexOf(tab);
    const n = ARTIFACT_TABS.length;
    let next: ArtifactTab | null = null;
    if (e.key === 'ArrowRight') next = ARTIFACT_TABS[(i + 1) % n];
    else if (e.key === 'ArrowLeft') next = ARTIFACT_TABS[(i - 1 + n) % n];
    else if (e.key === 'Home') next = ARTIFACT_TABS[0];
    else if (e.key === 'End') next = ARTIFACT_TABS[n - 1];
    if (!next) return;
    e.preventDefault();
    selectTab(next, true);
  };

  const meta = (item: ArtifactItem) => {
    const parts = [t(`artifacts.page.kind.${item.kind}`), fmt.timeAgo(item.when)];
    if (item.chatTitle) parts.push(t('artifacts.page.fromChat', { chat: item.chatTitle }));
    return parts.join(' · ');
  };

  const makeNew = (
    <button type="button" className="btn primary" onClick={onMakeNew}>
      {t('artifacts.page.makeNew')}
    </button>
  );

  return (
    <PageFrame
      destination="artifacts"
      className="artifacts-page"
      title={t('artifacts.page.title')}
      subtitle={t('artifacts.page.subtitle')}
      actions={items.length > 0 ? makeNew : undefined}
    >
      {loaded && items.length === 0 ? (
        <PageEmpty title={t('artifacts.page.emptyTitle')} body={t('artifacts.page.emptyBody')} action={makeNew} />
      ) : (
        <>
          <div className="art-tabs" role="tablist" aria-label={t('artifacts.page.tabsLabel')}>
            {ARTIFACT_TABS.map((id) => (
              <button
                key={id}
                ref={(el) => {
                  tabRefs.current[id] = el;
                }}
                type="button"
                role="tab"
                id={`art-tab-${id}`}
                aria-selected={tab === id}
                aria-controls="art-panel"
                tabIndex={tab === id ? 0 : -1}
                className="art-tab"
                onClick={() => selectTab(id)}
                onKeyDown={onTabKeyDown}
              >
                <span>{t(`artifacts.page.tab.${id}`)}</span>
                <span className="art-tab-count">{counts[id]}</span>
              </button>
            ))}
          </div>
          <div className="art-tools">
            <label className="art-search">
              <SearchIcon aria-hidden="true" />
              <input
                type="search"
                value={query}
                placeholder={t('artifacts.page.search')}
                aria-label={t('artifacts.page.search')}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="art-seg" role="group" aria-label={t('artifacts.page.sort.label')}>
              <span className="art-seg-label" aria-hidden="true">
                {t('artifacts.page.sort.label')}
              </span>
              {(['recent', 'name'] as const).map((s) => (
                <button key={s} type="button" className="art-seg-btn" aria-pressed={sort === s} onClick={() => setSort(s)}>
                  {t(`artifacts.page.sort.${s}`)}
                </button>
              ))}
            </div>
            <div className="art-seg" role="group" aria-label={t('artifacts.page.view.label')}>
              {(['grid', 'list'] as const).map((v) => (
                <button key={v} type="button" className="art-seg-btn" aria-pressed={view === v} onClick={() => setView(v)}>
                  {t(`artifacts.page.view.${v}`)}
                </button>
              ))}
            </div>
          </div>
          <div id="art-panel" role="tabpanel" aria-labelledby={`art-tab-${tab}`}>
            {!loaded ? null : shown.length === 0 ? (
              <p className="art-none">
                {query.trim() ? t('artifacts.page.noMatch', { query: query.trim() }) : t('artifacts.page.tabEmpty')}
              </p>
            ) : (
              <ul className={view === 'grid' ? 'art-grid' : 'art-list'} aria-label={t(`artifacts.page.tab.${tab}`)}>
                {shown.map((item) => {
                  const title = item.title ?? untitled;
                  const line = meta(item);
                  return (
                    <li key={item.key}>
                      <button type="button" className="art-card" data-kind={item.kind} onClick={() => onOpen(item.open)}>
                        <span className="art-thumb" aria-hidden="true">
                          <span className="art-thumb-art" />
                          <span className="art-thumb-icon">{KIND_ICONS[item.kind]}</span>
                        </span>
                        <span className="art-text">
                          <span className="art-title" title={title}>
                            {title}
                          </span>
                          <span className="art-meta" title={line}>
                            {line}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </PageFrame>
  );
}
