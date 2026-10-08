/// Slides: start a deck from one prompt, and your decks.
///
/// A deck is built in a studio: you describe the story, the model drafts a
/// storyline, you approve it, and slides appear on a big stage. This page
/// starts new decks and lists the existing ones; opening one hands it to the
/// shell, which opens the studio.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '@conduit/ui';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { PageEmpty, PageFrame } from '../shell/PageFrame';
import { deleteDeck, listDecks, listSlideThemes, renameDeck } from '../ipc/client';
import type { DeckDetail, DeckSummary } from '../ipc/contracts';
import { STARTER_THEMES, type StarterTheme } from '../slides/themes';

export interface SlidesPageProps {
  onOpenDeck: (deck: DeckSummary | DeckDetail) => void;
  /** Start a deck from a prompt. The shell creates it and opens the studio. */
  onStartDeck: (prompt: string, themeName: string, themeCss: string) => Promise<void>;
  onStatus?: (message: string) => void;
  /** A story to put in the prompt box (a deck idea); a new `seq` fills it again. */
  prefill?: { text: string; seq: number } | null;
  /** Changes when a workflow changed a deck; the list is read again. */
  refreshKey?: number;
}

/** Starter chips: the label and the scaffold they put in the prompt box. */
const STARTERS: ReadonlyArray<{ id: string; labelId: string; scaffoldId: string }> = [
  { id: 'quarterly', labelId: 'slides.start.chip.quarterly', scaffoldId: 'slides.start.scaffold.quarterly' },
  { id: 'kickoff', labelId: 'slides.start.chip.kickoff', scaffoldId: 'slides.start.scaffold.kickoff' },
  { id: 'incident', labelId: 'slides.start.chip.incident', scaffoldId: 'slides.start.scaffold.incident' },
  { id: 'proposal', labelId: 'slides.start.chip.proposal', scaffoldId: 'slides.start.scaffold.proposal' },
];

function themeLabel(name: string): string {
  return STARTER_THEMES.find((th) => th.name === name)?.label ?? name;
}

export function SlidesPage({ onOpenDeck, onStartDeck, onStatus, prefill, refreshKey = 0 }: SlidesPageProps) {
  const t = useT();
  const fmt = useFormatters();
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [themeName, setThemeName] = useState(STARTER_THEMES[0].name);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [deleting, setDeleting] = useState<DeckSummary | null>(null);
  // Themes the model or the user made in other decks, offered after the
  // built-ins.
  const [savedThemes, setSavedThemes] = useState<StarterTheme[]>([]);
  useEffect(() => {
    listSlideThemes()
      .then((themes) =>
        setSavedThemes(
          themes
            .filter((th) => !STARTER_THEMES.some((s) => s.name.toLowerCase() === th.name.toLowerCase()))
            .map((th) => ({ name: th.name, label: th.name, css: th.css, dark: false })),
        ),
      )
      .catch(() => setSavedThemes([]));
  }, []);
  const allThemes = useMemo(() => [...STARTER_THEMES, ...savedThemes], [savedThemes]);

  // A deck idea lands here with its story filled in, ready to edit or start.
  useEffect(() => {
    if (!prefill) return;
    setPrompt(prefill.text);
    promptRef.current?.focus();
  }, [prefill]);

  const refresh = useCallback(async () => {
    try {
      setDecks(await listDecks());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setDecks([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  const fail = useCallback(
    (e: unknown) => onStatus?.(e instanceof Error ? e.message : String(e)),
    [onStatus],
  );

  const submit = async () => {
    const text = prompt.trim();
    if (text === '' || busy) return;
    const theme = allThemes.find((th) => th.name === themeName) ?? STARTER_THEMES[0];
    setBusy(true);
    try {
      await onStartDeck(text, theme.name, theme.css);
      setPrompt('');
      void refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const insertScaffold = (scaffold: string) => {
    setPrompt((current) => (current.trim() === '' ? scaffold : `${current.trimEnd()}

${scaffold}`));
    promptRef.current?.focus();
  };

  const commitRename = async () => {
    const target = renaming;
    setRenaming(null);
    const next = target?.draft.trim();
    if (!target || !next) return;
    const deck = decks?.find((d) => d.id === target.id);
    if (!deck || deck.title === next) return;
    try {
      await renameDeck(target.id, next);
      await refresh();
    } catch (e) {
      fail(e);
    }
  };

  const confirmDelete = async () => {
    const deck = deleting;
    setDeleting(null);
    if (!deck) return;
    try {
      await deleteDeck(deck.id);
      onStatus?.(t('slides.status.deleted', { title: deck.title }));
      await refresh();
    } catch (e) {
      fail(e);
    }
  };

  const startBox = (
    <form
      className="slides-start"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="field">
        <span className="slides-start-label">{t('slides.start.label')}</span>
        <textarea
          ref={promptRef}
          className="slides-start-input"
          value={prompt}
          rows={4}
          placeholder={t('slides.start.placeholder')}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
        />
      </label>
      <div className="slides-start-foot">
        <div className="slides-start-chips" role="group" aria-label={t('slides.start.chipsAria')}>
          {STARTERS.map((starter) => (
            <button
              key={starter.id}
              type="button"
              className="slides-start-chip"
              onClick={() => insertScaffold(t(starter.scaffoldId))}
            >
              {t(starter.labelId)}
            </button>
          ))}
        </div>
        <label className="deck-theme">
          <span className="deck-theme-label">{t('slides.start.themeLabel')}</span>
          <select
            className="deck-theme-select"
            value={themeName}
            onChange={(e) => setThemeName(e.target.value)}
          >
            {allThemes.map((th) => (
              <option key={th.name} value={th.name}>
                {th.label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn primary" disabled={busy || prompt.trim() === ''}>
          {t('slides.start.submit')}
        </button>
      </div>
    </form>
  );

  return (
    <PageFrame title={t('slides.page.title')} subtitle={t('slides.page.subtitle')} className="slides-page">
      {loadError && (
        <p className="slides-error" role="alert">
          {loadError}
        </p>
      )}
      {startBox}
      {decks && decks.length === 0 && !loadError && (
        <PageEmpty title={t('slides.page.emptyTitle')} body={t('slides.page.emptyBody')} />
      )}
      {decks && decks.length > 0 && (
        <ul className="slides-grid">
          {decks.map((deck) => (
            <li key={deck.id} className="deck-card">
              {renaming && renaming.id === deck.id ? (
                <input
                  className="deck-card-rename"
                  type="text"
                  value={renaming.draft}
                  maxLength={120}
                  autoFocus
                  aria-label={t('slides.card.renameAria', { title: deck.title })}
                  onChange={(e) => setRenaming({ id: deck.id, draft: e.target.value })}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    else if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <span className="deck-card-title" title={deck.title}>
                  {deck.title}
                </span>
              )}
              <span className="deck-card-meta">
                {t('slides.card.slides', { count: deck.slideCount })} · {themeLabel(deck.themeName)}
              </span>
              <span className="deck-card-meta">{t('slides.card.updated', { when: fmt.timeAgo(deck.updatedAt) })}</span>
              <div className="deck-card-foot">
                <button
                  type="button"
                  className="btn deck-card-open"
                  aria-label={t('slides.card.openAria', { title: deck.title })}
                  onClick={() => onOpenDeck(deck)}
                >
                  {t('slides.card.open')}
                </button>
                <button
                  type="button"
                  className="btn"
                  aria-label={t('slides.card.renameButtonAria', { title: deck.title })}
                  onClick={() => setRenaming({ id: deck.id, draft: deck.title })}
                >
                  {t('slides.card.rename')}
                </button>
                <button
                  type="button"
                  className="btn danger"
                  aria-label={t('slides.card.deleteAria', { title: deck.title })}
                  onClick={() => setDeleting(deck)}
                >
                  {t('slides.card.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={deleting != null}
        title={t('slides.delete.title', { title: deleting?.title ?? '' })}
        description={t('slides.delete.description')}
        confirmLabel={t('slides.delete.confirm')}
        cancelLabel={t('common.actions.cancel')}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
    </PageFrame>
  );
}
