/// Writing: start a draft from a brief, and your drafts.
///
/// A draft is written in a studio: you describe the piece, the model proposes
/// an outline, you approve it, and the draft is written section by section in
/// an editor you can type in. This page starts new drafts and lists the
/// existing ones; opening one hands it to the shell, which opens the studio.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@conduit/ui';
import { useT } from '../i18n';
import { useFormatters } from '../i18n/formatters';
import { PageEmpty, PageFrame } from '../shell/PageFrame';
import { deleteDraft, listDrafts, renameDraft } from '../ipc/client';
import type { DraftSummary } from '../ipc/contracts';

export interface WritingPageProps {
  onOpenDraft: (draftId: string) => void;
  /** Start a draft from a brief. The shell creates it, opens the studio and
   *  sends the brief as the draft chat's first message. */
  onStartDraft: (brief: string) => Promise<void>;
  onStatus?: (message: string) => void;
}

/** Starter chips: the label and the brief template they put in the box. */
export const WRITING_STARTERS: ReadonlyArray<{ id: string; labelId: string; templateId: string }> = [
  { id: 'blog', labelId: 'writing.start.chip.blog', templateId: 'writing.start.template.blog' },
  { id: 'technical', labelId: 'writing.start.chip.technical', templateId: 'writing.start.template.technical' },
  { id: 'report', labelId: 'writing.start.chip.report', templateId: 'writing.start.template.report' },
  { id: 'newsletter', labelId: 'writing.start.chip.newsletter', templateId: 'writing.start.template.newsletter' },
  { id: 'essay', labelId: 'writing.start.chip.essay', templateId: 'writing.start.template.essay' },
];

export function WritingPage({ onOpenDraft, onStartDraft, onStatus }: WritingPageProps) {
  const t = useT();
  const fmt = useFormatters();
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [brief, setBrief] = useState('');
  const briefRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState<DraftSummary | null>(null);

  const refresh = useCallback(async () => {
    try {
      setDrafts(await listDrafts());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
      setDrafts([]);
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
    const text = brief.trim();
    if (text === '' || busy) return;
    setBusy(true);
    try {
      await onStartDraft(text);
      setBrief('');
      void refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  // A chip fills an empty box with its template; with text already there it
  // adds the template below, so nothing typed is lost.
  const insertTemplate = (template: string) => {
    setBrief((current) => (current.trim() === '' ? template : `${current.trimEnd()}\n\n${template}`));
    briefRef.current?.focus();
  };

  const commitRename = async () => {
    const target = renaming;
    setRenaming(null);
    const next = target?.text.trim();
    if (!target || !next) return;
    const draft = drafts?.find((d) => d.id === target.id);
    if (!draft || draft.title === next) return;
    try {
      await renameDraft(target.id, next);
      await refresh();
    } catch (e) {
      fail(e);
    }
  };

  const confirmDelete = async () => {
    const draft = deleting;
    setDeleting(null);
    if (!draft) return;
    try {
      await deleteDraft(draft.id);
      onStatus?.(t('writing.status.deleted', { title: draft.title }));
      await refresh();
    } catch (e) {
      fail(e);
    }
  };

  return (
    <PageFrame title={t('writing.page.title')} subtitle={t('writing.page.subtitle')} className="writing-page">
      {loadError && (
        <p className="slides-error" role="alert">
          {loadError}
        </p>
      )}
      <form
        className="slides-start"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          <span className="slides-start-label">{t('writing.start.label')}</span>
          <textarea
            ref={briefRef}
            className="slides-start-input"
            value={brief}
            rows={5}
            placeholder={t('writing.start.placeholder')}
            onChange={(e) => setBrief(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </label>
        <div className="slides-start-foot">
          <div className="slides-start-chips" role="group" aria-label={t('writing.start.chipsAria')}>
            {WRITING_STARTERS.map((starter) => (
              <button
                key={starter.id}
                type="button"
                className="slides-start-chip"
                onClick={() => insertTemplate(t(starter.templateId))}
              >
                {t(starter.labelId)}
              </button>
            ))}
          </div>
          <button type="submit" className="btn primary" disabled={busy || brief.trim() === ''}>
            {t('writing.start.submit')}
          </button>
        </div>
      </form>
      {drafts && drafts.length === 0 && !loadError && (
        <PageEmpty title={t('writing.page.emptyTitle')} body={t('writing.page.emptyBody')} />
      )}
      {drafts && drafts.length > 0 && (
        <ul className="slides-grid" aria-label={t('writing.page.listAria')}>
          {drafts.map((draft) => (
            <li key={draft.id} className="deck-card">
              {renaming && renaming.id === draft.id ? (
                <input
                  className="deck-card-rename"
                  type="text"
                  value={renaming.text}
                  maxLength={120}
                  autoFocus
                  aria-label={t('writing.card.renameAria', { title: draft.title })}
                  onChange={(e) => setRenaming({ id: draft.id, text: e.target.value })}
                  onBlur={() => void commitRename()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur();
                    else if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              ) : (
                <span className="deck-card-title" title={draft.title}>
                  {draft.title}
                </span>
              )}
              <span className="deck-card-meta">
                {draft.stage === 'outline'
                  ? t('writing.card.outlining')
                  : t('writing.card.words', { count: draft.words })}
              </span>
              <span className="deck-card-meta">{t('writing.card.updated', { when: fmt.timeAgo(draft.updatedAt) })}</span>
              <div className="deck-card-foot">
                <button
                  type="button"
                  className="btn deck-card-open"
                  aria-label={t('writing.card.openAria', { title: draft.title })}
                  onClick={() => onOpenDraft(draft.id)}
                >
                  {t('writing.card.open')}
                </button>
                <button
                  type="button"
                  className="btn"
                  aria-label={t('writing.card.renameButtonAria', { title: draft.title })}
                  onClick={() => setRenaming({ id: draft.id, text: draft.title })}
                >
                  {t('writing.card.rename')}
                </button>
                <button
                  type="button"
                  className="btn danger"
                  aria-label={t('writing.card.deleteAria', { title: draft.title })}
                  onClick={() => setDeleting(draft)}
                >
                  {t('writing.card.delete')}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={deleting != null}
        title={t('writing.delete.title', { title: deleting?.title ?? '' })}
        description={t('writing.delete.description')}
        confirmLabel={t('writing.delete.confirm')}
        cancelLabel={t('common.actions.cancel')}
        onCancel={() => setDeleting(null)}
        onConfirm={() => void confirmDelete()}
      />
    </PageFrame>
  );
}
