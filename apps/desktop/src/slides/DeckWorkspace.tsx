/// The deck workspace: what the right panel shows in a chat bound to a deck.
/// A header (title, theme, history), then the storyline editor while the deck
/// is still an outline, or a strip of thumbnails beside the stage once slides
/// exist. History opens as a drawer on the right. Props-driven: the caller
/// owns every IPC call.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../i18n';
import type { ArtifactColorScheme } from '../artifacts/HtmlArtifactRenderer';
import type { DeckDetail, DeckSnapshotSummary, StorylineItem } from '../ipc/contracts';
import { DeckFrame } from './DeckFrame';
import { DeckHistory } from './DeckHistory';
import { StorylineEditor } from './StorylineEditor';
import { STARTER_THEMES } from './themes';

export interface DeckWorkspaceProps {
  deck: DeckDetail | null;
  loading: boolean;
  /** Name of the deck tool the model is running right now, if any. */
  busyTool: string | null;
  colorScheme: ArtifactColorScheme;
  onRename: (title: string) => void;
  onSetTheme: (name: string, css: string) => void;
  onSetStoryline: (items: StorylineItem[]) => void;
  onBuild: () => void;
  onListSnapshots: () => Promise<DeckSnapshotSummary[]>;
  onRestore: (snapshotId: string) => Promise<void>;
  /** Bumps when a snapshot may have been added, so History reloads. */
  historyRevision: number;
}

export function DeckWorkspace({
  deck,
  loading,
  busyTool,
  colorScheme,
  onRename,
  onSetTheme,
  onSetStoryline,
  onBuild,
  onListSnapshots,
  onRestore,
  historyRevision,
}: DeckWorkspaceProps) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState(deck?.title ?? '');
  const prevIds = useRef<{ deckId: string | null; ids: string[] }>({ deckId: null, ids: [] });
  const stripRef = useRef<HTMLUListElement>(null);

  const slides = useMemo(() => deck?.slides ?? [], [deck?.slides]);
  const count = slides.length;

  useEffect(() => {
    setTitleDraft(deck?.title ?? '');
  }, [deck?.title, deck?.id]);

  // Clamp when slides go away; jump to a slide that just appeared.
  useEffect(() => {
    const deckId = deck?.id ?? null;
    const prev = prevIds.current;
    const ids = slides.map((s) => s.id);
    if (prev.deckId !== deckId) {
      setIndex(0);
    } else if (ids.length > prev.ids.length) {
      const known = new Set(prev.ids);
      const added = ids.findIndex((id) => !known.has(id));
      if (added >= 0) setIndex(added);
    } else {
      setIndex((i) => Math.max(0, Math.min(i, ids.length - 1)));
    }
    prevIds.current = { deckId, ids };
  }, [deck?.id, slides]);

  const current = Math.max(0, Math.min(index, count - 1));

  useEffect(() => {
    const el = stripRef.current?.children[current] as HTMLElement | undefined;
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [current, count]);

  const themeOptions = useMemo(() => {
    const starters = STARTER_THEMES.map((th) => ({ value: th.name, label: th.label }));
    if (deck && !STARTER_THEMES.some((th) => th.name === deck.themeName)) {
      starters.push({ value: deck.themeName, label: deck.themeName });
    }
    return starters;
  }, [deck]);

  const go = (delta: number) => setIndex(Math.max(0, Math.min(count - 1, current + delta)));

  const onStageKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(1);
    }
  };

  const commitTitle = () => {
    const next = titleDraft.trim();
    if (!deck || next === '' || next === deck.title) {
      setTitleDraft(deck?.title ?? '');
      return;
    }
    onRename(next);
  };

  if (!deck) {
    return (
      <div className="deck-workspace deck-workspace-empty">
        <p className="deck-empty">{loading ? t('slides.workspace.loading') : t('slides.workspace.none')}</p>
      </div>
    );
  }

  const busy = busyTool != null;

  return (
    <div className="deck-workspace">
      <header className="deck-head">
        <input
          className="deck-title-input"
          type="text"
          value={titleDraft}
          maxLength={120}
          aria-label={t('slides.workspace.titleAria')}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            else if (e.key === 'Escape') {
              setTitleDraft(deck.title);
              e.currentTarget.blur();
            }
          }}
        />
        {busy && (
          <span className="deck-updating" role="status">
            {t('slides.workspace.updating')}
          </span>
        )}
        <label className="deck-theme">
          <span className="deck-theme-label">{t('slides.workspace.theme')}</span>
          <select
            className="deck-theme-select"
            value={deck.themeName}
            onChange={(e) => {
              const theme = STARTER_THEMES.find((th) => th.name === e.target.value);
              if (theme) onSetTheme(theme.name, theme.css);
            }}
          >
            {themeOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn"
          aria-pressed={historyOpen}
          onClick={() => setHistoryOpen((v) => !v)}
        >
          {t('slides.workspace.history')}
        </button>
      </header>
      <div className="deck-body">
        <div className="deck-main">
          {deck.stage === 'storyline' ? (
            <StorylineEditor items={deck.storyline} busy={busy} onChange={onSetStoryline} onBuild={onBuild} />
          ) : count === 0 ? (
            <p className="deck-empty">{t('slides.workspace.emptySlides')}</p>
          ) : (
            <div className="deck-slides">
              <ul
                ref={stripRef}
                className="deck-strip"
                data-busy={busy ? 'true' : undefined}
                aria-label={t('slides.strip.label')}
              >
                {slides.map((slide, i) => (
                  <li key={slide.id} className="deck-strip-item" data-selected={i === current ? 'true' : undefined}>
                    <DeckFrame deck={deck} index={i} mode="thumb" colorScheme={colorScheme} onSelect={() => setIndex(i)} />
                    <span className="deck-strip-num" aria-hidden="true">
                      {i + 1}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="deck-stage-col">
                <div
                  className="deck-stage"
                  tabIndex={0}
                  role="group"
                  aria-label={t('slides.stage.label', { n: current + 1, m: count })}
                  onKeyDown={onStageKey}
                >
                  <DeckFrame deck={deck} index={current} mode="stage" colorScheme={colorScheme} />
                </div>
                <div className="deck-stage-nav">
                  <button
                    type="button"
                    className="storyline-icon-btn"
                    aria-label={t('slides.stage.previous')}
                    disabled={current <= 0}
                    onClick={() => go(-1)}
                  >
                    <span aria-hidden="true">←</span>
                  </button>
                  <span className="deck-stage-count" aria-live="polite">
                    {t('slides.stage.count', { n: current + 1, m: count })}
                  </span>
                  <button
                    type="button"
                    className="storyline-icon-btn"
                    aria-label={t('slides.stage.next')}
                    disabled={current >= count - 1}
                    onClick={() => go(1)}
                  >
                    <span aria-hidden="true">→</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        {historyOpen && (
          <DeckHistory
            revision={historyRevision}
            onList={onListSnapshots}
            onRestore={onRestore}
            onClose={() => setHistoryOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
