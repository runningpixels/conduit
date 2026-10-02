/// The deck workspace: what the right panel shows in a chat bound to a deck.
/// A header (title, theme, history), then the storyline editor while the deck
/// is still an outline, or a strip of thumbnails beside the stage once slides
/// exist. History opens as a drawer on the right. Props-driven: the caller
/// owns every IPC call.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useT } from '../i18n';
import type { ArtifactColorScheme } from '../artifacts/HtmlArtifactRenderer';
import type {
  DeckDetail,
  DeckReplaceResult,
  DeckSnapshotSummary,
  SlideTheme,
  SlotEdit,
  StorylineItem,
} from '../ipc/contracts';
import { DeckFrame } from './DeckFrame';
import { DeckHistory } from './DeckHistory';
import { StorylineEditor } from './StorylineEditor';
import { ScriptPanel, type ScriptFocusRequest } from './ScriptPanel';
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
  /** Custom themes kept in the theme library, offered after the built-ins. */
  savedThemes?: readonly SlideTheme[];
  /** Fix words without an AI turn. Giving this makes the stage editable. */
  onEditWords?: (slideId: string, edits: SlotEdit[], notes?: string) => Promise<void>;
  onSetPinned?: (slideId: string, index: number, name: string, pinned: boolean) => Promise<void>;
  onReplace?: (
    find: string,
    replace: string,
    matchCase: boolean,
    wholeWord: boolean,
    apply: boolean,
  ) => Promise<DeckReplaceResult>;
  /** Sends a ready-made request to the chat ("Ask to fix"). */
  /** Adds a bullet after the given one; resolves the new slot's name so the Script can focus it. */
  onInsertBullet?: (slideId: string, index: number, name: string) => Promise<string | null>;
  onRemoveBullet?: (slideId: string, index: number, name: string) => Promise<void>;
  onAskToFix?: (prompt: string) => void;
  /** Slide id to pixels of overflow, only slides that overflow. */
  onOverflowChange?: (overflow: Record<string, number>) => void;
}

const NO_THEMES: readonly SlideTheme[] = [];

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
  savedThemes = NO_THEMES,
  onEditWords,
  onSetPinned,
  onReplace,
  onInsertBullet,
  onRemoveBullet,
  onAskToFix,
  onOverflowChange,
}: DeckWorkspaceProps) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const [drawer, setDrawer] = useState<'history' | 'script' | null>(null);
  const [overflow, setOverflow] = useState<Record<string, number>>({});
  const [focusRequest, setFocusRequest] = useState<ScriptFocusRequest | null>(null);
  const [findToken, setFindToken] = useState(0);
  const nonce = useRef(0);
  const overflowCb = useRef(onOverflowChange);
  overflowCb.current = onOverflowChange;
  const scriptAvailable = onEditWords != null && onSetPinned != null && onReplace != null;
  const [titleDraft, setTitleDraft] = useState(deck?.title ?? '');
  const prevIds = useRef<{ deckId: string | null; ids: string[] }>({ deckId: null, ids: [] });
  const stripRef = useRef<HTMLUListElement>(null);

  const slides = useMemo(() => deck?.slides ?? [], [deck?.slides]);
  const count = slides.length;

  useEffect(() => {
    setTitleDraft(deck?.title ?? '');
  }, [deck?.title, deck?.id]);

  useEffect(() => {
    setOverflow({});
  }, [deck?.id]);

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

  // Built-in themes, then saved ones (themes the model or the user made), then
  // the deck's own theme if it is in neither list.
  const themeChoices = useMemo(() => {
    const choices = STARTER_THEMES.map((th) => ({ value: th.name, label: th.label, css: th.css as string | null }));
    for (const saved of savedThemes) {
      if (!choices.some((c) => c.value.toLowerCase() === saved.name.toLowerCase())) {
        choices.push({ value: saved.name, label: saved.name, css: saved.css });
      }
    }
    if (deck && !choices.some((c) => c.value === deck.themeName)) {
      choices.push({ value: deck.themeName, label: deck.themeName, css: null });
    }
    return choices;
  }, [deck, savedThemes]);

  const go = (delta: number) => setIndex(Math.max(0, Math.min(count - 1, current + delta)));

  // Navigation keys, from the stage wrapper or relayed by the stage frame.
  const navigate = (key: string): boolean => {
    if (key === 'ArrowLeft' || key === 'PageUp') go(-1);
    else if (key === 'ArrowRight' || key === 'PageDown') go(1);
    else if (key === 'Home') setIndex(0);
    else if (key === 'End') setIndex(Math.max(0, count - 1));
    else return false;
    return true;
  };

  const openScriptFind = () => {
    if (!scriptAvailable) return;
    setDrawer('script');
    setFindToken((n) => n + 1);
  };

  const onStageKey = (event: KeyboardEvent<HTMLElement>) => {
    if (navigate(event.key)) event.preventDefault();
  };

  const onFrameKey = (key: string) => {
    if (key === 'Ctrl+H') openScriptFind();
    else navigate(key);
  };

  const onOverflow = (list: Array<{ id: string; px: number }>) => {
    const next: Record<string, number> = {};
    for (const { id, px } of list) if (px > 0) next[id] = px;
    setOverflow(next);
    overflowCb.current?.(next);
  };

  const onSlotSelect = (slideId: string, slotIndex: number) => {
    nonce.current += 1;
    setFocusRequest({ slideId, index: slotIndex, nonce: nonce.current });
  };

  const onSlotEdit = (slideId: string, slotIndex: number, name: string, html: string) => {
    onEditWords?.(slideId, [{ index: slotIndex, name, html }])?.catch(() => undefined);
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
  const scriptPanel =
    drawer === 'script' && scriptAvailable ? (
      <ScriptPanel
        deck={deck}
        overflow={overflow}
        focusRequest={focusRequest}
        findFocusToken={findToken}
        onEditWords={onEditWords}
        onSetPinned={onSetPinned}
        onReplace={onReplace}
        onInsertBullet={onInsertBullet}
        onRemoveBullet={onRemoveBullet}
        onAskToFix={onAskToFix}
        onFocusSlide={setIndex}
        onClose={() => setDrawer(null)}
      />
    ) : null;
  const scriptBeside = scriptPanel != null && deck.stage !== 'storyline' && count > 0;

  return (
    <div
      className="deck-workspace"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'h' && scriptAvailable) {
          e.preventDefault();
          openScriptFind();
        }
      }}
    >
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
              const choice = themeChoices.find((c) => c.value === e.target.value);
              if (choice?.css) onSetTheme(choice.value, choice.css);
            }}
          >
            {themeChoices.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        {scriptAvailable && (
          <button
            type="button"
            className="btn"
            aria-pressed={drawer === 'script'}
            onClick={() => setDrawer((d) => (d === 'script' ? null : 'script'))}
          >
            {t('slides.script.toggle')}
          </button>
        )}
        <button
          type="button"
          className="btn"
          aria-pressed={drawer === 'history'}
          onClick={() => setDrawer((d) => (d === 'history' ? null : 'history'))}
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
            <div className="deck-slides" data-script={scriptBeside ? 'open' : undefined}>
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
                    {overflow[slide.id] > 0 && (
                      <span
                        className="deck-strip-warn"
                        role="img"
                        aria-label={t('slides.overflow.dotAria', { n: i + 1 })}
                        title={t('slides.overflow.warning', { px: overflow[slide.id] })}
                      />
                    )}
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
                  <DeckFrame
                    deck={deck}
                    index={current}
                    mode="stage"
                    colorScheme={colorScheme}
                    editable={onEditWords != null}
                    onSlotSelect={onSlotSelect}
                    onSlotEdit={onSlotEdit}
                    onKey={onFrameKey}
                    onOverflow={onOverflow}
                  />
                </div>
                {slides[current] && overflow[slides[current].id] > 0 && (
                  <p className="deck-stage-overflow" role="status">
                    <span>{t('slides.overflow.warning', { px: overflow[slides[current].id] })}</span>
                    {onAskToFix && (
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          onAskToFix(
                            t('slides.overflow.fixPrompt', { n: current + 1, px: overflow[slides[current].id] }),
                          )
                        }
                      >
                        {t('slides.overflow.ask')}
                      </button>
                    )}
                  </p>
                )}
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
              {scriptBeside && scriptPanel}
            </div>
          )}
        </div>
        {!scriptBeside && scriptPanel}
        {drawer === 'history' && (
          <DeckHistory
            revision={historyRevision}
            onList={onListSnapshots}
            onRestore={onRestore}
            onClose={() => setDrawer(null)}
          />
        )}
      </div>
    </div>
  );
}
