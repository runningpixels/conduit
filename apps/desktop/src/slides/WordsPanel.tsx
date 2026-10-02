/// The Words drawer: find and replace across the deck, then every slide's
/// text slots as editable fields, plus speaker notes. Props-driven; the caller
/// owns every IPC call. Edits are the user's own words, so each committed slot
/// becomes pinned (the caller's `onEditWords` does that on the backend).

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { DeckDetail, DeckReplaceResult, DeckSlide, SlideSlot, SlotEdit } from '../ipc/contracts';
import { cleanInlineHtml } from './deckDocument';

export const WORDS_IDLE_COMMIT_MS = 800;
export const WORDS_DRY_RUN_MS = 300;

export interface WordsFocusRequest {
  slideId: string;
  index: number;
  /** Bump to re-focus the same slot. */
  nonce: number;
}

export interface WordsPanelProps {
  deck: DeckDetail;
  /** Slide id to pixels of overflow, only for slides that overflow. */
  overflow: Record<string, number>;
  /** A slot the user selected on the stage; its field scrolls into view and takes focus. */
  focusRequest?: WordsFocusRequest | null;
  /** Bump to focus the find box (Ctrl+H). */
  findFocusToken?: number;
  onEditWords: (slideId: string, edits: SlotEdit[], notes?: string) => Promise<void>;
  onSetPinned: (slideId: string, index: number, name: string, pinned: boolean) => Promise<void>;
  onReplace: (
    find: string,
    replace: string,
    matchCase: boolean,
    wholeWord: boolean,
    apply: boolean,
  ) => Promise<DeckReplaceResult>;
  onAskToFix?: (prompt: string) => void;
  /** Called when a field takes focus, so the stage can move to that slide. */
  onFocusSlide?: (slideIndex: number) => void;
  onClose: () => void;
}

/** `stat-2` becomes "Stat 2". */
export function humanizeSlotName(name: string): string {
  const spaced = name.replace(/[-_]+/g, ' ').trim();
  return spaced === '' ? name : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function slidesTouched(result: DeckReplaceResult): number {
  return result.slides.filter((s) => s.count + s.notesCount > 0).length;
}

export function WordsPanel({
  deck,
  overflow,
  focusRequest,
  findFocusToken = 0,
  onEditWords,
  onSetPinned,
  onReplace,
  onAskToFix,
  onFocusSlide,
  onClose,
}: WordsPanelProps) {
  const t = useT();
  const rootRef = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!focusRequest) return;
    const key = `${focusRequest.slideId}:${focusRequest.index}`;
    const fields = rootRef.current?.querySelectorAll<HTMLElement>('[data-slot-key]') ?? [];
    const field = Array.from(fields).find((el) => el.getAttribute('data-slot-key') === key);
    if (!field) return;
    field.scrollIntoView?.({ block: 'nearest' });
    field.focus();
  }, [focusRequest]);

  const edit = useCallback(
    async (slideId: string, edits: SlotEdit[], notes?: string) => {
      try {
        if (notes === undefined) await onEditWords(slideId, edits);
        else await onEditWords(slideId, edits, notes);
        setError(null);
      } catch (e) {
        setError(errorText(e));
      }
    },
    [onEditWords],
  );

  const setPinned = async (slideId: string, index: number, name: string, pinned: boolean) => {
    try {
      await onSetPinned(slideId, index, name, pinned);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <aside className="deck-words" aria-label={t('slides.words.title')} ref={rootRef}>
      <header className="deck-words-head">
        <h3 className="deck-words-title">{t('slides.words.title')}</h3>
        <button type="button" className="storyline-icon-btn" aria-label={t('slides.words.close')} onClick={onClose}>
          <span aria-hidden="true">×</span>
        </button>
      </header>
      <FindReplaceBar onReplace={onReplace} focusToken={findFocusToken} />
      {error && (
        <p className="deck-words-error" role="alert">
          {error}
        </p>
      )}
      <div className="deck-words-scroll">
        {deck.slides.length === 0 && <p className="deck-words-empty">{t('slides.words.empty')}</p>}
        {deck.slides.map((slide, i) => (
          <section key={slide.id} className="deck-words-slide" aria-label={t('slides.words.slideHeading', { n: i + 1 })}>
            <h4 className="deck-words-slide-head">
              <span>{t('slides.words.slideHeading', { n: i + 1 })}</span>
              <span className="deck-words-layout">{slide.layout}</span>
            </h4>
            {overflow[slide.id] > 0 && (
              <div className="deck-words-overflow" role="status">
                <span>{t('slides.overflow.warning', { px: overflow[slide.id] })}</span>
                {onAskToFix && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onAskToFix(t('slides.overflow.fixPrompt', { n: i + 1, px: overflow[slide.id] }))}
                  >
                    {t('slides.overflow.ask')}
                  </button>
                )}
              </div>
            )}
            {slide.slots.length === 0 && <p className="deck-words-noslots">{t('slides.words.noSlots')}</p>}
            {slide.slots.map((slot) => (
              <SlotField
                key={`${slot.index}:${slot.name}`}
                slide={slide}
                slideNumber={i + 1}
                slot={slot}
                onCommit={(html) => void edit(slide.id, [{ index: slot.index, name: slot.name, html }])}
                onUnpin={() => void setPinned(slide.id, slot.index, slot.name, false)}
                onFocus={() => onFocusSlide?.(i)}
              />
            ))}
            <NotesField slide={slide} onCommit={(notes) => void edit(slide.id, [], notes)} onFocus={() => onFocusSlide?.(i)} />
          </section>
        ))}
      </div>
    </aside>
  );
}

// ── Find and replace ──────────────────────────────────────────────────────

function FindReplaceBar({
  onReplace,
  focusToken,
}: {
  onReplace: WordsPanelProps['onReplace'];
  focusToken: number;
}) {
  const t = useT();
  const findRef = useRef<HTMLInputElement>(null);
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [preview, setPreview] = useState<DeckReplaceResult | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runId = useRef(0);
  const onReplaceRef = useRef(onReplace);
  onReplaceRef.current = onReplace;

  useEffect(() => {
    if (focusToken === 0) return;
    findRef.current?.focus();
    findRef.current?.select();
  }, [focusToken]);

  // Dry run, debounced: counts only, nothing changes.
  useEffect(() => {
    const id = ++runId.current;
    if (find === '') {
      setPreview(null);
      return;
    }
    const timer = window.setTimeout(() => {
      onReplaceRef
        .current(find, replace, matchCase, wholeWord, false)
        .then((result) => {
          if (runId.current !== id) return;
          setPreview(result);
          setError(null);
        })
        .catch((e: unknown) => {
          if (runId.current !== id) return;
          setPreview(null);
          setError(errorText(e));
        });
    }, WORDS_DRY_RUN_MS);
    return () => window.clearTimeout(timer);
  }, [find, replace, matchCase, wholeWord]);

  const apply = async () => {
    if (find === '' || busy) return;
    setBusy(true);
    runId.current++;
    try {
      const result = await onReplaceRef.current(find, replace, matchCase, wholeWord, true);
      setStatus(t('slides.words.replaced', { count: result.total, slides: slidesTouched(result) }));
      setPreview(null);
      setError(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  let summary: string | null = null;
  if (find !== '' && preview) {
    summary =
      preview.total === 0
        ? t('slides.words.noMatches')
        : t('slides.words.matches', { count: preview.total, slides: slidesTouched(preview) });
  }

  return (
    <form
      className="deck-words-find"
      onSubmit={(e) => {
        e.preventDefault();
        void apply();
      }}
    >
      <input
        ref={findRef}
        className="deck-words-input"
        type="text"
        value={find}
        maxLength={200}
        placeholder={t('slides.words.find')}
        aria-label={t('slides.words.find')}
        onChange={(e) => {
          setFind(e.target.value);
          setStatus(null);
        }}
      />
      <input
        className="deck-words-input"
        type="text"
        value={replace}
        maxLength={200}
        placeholder={t('slides.words.replaceWith')}
        aria-label={t('slides.words.replaceWith')}
        onChange={(e) => {
          setReplace(e.target.value);
          setStatus(null);
        }}
      />
      <div className="deck-words-options">
        <label className="deck-words-check">
          <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
          {t('slides.words.matchCase')}
        </label>
        <label className="deck-words-check">
          <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} />
          {t('slides.words.wholeWord')}
        </label>
        <button type="submit" className="btn primary" disabled={busy || find === '' || preview?.total === 0}>
          {t('slides.words.replaceAll')}
        </button>
      </div>
      {error ? (
        <p className="deck-words-result deck-words-result-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="deck-words-result" role="status">
          {status ?? summary ?? ''}
        </p>
      )}
    </form>
  );
}

// ── Fields ────────────────────────────────────────────────────────────────

function SlotField({
  slide,
  slideNumber,
  slot,
  onCommit,
  onUnpin,
  onFocus,
}: {
  slide: DeckSlide;
  slideNumber: number;
  slot: SlideSlot;
  onCommit: (html: string) => void;
  onUnpin: () => void;
  onFocus: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ slot, onCommit });
  latest.current = { slot, onCommit };
  const label = humanizeSlotName(slot.name);

  // Mirror the deck's value into the editor, unless the user is mid-edit here.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || dirty.current || document.activeElement === el) return;
    if (el.innerHTML !== slot.html) el.innerHTML = slot.html;
  }, [slot.html]);

  const commit = useCallback(() => {
    window.clearTimeout(timer.current);
    const el = ref.current;
    if (!el || !dirty.current) return;
    dirty.current = false;
    const html = cleanInlineHtml(el.innerHTML);
    if (html === cleanInlineHtml(latest.current.slot.html)) return;
    latest.current.onCommit(html);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <div className="deck-words-field" data-pinned={slot.pinned ? 'true' : undefined}>
      <div className="deck-words-field-head">
        <span className="deck-words-field-label">{label}</span>
        {slot.pinned && (
          <span className="deck-words-pinned">
            <span className="deck-words-chip" title={t('slides.words.yoursHint')}>
              {t('slides.words.yours')}
            </span>
            <button type="button" className="deck-words-unpin" onClick={onUnpin}>
              {t('slides.words.letAiEdit')}
            </button>
          </span>
        )}
      </div>
      <div
        ref={ref}
        className="deck-words-editor"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={t('slides.words.fieldAria', { slot: label, n: slideNumber })}
        data-slot-key={`${slide.id}:${slot.index}`}
        onFocus={onFocus}
        onInput={() => {
          dirty.current = true;
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(commit, WORDS_IDLE_COMMIT_MS);
        }}
        onBlur={commit}
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) e.currentTarget.blur();
            else document.execCommand('insertLineBreak');
          } else if (e.key === 'Escape') {
            e.preventDefault();
            dirty.current = false;
            e.currentTarget.innerHTML = slot.html;
            e.currentTarget.blur();
          }
        }}
      />
    </div>
  );
}

function NotesField({
  slide,
  onCommit,
  onFocus,
}: {
  slide: DeckSlide;
  onCommit: (notes: string) => void;
  onFocus: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(slide.notes);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(slide.notes);
  }, [slide.notes]);

  return (
    <label className="deck-words-field">
      <span className="deck-words-field-label">{t('slides.words.notes')}</span>
      <textarea
        className="deck-words-notes"
        rows={2}
        value={draft}
        maxLength={10000}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => {
          focused.current = true;
          onFocus();
        }}
        onBlur={() => {
          focused.current = false;
          if (draft !== slide.notes) onCommit(draft);
        }}
      />
    </label>
  );
}
