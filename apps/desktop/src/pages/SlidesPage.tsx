/// Slides: your decks, and a form for a new one.
///
/// A deck is built in a chat: the model drafts a storyline, you approve it,
/// and slides appear in a live panel. This page lists the decks and starts new
/// ones; opening one hands it to the shell, which opens its chat.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '@conduit/ui';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { PageEmpty, PageFrame } from '../shell/PageFrame';
import { createDeck, deleteDeck, listDecks, listSlideThemes, renameDeck } from '../ipc/client';
import type { DeckDetail, DeckSummary } from '../ipc/contracts';
import { DeckFrame } from '../slides/DeckFrame';
import { STARTER_THEMES, type StarterTheme } from '../slides/themes';

export interface SlidesPageProps {
  onOpenDeck: (deck: DeckSummary | DeckDetail) => void;
  onStatus?: (message: string) => void;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function themeLabel(name: string): string {
  return STARTER_THEMES.find((th) => th.name === name)?.label ?? name;
}

/** A one-slide deck that shows what a theme looks like. */
function previewDeck(theme: StarterTheme, title: string, kicker: string, sub: string): DeckDetail {
  const now = new Date(0).toISOString();
  return {
    id: `preview-${theme.name}`,
    title,
    themeName: theme.name,
    themeCss: theme.css,
    stage: 'slides',
    storyline: [],
    slides: [
      {
        id: 'preview',
        position: 0,
        layout: 'title',
        html: `<p class="kicker">${escapeHtml(kicker)}</p><h1 class="headline">${escapeHtml(title)}</h1><p class="sub">${escapeHtml(sub)}</p>`,
        notes: '',
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

export function SlidesPage({ onOpenDeck, onStatus }: SlidesPageProps) {
  const t = useT();
  const fmt = useFormatters();
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
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
  }, [refresh]);

  const fail = useCallback(
    (e: unknown) => onStatus?.(e instanceof Error ? e.message : String(e)),
    [onStatus],
  );

  const submit = async () => {
    const theme = allThemes.find((th) => th.name === themeName) ?? STARTER_THEMES[0];
    setBusy(true);
    try {
      const detail = await createDeck(title.trim() || t('slides.new.defaultTitle'), theme.name, theme.css);
      setCreating(false);
      setTitle('');
      onOpenDeck(detail);
      void refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
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

  const previewKicker = t('slides.new.previewKicker');
  const previewSub = t('slides.new.previewSub');
  const previewTitle = title.trim() || t('slides.new.previewTitle');
  const previews = useMemo(
    () => allThemes.map((th) => ({ theme: th, deck: previewDeck(th, previewTitle, previewKicker, previewSub) })),
    [allThemes, previewTitle, previewKicker, previewSub],
  );

  const form = creating && (
    <form
      className="slides-new"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label className="field">
        <span className="field-label">{t('slides.new.titleLabel')}</span>
        <input
          className="slides-new-title"
          type="text"
          value={title}
          maxLength={120}
          autoFocus
          placeholder={t('slides.new.titlePlaceholder')}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <fieldset className="slides-themes">
        <legend className="field-label">{t('slides.new.themeLabel')}</legend>
        <div className="slides-theme-grid">
          {previews.map(({ theme, deck }) => (
            <label key={theme.name} className="slides-theme-card" data-selected={theme.name === themeName ? 'true' : undefined}>
              <input
                className="slides-theme-radio"
                type="radio"
                name="slides-theme"
                value={theme.name}
                checked={theme.name === themeName}
                onChange={() => setThemeName(theme.name)}
              />
              <span className="slides-theme-preview" aria-hidden="true">
                <DeckFrame deck={deck} index={0} mode="stage" colorScheme={theme.dark ? 'dark' : 'light'} />
              </span>
              <span className="slides-theme-name">{theme.label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="slides-new-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {t('slides.new.create')}
        </button>
        <button type="button" className="btn" onClick={() => setCreating(false)}>
          {t('common.actions.cancel')}
        </button>
      </div>
    </form>
  );

  const newButton = (
    <button type="button" className="btn primary" aria-expanded={creating} onClick={() => setCreating((v) => !v)}>
      {t('slides.page.new')}
    </button>
  );

  return (
    <PageFrame title={t('slides.page.title')} subtitle={t('slides.page.subtitle')} actions={newButton} className="slides-page">
      {loadError && (
        <p className="slides-error" role="alert">
          {loadError}
        </p>
      )}
      {form}
      {decks && decks.length === 0 && !loadError && !creating && (
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
