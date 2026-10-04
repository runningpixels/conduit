/// The draft's block sidecar inside CodeMirror: block ranges kept in editor
/// state and mapped through every edit, so the pinned-block gutter, the
/// AI-text tint and the selection toolbar stay on the right text between a
/// keystroke and the next save. Each save (or an AI change) replaces them
/// with the backend's own split.

import { RangeSetBuilder, StateEffect, StateField, Annotation, type ChangeDesc, type EditorState, type Extension } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, gutter, type DecorationSet } from '@codemirror/view';
import type { BlockOwner, DraftBlock } from '../ipc/contracts';

export interface EditorBlock {
  id: string;
  kind: string;
  owner: BlockOwner;
  pinned: boolean;
  from: number;
  to: number;
}

/** Replace the block ranges (a save came back, or the draft changed elsewhere). */
export const setBlocksEffect = StateEffect.define<EditorBlock[]>();

/** Marks a transaction that brings in the backend's text rather than a keystroke. */
export const externalSync = Annotation.define<boolean>();

/** Backend blocks (UTF-16 offsets, which are CodeMirror positions) as editor ranges, clamped to the text. */
export function toEditorBlocks(blocks: readonly DraftBlock[], length: number): EditorBlock[] {
  return blocks
    .map((b) => {
      const from = Math.max(0, Math.min(length, b.start));
      const to = Math.max(from, Math.min(length, b.end));
      return { id: b.id, kind: b.kind, owner: b.owner, pinned: b.pinned, from, to };
    })
    .sort((a, b) => a.from - b.from);
}

/** Text typed at either edge of a block belongs to that block. */
export function mapBlocks(blocks: readonly EditorBlock[], changes: ChangeDesc): EditorBlock[] {
  return blocks.map((b) => {
    const from = changes.mapPos(b.from, -1);
    const to = Math.max(from, changes.mapPos(b.to, 1));
    return { ...b, from, to };
  });
}

export const blocksField = StateField.define<EditorBlock[]>({
  create: () => [],
  update(blocks, tr) {
    for (const effect of tr.effects) if (effect.is(setBlocksEffect)) return effect.value;
    return tr.docChanged ? mapBlocks(blocks, tr.changes) : blocks;
  },
});

/** Blocks a selection touches; for a caret, the block it sits in. */
export function blocksInRange(blocks: readonly EditorBlock[], from: number, to: number): EditorBlock[] {
  if (from === to) return blocks.filter((b) => b.from <= from && from <= b.to);
  return blocks.filter((b) => b.from < to && b.to > from);
}

/** The one change that turns `before` into `after`: common prefix and suffix kept, so a caret outside it does not move. */
export function minimalChange(before: string, after: string): { from: number; to: number; insert: string } | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore -= 1;
    endAfter -= 1;
  }
  return { from: start, to: endBefore, insert: after.slice(start, endAfter) };
}

/** Line starts covered by each block that passes `keep`, in document order. */
function lineStarts(state: EditorState, keep: (b: EditorBlock) => boolean): Map<number, EditorBlock> {
  const out = new Map<number, EditorBlock>();
  const doc = state.doc;
  for (const block of state.field(blocksField)) {
    if (!keep(block) || block.to <= block.from) continue;
    let line = doc.lineAt(block.from);
    for (;;) {
      if (!out.has(line.from)) out.set(line.from, block);
      if (line.to >= block.to || line.number >= doc.lines) break;
      line = doc.line(line.number + 1);
    }
  }
  return new Map([...out.entries()].sort((a, b) => a[0] - b[0]));
}

const aiLine = Decoration.line({ class: 'draft-line-ai' });
const codeLine = Decoration.line({ class: 'draft-line-code' });

function lineDecorations(state: EditorState, keep: (b: EditorBlock) => boolean, deco: Decoration): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const from of lineStarts(state, keep).keys()) builder.add(from, from, deco);
  return builder.finish();
}

/** Code blocks read in the monospace face; the rest of the draft is prose. */
export const codeBlockLines: Extension = EditorView.decorations.compute([blocksField, 'doc'], (state) =>
  lineDecorations(state, (b) => b.kind === 'code', codeLine),
);

/** A faint tint on text the AI wrote and nobody has edited ("Show AI-written text"). */
export const aiTint: Extension = EditorView.decorations.compute([blocksField, 'doc'], (state) =>
  lineDecorations(state, (b) => b.owner === 'ai', aiLine),
);

class PinMarker extends GutterMarker {
  constructor(
    readonly blockId: string,
    readonly first: boolean,
    readonly title: string,
  ) {
    super();
  }

  eq(other: PinMarker): boolean {
    return other.blockId === this.blockId && other.first === this.first && other.title === this.title;
  }

  toDOM(): Node {
    const el = document.createElement('span');
    el.className = this.first ? 'draft-pin draft-pin-first' : 'draft-pin';
    el.title = this.title;
    el.dataset.block = this.blockId;
    return el;
  }
}

export interface PinGutterOptions {
  /** The marker's tooltip ("You wrote this. The AI keeps it."). */
  title: string;
  /** A pinned block's marker was clicked; `rect` is the marker's line in viewport pixels. */
  onPinClick: (block: EditorBlock, rect: { top: number; left: number; bottom: number }) => void;
}

/** A bar beside every line of a pinned block; its first line carries the pin. */
export function pinGutter({ title, onPinClick }: PinGutterOptions): Extension {
  return gutter({
    class: 'draft-pin-gutter',
    markers: (view) => {
      const builder = new RangeSetBuilder<GutterMarker>();
      for (const [from, block] of lineStarts(view.state, (b) => b.pinned)) {
        builder.add(from, from, new PinMarker(block.id, from <= block.from, title));
      }
      return builder.finish();
    },
    // Pins change without a text change (a save came back, Let AI edit).
    lineMarkerChange: (update) => update.startState.field(blocksField) !== update.state.field(blocksField),
    initialSpacer: () => new PinMarker('', true, title),
    domEventHandlers: {
      mousedown(view, line, event) {
        const target = event.target as HTMLElement | null;
        // The marker names its block; a click beside it goes by the line.
        const markerId = target?.closest?.<HTMLElement>('[data-block]')?.dataset.block;
        const blocks = view.state.field(blocksField);
        const block =
          blocks.find((b) => b.pinned && markerId != null && b.id === markerId) ??
          blocks.find((b) => b.pinned && b.from <= line.to && line.from <= b.to);
        if (!block) return false;
        const box = target?.getBoundingClientRect?.();
        onPinClick(block, { top: box?.top ?? 0, left: box?.left ?? 0, bottom: box?.bottom ?? 0 });
        return true;
      },
    },
  });
}

/** For tests and callers that only need the ranges. */
export function pinnedLineStarts(state: EditorState): number[] {
  return [...lineStarts(state, (b) => b.pinned).keys()];
}
