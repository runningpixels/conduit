/// The section the assistant is writing right now, marked in the editor:
/// dimmed text and a small "Writing…" label at its start. The ranges come
/// from `buildDraftPreview` and are replaced on every preview update.

import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';

export interface PreviewMarks {
  ranges: ReadonlyArray<{ from: number; to: number }>;
  /** The label shown at each range's start ("Writing…"). */
  label: string;
}

/** Replace the preview marks; null clears them. */
export const setPreviewEffect = StateEffect.define<PreviewMarks | null>();

class WritingLabel extends WidgetType {
  constructor(readonly label: string) {
    super();
  }

  eq(other: WritingLabel): boolean {
    return other.label === this.label;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'draft-preview-label';
    el.textContent = this.label;
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const previewMark = Decoration.mark({ class: 'draft-preview', attributes: { 'data-preview': 'true' } });

function build(marks: PreviewMarks, length: number): DecorationSet {
  const decos = [];
  for (const range of marks.ranges) {
    const from = Math.max(0, Math.min(length, range.from));
    const to = Math.max(from, Math.min(length, range.to));
    decos.push(Decoration.widget({ widget: new WritingLabel(marks.label), side: -1 }).range(from));
    if (to > from) decos.push(previewMark.range(from, to));
  }
  return Decoration.set(decos, true);
}

export const previewField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    let next = tr.docChanged ? deco.map(tr.changes) : deco;
    for (const effect of tr.effects) {
      if (effect.is(setPreviewEffect)) {
        next = effect.value ? build(effect.value, tr.state.doc.length) : Decoration.none;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
