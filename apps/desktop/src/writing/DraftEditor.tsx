/// The draft's editor: the Markdown itself, in CodeMirror 6.
///
/// - Edits save 800 ms after typing stops (`save_draft_markdown`). The reply
///   carries the backend's block split; it replaces the local ranges without
///   touching the text, and anything typed while the save was out is mapped
///   on top, so the caret never jumps.
/// - Text that changes elsewhere (the assistant writes a section, a version is
///   restored) comes in as one minimal change, so the caret stays put.
/// - Pinned blocks (the user's own text) carry a gutter bar; clicking it
///   offers "Let AI edit". AI-written blocks are faintly tinted when the
///   studio's "Show AI-written text" is on.
/// - While the assistant is running the editor is read-only, with a note.
///   A section it is still writing shows as a preview (dimmed, labelled
///   "Writing…"); the preview is display only and is never saved.
/// - Selecting text shows the selection toolbar.

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChangeSet, Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap, placeholder as placeholderText, type ViewUpdate } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
import { useT } from '../i18n';
import type { DraftBlock, DraftDetail } from '../ipc/contracts';
import {
  aiTint,
  blocksField,
  blocksInRange,
  codeBlockLines,
  externalSync,
  mapBlocks,
  minimalChange,
  pinGutter,
  setBlocksEffect,
  toEditorBlocks,
  type EditorBlock,
} from './editorBlocks';
import { previewField, setPreviewEffect } from './previewDecorations';
import type { DraftPreview } from './sectionPreview';
import { SelectionToolbar } from './SelectionToolbar';
import type { SelectionAction, SelectionRequest } from './selectionMessage';

export const DRAFT_SAVE_DELAY_MS = 800;

export interface DraftEditorProps {
  draft: DraftDetail;
  /** The assistant is running a turn in the draft's chat: no typing. */
  readOnly: boolean;
  /** Tint the blocks the AI wrote ("Show AI-written text"). */
  showAiText: boolean;
  /** Bumps when the draft was replaced from outside (a restore): unsaved
   *  typing is dropped and the editor takes the draft as it is. */
  resetToken?: number;
  /** Save the user's text; resolves the draft as the backend now has it. */
  onSave: (markdown: string) => Promise<DraftDetail | null>;
  /** "Let AI edit": release a pinned block. */
  onUnpin: (blockId: string) => void;
  /** A selection-toolbar action: the studio sends it to the chat. */
  onSelectionRequest: (request: SelectionRequest) => void;
  /** Sections the assistant is writing right now, shown in place (read-only turns only). */
  preview?: DraftPreview | null;
  /** For tests. */
  saveDelayMs?: number;
}

type SaveState = 'saved' | 'pending' | 'saving' | 'error';

const draftHighlight = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: '700', fontSize: 'var(--fs-7xl)' },
  { tag: tags.heading2, fontWeight: '700', fontSize: 'var(--fs-10xl)' },
  { tag: tags.heading3, fontWeight: '700', fontSize: 'var(--fs-9xl)' },
  { tag: [tags.heading4, tags.heading5, tags.heading6], fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--accent-text)' },
  { tag: tags.url, color: 'var(--ink-3)' },
  { tag: tags.quote, color: 'var(--ink-2)' },
  { tag: tags.monospace, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-4xl)' },
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: 'var(--ink-3)' },
]);

const draftTheme = EditorView.theme({
  '&': { height: '100%', color: 'var(--ink)', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-prose)', lineHeight: '1.75' },
  '.cm-content': { padding: 'var(--sp-6) 0 var(--sp-6)', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 var(--sp-4) 0 var(--sp-3)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
  '.cm-placeholder': { color: 'var(--ink-3)' },
});

/** Pinned blocks among those a range touches. */
function pinnedIn(blocks: readonly EditorBlock[]): string[] {
  return blocks.filter((b) => b.pinned).map((b) => b.id);
}

interface SyncState {
  /** The text the backend has, as far as the editor knows. */
  lastSynced: string;
  timer: ReturnType<typeof setTimeout> | null;
  /** A save on its way: the text sent, and every change typed since. */
  inflight: { text: string; changes: ChangeSet; done: Promise<void> } | null;
  /** Save again when the one in flight returns. */
  queued: boolean;
  /** Bumped by a reset; a save reply from before it is ignored. */
  generation: number;
  /** The editor shows a preview, not the draft: nothing may be saved. */
  previewing: boolean;
}

export function DraftEditor({
  draft,
  readOnly,
  showAiText,
  resetToken = 0,
  onSave,
  onUnpin,
  onSelectionRequest,
  preview = null,
  saveDelayMs = DRAFT_SAVE_DELAY_MS,
}: DraftEditorProps) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const tint = useRef(new Compartment());
  const editable = useRef(new Compartment());
  const sync = useRef<SyncState>({
    lastSynced: draft.markdown,
    timer: null,
    inflight: null,
    queued: false,
    generation: 0,
    previewing: false,
  });
  const callbacks = useRef({ onSave, onUnpin, onSelectionRequest, readOnly, saveDelayMs });
  callbacks.current = { onSave, onUnpin, onSelectionRequest, readOnly, saveDelayMs };
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [selection, setSelection] = useState<{ from: number; to: number; top: number; left: number; pinned: boolean } | null>(null);
  const [pinPopover, setPinPopover] = useState<{ blockId: string; top: number; left: number } | null>(null);
  const [caretPinned, setCaretPinned] = useState<string | null>(null);
  const dismissedRef = useRef<string | null>(null);

  /** Take the backend's text and blocks as one minimal change (the caret maps through it). */
  const applyExternal = useCallback((markdownText: string, blocks: readonly DraftBlock[]) => {
    const view = viewRef.current;
    if (!view) return;
    const change = minimalChange(view.state.doc.toString(), markdownText);
    view.dispatch({
      changes: change ?? undefined,
      effects: setBlocksEffect.of(toEditorBlocks(blocks, markdownText.length)),
      annotations: externalSync.of(true),
    });
  }, []);

  /** Save now (if anything changed); resolves once the backend has answered. */
  const flush = useCallback((): Promise<void> => {
    const s = sync.current;
    if (s.timer != null) {
      clearTimeout(s.timer);
      s.timer = null;
    }
    const view = viewRef.current;
    // Preview text is the assistant's work in progress, never the user's.
    if (!view || s.previewing) return Promise.resolve();
    if (s.inflight) {
      s.queued = true;
      return s.inflight.done;
    }
    const text = view.state.doc.toString();
    if (text === s.lastSynced) {
      setSaveState('saved');
      return Promise.resolve();
    }
    const generation = s.generation;
    setSaveState('saving');
    const done = callbacks.current
      .onSave(text)
      .then(
        (detail) => {
          const inflight = s.inflight;
          s.inflight = null;
          if (generation !== s.generation || !inflight) return;
          const current = viewRef.current;
          if (detail && current) {
            s.lastSynced = detail.markdown;
            if (detail.markdown === inflight.text) {
              // The backend kept the text as sent: take its blocks, moved
              // through whatever was typed while the save was out.
              const blocks = mapBlocks(toEditorBlocks(detail.blocks, inflight.text.length), inflight.changes);
              current.dispatch({ effects: setBlocksEffect.of(blocks) });
            } else if (current.state.doc.toString() === inflight.text) {
              // It normalised the text (line endings, a trailing newline).
              applyExternal(detail.markdown, detail.blocks);
            }
          }
          if (s.queued) {
            s.queued = false;
            void flush();
          } else {
            setSaveState(s.timer != null ? 'pending' : 'saved');
          }
        },
        () => {
          s.inflight = null;
          s.queued = false;
          if (generation === s.generation) setSaveState('error');
        },
      );
    s.inflight = { text, changes: ChangeSet.empty(text.length), done };
    return done;
  }, [applyExternal]);

  const refreshSelectionUi = useCallback((view: EditorView) => {
    const sel = view.state.selection.main;
    const blocks = view.state.field(blocksField);
    const here = blocksInRange(blocks, sel.head, sel.head).find((b) => b.pinned);
    setCaretPinned(here?.id ?? null);
    const key = `${sel.from}-${sel.to}`;
    if (sel.empty || callbacks.current.readOnly || dismissedRef.current === key) {
      setSelection(null);
      return;
    }
    dismissedRef.current = null;
    let top = 0;
    let left = 0;
    try {
      const coords = view.coordsAtPos(sel.from);
      const frame = frameRef.current?.getBoundingClientRect();
      if (coords && frame) {
        top = Math.max(0, coords.top - frame.top - 48);
        left = Math.max(0, coords.left - frame.left);
      }
    } catch {
      // No layout (tests, a hidden tab): the bar sits at the top.
    }
    setSelection({ from: sel.from, to: sel.to, top, left, pinned: pinnedIn(blocksInRange(blocks, sel.from, sel.to)).length > 0 });
  }, []);

  // Create the editor once per mounted draft (the studio keys it by draft id).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const onUpdate = (update: ViewUpdate) => {
      const s = sync.current;
      if (update.docChanged) {
        for (const tr of update.transactions) {
          if (tr.docChanged && s.inflight) s.inflight.changes = s.inflight.changes.compose(tr.changes);
        }
        const typed = update.transactions.some((tr) => tr.docChanged && !tr.annotation(externalSync));
        if (typed) {
          if (s.timer != null) clearTimeout(s.timer);
          s.timer = setTimeout(() => {
            s.timer = null;
            void flush();
          }, callbacks.current.saveDelayMs);
          setSaveState('pending');
          setPinPopover(null);
        }
      }
      const blocksChanged = update.startState.field(blocksField) !== update.state.field(blocksField);
      if (update.selectionSet || update.docChanged || blocksChanged) refreshSelectionUi(update.view);
    };
    const extensions: Extension[] = [
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      syntaxHighlighting(draftHighlight),
      EditorView.lineWrapping,
      blocksField.init(() => toEditorBlocks(draft.blocks, draft.markdown.length)),
      codeBlockLines,
      previewField,
      tint.current.of(showAiText ? aiTint : []),
      editable.current.of([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]),
      pinGutter({
        title: t('writing.pin.tooltip'),
        onPinClick: (block, rect) => {
          const frame = frameRef.current?.getBoundingClientRect();
          setPinPopover({
            blockId: block.id,
            top: frame ? Math.max(0, rect.bottom - frame.top + 4) : 0,
            left: frame ? Math.max(0, rect.left - frame.left) : 0,
          });
        },
      }),
      placeholderText(t('writing.editor.placeholder')),
      draftTheme,
      EditorView.contentAttributes.of({ 'aria-label': t('writing.editor.aria') }),
      EditorView.updateListener.of(onUpdate),
    ];
    const view = new EditorView({ parent: host, state: EditorState.create({ doc: draft.markdown, extensions }) });
    viewRef.current = view;
    return () => {
      // Leaving the studio saves what was typed.
      void flush();
      viewRef.current = null;
      view.destroy();
    };
    // The editor is built once; later props arrive through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The draft changed outside the editor (a save came back, the assistant
  // wrote, a block was unpinned).
  const previewLabel = t('writing.editor.writing');
  const lastPreviewStart = useRef<string | null>(null);
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const s = sync.current;
    const doc = view.state.doc.toString();
    if (preview) {
      // Typing not yet saved wins; the preview waits for the next update.
      if (!s.previewing && (doc !== s.lastSynced || s.inflight != null || s.timer != null)) return;
      s.previewing = true;
      s.lastSynced = draft.markdown;
      const change = minimalChange(doc, preview.markdown);
      // The draft's blocks, moved onto the preview text.
      const fromDraft = minimalChange(draft.markdown, preview.markdown);
      const blocks = toEditorBlocks(draft.blocks, draft.markdown.length);
      view.dispatch({
        changes: change ?? undefined,
        effects: [
          setBlocksEffect.of(fromDraft ? mapBlocks(blocks, ChangeSet.of(fromDraft, draft.markdown.length)) : blocks),
          setPreviewEffect.of({ ranges: preview.ranges, label: previewLabel }),
        ],
        annotations: externalSync.of(true),
      });
      // Bring a section that has just started into view.
      const newest = preview.ranges[preview.ranges.length - 1];
      if (newest && newest.toolCallId !== lastPreviewStart.current) {
        lastPreviewStart.current = newest.toolCallId;
        view.dispatch({ effects: EditorView.scrollIntoView(Math.min(newest.from, view.state.doc.length), { y: 'nearest' }) });
      }
      return;
    }
    if (s.previewing) {
      s.previewing = false;
      lastPreviewStart.current = null;
      s.lastSynced = draft.markdown;
      view.dispatch({ effects: setPreviewEffect.of(null) });
      applyExternal(draft.markdown, draft.blocks);
      return;
    }
    if (draft.markdown === doc) {
      s.lastSynced = doc;
      view.dispatch({ effects: setBlocksEffect.of(toEditorBlocks(draft.blocks, doc.length)) });
      return;
    }
    // Unsaved typing wins until it is saved; the save reply reconciles.
    const dirty = doc !== s.lastSynced || s.inflight != null || s.timer != null;
    if (dirty) return;
    s.lastSynced = draft.markdown;
    applyExternal(draft.markdown, draft.blocks);
  }, [draft.markdown, draft.blocks, preview, previewLabel, applyExternal]);

  // A restore: drop unsaved typing and take the draft as it is.
  const lastReset = useRef(resetToken);
  useEffect(() => {
    if (resetToken === lastReset.current) return;
    lastReset.current = resetToken;
    const s = sync.current;
    s.generation += 1;
    if (s.timer != null) clearTimeout(s.timer);
    s.timer = null;
    s.inflight = null;
    s.queued = false;
    s.lastSynced = draft.markdown;
    applyExternal(draft.markdown, draft.blocks);
    setSaveState('saved');
  }, [resetToken, draft.markdown, draft.blocks, applyExternal]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: tint.current.reconfigure(showAiText ? aiTint : []) });
  }, [showAiText]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editable.current.reconfigure([EditorView.editable.of(!readOnly), EditorState.readOnly.of(readOnly)]),
    });
    if (readOnly) {
      // The assistant is about to read the draft: save what was typed first.
      void flush();
      setSelection(null);
      setPinPopover(null);
    }
  }, [readOnly, flush]);

  const sendSelection = async (action: SelectionAction, instruction?: string) => {
    setSelection(null);
    // Save first, so the request names blocks the backend knows.
    await flush();
    const view = viewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    const blocks = blocksInRange(view.state.field(blocksField), sel.from, sel.to);
    callbacks.current.onSelectionRequest({
      action,
      instruction,
      blockIds: blocks.map((b) => b.id),
      pinnedIds: pinnedIn(blocks),
      text: view.state.sliceDoc(sel.from, sel.to),
    });
    // The request is sent: drop the selection, or the bar comes back over the
    // rewritten text when the editor turns editable again after the turn.
    view.dispatch({ selection: { anchor: sel.to } });
  };

  const unpin = (blockId: string) => {
    setPinPopover(null);
    callbacks.current.onUnpin(blockId);
  };

  const status =
    saveState === 'error'
      ? t('writing.editor.saveFailed')
      : saveState === 'saving' || saveState === 'pending'
        ? t('writing.editor.saving')
        : t('writing.editor.saved');

  return (
    <div className="draft-editor" data-readonly={readOnly ? 'true' : undefined}>
      {readOnly && (
        <p className="draft-editor-busy" role="status">
          {t('writing.editor.busy')}
        </p>
      )}
      <div ref={frameRef} className="draft-editor-frame">
        <div ref={hostRef} className="draft-editor-surface" />
        {selection && !readOnly && (
          <SelectionToolbar
            position={{ top: selection.top, left: selection.left }}
            touchesPinned={selection.pinned}
            onAction={(action, instruction) => void sendSelection(action, instruction)}
            onDismiss={() => {
              dismissedRef.current = `${selection.from}-${selection.to}`;
              setSelection(null);
              viewRef.current?.focus();
            }}
          />
        )}
        {pinPopover && !readOnly && (
          <div
            className="draft-pin-popover"
            role="dialog"
            aria-label={t('writing.pin.tooltip')}
            style={{ top: pinPopover.top, left: pinPopover.left }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setPinPopover(null);
              }
            }}
          >
            <p className="draft-pin-popover-text">{t('writing.pin.tooltip')}</p>
            <button type="button" className="btn" autoFocus onClick={() => unpin(pinPopover.blockId)}>
              {t('writing.pin.release')}
            </button>
          </div>
        )}
      </div>
      <div className="draft-editor-foot">
        {caretPinned && !readOnly ? (
          <span className="draft-editor-pinned">
            <span className="draft-editor-pinned-text">{t('writing.pin.tooltip')}</span>
            <button type="button" className="draft-editor-release" onClick={() => unpin(caretPinned)}>
              {t('writing.pin.release')}
            </button>
          </span>
        ) : (
          <span className="draft-editor-hint">{t('writing.editor.hint')}</span>
        )}
        <span className="draft-editor-save" data-state={saveState} aria-live="polite">
          {status}
        </span>
      </div>
    </div>
  );
}
