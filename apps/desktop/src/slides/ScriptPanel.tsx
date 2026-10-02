/// The Script drawer: the deck's words laid out like a formatted document
/// (headings, bullets, a divider per slide) instead of a form of labelled
/// fields. Every line is still bound to its slot, so pins, history and the AI's
/// rules are unchanged. Props-driven; the caller owns every IPC call. Edits are
/// the user's own words, so each committed slot becomes pinned (the caller's
/// `onEditWords` does that on the backend).

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import type { DeckDetail, DeckReplaceResult, DeckSlide, SlideSlot, SlotEdit } from '../ipc/contracts';
import { cleanInlineHtml } from './deckDocument';
import { deckToMarkdown } from './deckMarkdown';
import { groupSlots, type BlockKind } from './scriptBlocks';

export const SCRIPT_IDLE_COMMIT_MS = 800;
export const SCRIPT_DRY_RUN_MS = 300;
const COPIED_FLASH_MS = 2000;

export interface ScriptFocusRequest {
  slideId: string;
  index: number;
  /** Bump to re-focus the same slot. */
  nonce: number;
}

export interface ScriptPanelProps {
  deck: DeckDetail;
  /** Slide id to pixels of overflow, only for slides that overflow. */
  overflow: Record<string, number>;
  /** A slot the user selected on the stage; its block scrolls into view and takes focus. */
  focusRequest?: ScriptFocusRequest | null;
  /** Bump to open the find bar and focus it (Ctrl+H). */
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
  /** Adds a bullet after this one; resolves the new slot's name (focused once the deck shows it). */
  onInsertBullet?: (slideId: string, index: number, name: string) => Promise<string | null>;
  onRemoveBullet?: (slideId: string, index: number, name: string) => Promise<void>;
  onAskToFix?: (prompt: string) => void;
  /** Called when a block takes focus, so the stage can move to that slide. */
  onFocusSlide?: (slideIndex: number) => void;
  onClose: () => void;
}

/** `stat-2` becomes "Stat 2". Used for accessible names; never shown as a label. */
export function humanizeSlotName(name: string): string {
  const spaced = name.replace(/[-_]+/g, ' ').trim();
  return spaced === '' ? name : spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function slidesTouched(result: DeckReplaceResult): number {
  return result.slides.filter((s) => s.count + s.notesCount > 0).length;
}

// ── Caret helpers ─────────────────────────────────────────────────────────

function caretRange(el: HTMLElement): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return el.contains(range.startContainer) ? range : null;
}

function hasBreak(frag: DocumentFragment): boolean {
  return (frag.textContent ?? '') !== '' || frag.querySelector('br') != null;
}

/** True when nothing (no text, no line break) follows the caret. No selection counts as the end. */
function caretAtEnd(el: HTMLElement): boolean {
  const range = caretRange(el);
  if (!range) return true;
  if (!range.collapsed) return false;
  const tail = document.createRange();
  tail.selectNodeContents(el);
  tail.setStart(range.endContainer, range.endOffset);
  return !hasBreak(tail.cloneContents());
}

/** Is the caret on the first (up) or last (down) visual line of the block? */
function caretOnEdgeLine(el: HTMLElement, dir: 'up' | 'down'): boolean {
  const range = caretRange(el);
  if (!range) return true;
  if (!range.collapsed) return false;
  const rect = range.getClientRects?.()[0];
  const box = el.getBoundingClientRect();
  if (rect && box.height > 0) {
    const line = parseFloat(getComputedStyle(el).lineHeight) || rect.height || 20;
    return dir === 'up' ? rect.top - box.top < line : box.bottom - rect.bottom < line;
  }
  // No layout (or a caret with no rect): fall back to explicit line breaks.
  const side = document.createRange();
  side.selectNodeContents(el);
  if (dir === 'up') side.setEnd(range.startContainer, range.startOffset);
  else side.setStart(range.endContainer, range.endOffset);
  return side.cloneContents().querySelector('br') == null;
}

function setCaret(el: HTMLElement, atEnd: boolean) {
  el.focus();
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(!atEnd);
  sel.removeAllRanges();
  sel.addRange(range);
}

// ── Panel ─────────────────────────────────────────────────────────────────

export function ScriptPanel({
  deck,
  overflow,
  focusRequest,
  findFocusToken = 0,
  onEditWords,
  onSetPinned,
  onReplace,
  onInsertBullet,
  onRemoveBullet,
  onAskToFix,
  onFocusSlide,
  onClose,
}: ScriptPanelProps) {
  const t = useT();
  const rootRef = useRef<HTMLElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(findFocusToken > 0);
  const [findToken, setFindToken] = useState(findFocusToken);
  const [copy, setCopy] = useState<{ state: 'idle' } | { state: 'copied' } | { state: 'failed'; message: string }>({
    state: 'idle',
  });
  const copyTimer = useRef<number | undefined>(undefined);
  const pendingFocus = useRef<{ slideId: string; name: string } | null>(null);
  const [pendingTick, setPendingTick] = useState(0);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  useEffect(() => {
    if (findFocusToken === 0) return;
    setFindOpen(true);
    setFindToken(findFocusToken);
  }, [findFocusToken]);

  const editors = () => Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[data-slot-key]') ?? []);

  useEffect(() => {
    if (!focusRequest) return;
    const key = `${focusRequest.slideId}:${focusRequest.index}`;
    const field = editors().find((el) => el.getAttribute('data-slot-key') === key);
    if (!field) return;
    field.scrollIntoView?.({ block: 'nearest' });
    field.focus();
  }, [focusRequest]);

  // After "Enter" adds a bullet, focus it as soon as the deck shows it.
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    const slide = deck.slides.find((s) => s.id === pending.slideId);
    const slot = slide?.slots.find((s) => s.name === pending.name);
    if (!slide || !slot) return;
    const el = editors().find((e) => e.getAttribute('data-slot-key') === `${slide.id}:${slot.index}`);
    if (!el) return;
    pendingFocus.current = null;
    el.scrollIntoView?.({ block: 'nearest' });
    setCaret(el, false);
  }, [deck, pendingTick]);

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

  const insertBullet = async (slide: DeckSlide, slot: SlideSlot) => {
    if (!onInsertBullet) return;
    try {
      const name = await onInsertBullet(slide.id, slot.index, slot.name);
      setError(null);
      if (name) {
        pendingFocus.current = { slideId: slide.id, name };
        setPendingTick((n) => n + 1);
      }
    } catch (e) {
      setError(errorText(e));
    }
  };

  const move = (from: HTMLElement, dir: 'up' | 'down'): HTMLElement | null => {
    const all = editors();
    const at = all.indexOf(from);
    return all[at + (dir === 'up' ? -1 : 1)] ?? null;
  };

  const navigate = (from: HTMLElement, dir: 'up' | 'down') => {
    const target = move(from, dir);
    if (!target) return;
    target.scrollIntoView?.({ block: 'nearest' });
    setCaret(target, dir === 'up');
  };

  const removeBullet = async (slide: DeckSlide, slot: SlideSlot, from: HTMLElement) => {
    if (!onRemoveBullet) return;
    const previous = move(from, 'up');
    try {
      await onRemoveBullet(slide.id, slot.index, slot.name);
      setError(null);
      if (previous) setCaret(previous, true);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const copyMarkdown = () => {
    window.clearTimeout(copyTimer.current);
    let written: Promise<void>;
    try {
      written = navigator.clipboard.writeText(deckToMarkdown(deck));
    } catch (e) {
      written = Promise.reject(e);
    }
    written.then(
      () => {
        setCopy({ state: 'copied' });
        copyTimer.current = window.setTimeout(() => setCopy({ state: 'idle' }), COPIED_FLASH_MS);
      },
      (e: unknown) => setCopy({ state: 'failed', message: errorText(e) }),
    );
  };

  const blockProps = (slide: DeckSlide, slideIndex: number) => ({
    slide,
    slideNumber: slideIndex + 1,
    onCommit: (slot: SlideSlot, html: string) => edit(slide.id, [{ index: slot.index, name: slot.name, html }]),
    onUnpin: (slot: SlideSlot) => void setPinned(slide.id, slot.index, slot.name, false),
    onFocus: () => onFocusSlide?.(slideIndex),
    onEnterInBullet: onInsertBullet ? (slot: SlideSlot) => insertBullet(slide, slot) : undefined,
    onBackspaceInEmptyBullet: onRemoveBullet
      ? (slot: SlideSlot, el: HTMLElement) => void removeBullet(slide, slot, el)
      : undefined,
    onNavigate: navigate,
  });

  return (
    <aside className="deck-script" aria-label={t('slides.script.title')} ref={rootRef}>
      <header className="deck-script-head">
        <h3 className="deck-script-title">{t('slides.script.title')}</h3>
        <div className="deck-script-actions">
          <button type="button" className="deck-script-copy" onClick={copyMarkdown}>
            {copy.state === 'copied' ? t('slides.script.copied') : t('slides.script.copyMarkdown')}
          </button>
          <button
            type="button"
            className="storyline-icon-btn"
            aria-label={t('slides.script.findToggle')}
            aria-pressed={findOpen}
            title={t('slides.script.findToggle')}
            onClick={() => {
              setFindOpen((open) => !open);
              setFindToken((n) => n + 1);
            }}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <path d="m10.5 10.5 3.5 3.5" strokeLinecap="round" />
            </svg>
          </button>
          <button type="button" className="storyline-icon-btn" aria-label={t('slides.script.close')} onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
      </header>
      {copy.state === 'failed' && (
        <p className="deck-script-error" role="alert">
          {t('slides.script.copyFailed', { error: copy.message })}
        </p>
      )}
      {findOpen && <FindReplaceBar onReplace={onReplace} focusToken={findToken} onDismiss={() => setFindOpen(false)} />}
      {error && (
        <p className="deck-script-error" role="alert">
          {error}
        </p>
      )}
      <div className="deck-script-scroll">
        <div className="deck-script-doc">
          {deck.slides.length === 0 && <p className="deck-script-empty">{t('slides.script.empty')}</p>}
          {deck.slides.map((slide, i) => {
            const shared = blockProps(slide, i);
            const items = groupSlots(slide.slots);
            const px = overflow[slide.id];
            return (
              <section
                key={slide.id}
                className="deck-script-slide"
                aria-label={t('slides.script.slideHeading', { n: i + 1 })}
              >
                <div className="deck-script-slide-head">
                  <h4 className="deck-script-slide-title">
                    <button type="button" className="deck-script-slide-jump" onClick={() => onFocusSlide?.(i)}>
                      <span>{t('slides.script.slideHeading', { n: i + 1 })}</span>
                      <span className="deck-script-layout">{slide.layout}</span>
                    </button>
                  </h4>
                  {px > 0 && (
                    <div className="deck-script-overflow" role="status">
                      <span>{t('slides.overflow.warning', { px })}</span>
                      {onAskToFix && (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => onAskToFix(t('slides.overflow.fixPrompt', { n: i + 1, px }))}
                        >
                          {t('slides.overflow.ask')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                {slide.slots.length === 0 && <p className="deck-script-noslots">{t('slides.script.noSlots')}</p>}
                {items.map((item) => {
                  if (item.type === 'list') {
                    return (
                      <ul key={`list-${item.slots[0].index}`} className="deck-script-list">
                        {item.slots.map((slot) => (
                          <Block key={`${slot.index}:${slot.name}`} {...shared} slot={slot} kind="bullet" />
                        ))}
                      </ul>
                    );
                  }
                  if (item.type === 'figure') {
                    return (
                      <div key={`fig-${item.value.index}`} className="deck-script-figure">
                        <Block {...shared} slot={item.value} kind="figure" />
                        {item.caption && <Block {...shared} slot={item.caption} kind="caption" />}
                      </div>
                    );
                  }
                  return <Block key={`${item.slot.index}:${item.slot.name}`} {...shared} slot={item.slot} kind={item.kind} />;
                })}
                <NotesField slide={slide} onCommit={(notes) => void edit(slide.id, [], notes)} onFocus={() => onFocusSlide?.(i)} />
              </section>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

// ── Find and replace ──────────────────────────────────────────────────────

function FindReplaceBar({
  onReplace,
  focusToken,
  onDismiss,
}: {
  onReplace: ScriptPanelProps['onReplace'];
  focusToken: number;
  onDismiss: () => void;
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
    }, SCRIPT_DRY_RUN_MS);
    return () => window.clearTimeout(timer);
  }, [find, replace, matchCase, wholeWord]);

  const apply = async () => {
    if (find === '' || busy) return;
    setBusy(true);
    runId.current++;
    try {
      const result = await onReplaceRef.current(find, replace, matchCase, wholeWord, true);
      setStatus(t('slides.script.replaced', { count: result.total, slides: slidesTouched(result) }));
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
        ? t('slides.script.noMatches')
        : t('slides.script.matches', { count: preview.total, slides: slidesTouched(preview) });
  }

  return (
    <form
      className="deck-script-find"
      onSubmit={(e) => {
        e.preventDefault();
        void apply();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onDismiss();
        }
      }}
    >
      <input
        ref={findRef}
        className="deck-script-input"
        type="text"
        value={find}
        maxLength={200}
        placeholder={t('slides.script.find')}
        aria-label={t('slides.script.find')}
        onChange={(e) => {
          setFind(e.target.value);
          setStatus(null);
        }}
      />
      <input
        className="deck-script-input"
        type="text"
        value={replace}
        maxLength={200}
        placeholder={t('slides.script.replaceWith')}
        aria-label={t('slides.script.replaceWith')}
        onChange={(e) => {
          setReplace(e.target.value);
          setStatus(null);
        }}
      />
      <div className="deck-script-options">
        <label className="deck-script-check">
          <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} />
          {t('slides.script.matchCase')}
        </label>
        <label className="deck-script-check">
          <input type="checkbox" checked={wholeWord} onChange={(e) => setWholeWord(e.target.checked)} />
          {t('slides.script.wholeWord')}
        </label>
        <button type="submit" className="btn primary" disabled={busy || find === '' || preview?.total === 0}>
          {t('slides.script.replaceAll')}
        </button>
      </div>
      {error ? (
        <p className="deck-script-result deck-script-result-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="deck-script-result" role="status">
          {status ?? summary ?? ''}
        </p>
      )}
    </form>
  );
}

// ── Blocks ────────────────────────────────────────────────────────────────

interface BlockProps {
  slide: DeckSlide;
  slideNumber: number;
  slot: SlideSlot;
  kind: BlockKind | 'caption';
  onCommit: (slot: SlideSlot, html: string) => Promise<void>;
  onUnpin: (slot: SlideSlot) => void;
  onFocus: () => void;
  onEnterInBullet?: (slot: SlideSlot) => Promise<void>;
  onBackspaceInEmptyBullet?: (slot: SlideSlot, el: HTMLElement) => void;
  onNavigate: (from: HTMLElement, dir: 'up' | 'down') => void;
}

function Block({
  slide,
  slideNumber,
  slot,
  kind,
  onCommit,
  onUnpin,
  onFocus,
  onEnterInBullet,
  onBackspaceInEmptyBullet,
  onNavigate,
}: BlockProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const latest = useRef({ slot, onCommit });
  latest.current = { slot, onCommit };

  // Mirror the deck's value into the editor, unless the user is mid-edit here.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || dirty.current || document.activeElement === el) return;
    if (el.innerHTML !== slot.html) el.innerHTML = slot.html;
  }, [slot.html]);

  const commit = useCallback(async () => {
    window.clearTimeout(timer.current);
    const el = ref.current;
    if (!el || !dirty.current) return;
    dirty.current = false;
    const html = cleanInlineHtml(el.innerHTML);
    if (html === cleanInlineHtml(latest.current.slot.html)) return;
    await latest.current.onCommit(latest.current.slot, html);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const Wrapper = kind === 'bullet' ? 'li' : 'div';
  const pinNote: ReactNode = slot.pinned ? (
    <span className="deck-script-pin">
      <span className="deck-script-pin-note">{t('slides.script.yoursHint')}</span>
      <button type="button" className="deck-script-unpin" onClick={() => onUnpin(slot)}>
        {t('slides.script.letAiEdit')}
      </button>
    </span>
  ) : null;

  return (
    <Wrapper className="deck-script-block" data-kind={kind} data-pinned={slot.pinned ? 'true' : undefined}>
      <div
        ref={ref}
        className="deck-script-editor"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        title={slot.name}
        aria-label={t('slides.script.fieldAria', { slot: humanizeSlotName(slot.name), n: slideNumber })}
        data-slot-key={`${slide.id}:${slot.index}`}
        onFocus={onFocus}
        onInput={() => {
          dirty.current = true;
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => void commit(), SCRIPT_IDLE_COMMIT_MS);
        }}
        onBlur={() => void commit()}
        onPaste={(e) => {
          e.preventDefault();
          document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
        }}
        onKeyDown={(e) => {
          const el = e.currentTarget;
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) el.blur();
            else if (kind === 'bullet' && onEnterInBullet && caretAtEnd(el)) {
              // Save what was typed first so the new bullet follows the saved one.
              void commit().then(() => onEnterInBullet(slot));
            } else document.execCommand('insertLineBreak');
          } else if (e.key === 'Backspace') {
            if (kind === 'bullet' && onBackspaceInEmptyBullet && el.textContent === '' && !el.querySelector('br')) {
              e.preventDefault();
              onBackspaceInEmptyBullet(slot, el);
            }
          } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
            const dir = e.key === 'ArrowUp' ? 'up' : 'down';
            if (caretOnEdgeLine(el, dir)) {
              e.preventDefault();
              onNavigate(el, dir);
            }
          } else if (e.key === 'Escape') {
            e.preventDefault();
            dirty.current = false;
            el.innerHTML = slot.html;
            el.blur();
          }
        }}
      />
      {pinNote}
    </Wrapper>
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
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(slide.notes);
  const focused = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(slide.notes);
  }, [slide.notes]);

  return (
    <div className="deck-script-notes" data-open={open ? 'true' : undefined}>
      <button
        type="button"
        className="deck-script-notes-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="deck-script-notes-label">{t('slides.script.notes')}</span>
        {!open && slide.notes.trim() !== '' && <span className="deck-script-notes-preview" title={slide.notes}>{slide.notes}</span>}
      </button>
      {open && (
        <textarea
          className="deck-script-notes-field"
          rows={2}
          value={draft}
          maxLength={10000}
          aria-label={t('slides.script.notesAria')}
          autoFocus
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
      )}
    </div>
  );
}
