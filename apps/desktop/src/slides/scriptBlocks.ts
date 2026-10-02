/// How a slide's slots read as a document. Pure: the Script panel styles its
/// blocks from this and `deckToMarkdown` writes the same structure out as text,
/// so the two never disagree about what a slot is.

import type { SlideSlot } from '../ipc/contracts';

export type BlockKind = 'kicker' | 'heading' | 'bullet' | 'figure' | 'quote' | 'cite' | 'footnote' | 'paragraph';

/** A bold figure is short ("42%", "$1.2M"); longer bold text is just a sentence. */
const SHORT_FIGURE_CHARS = 16;

const hasClass = (slot: SlideSlot, cls: string) => (slot.classes ?? []).includes(cls);

/** First match wins. */
export function classifySlot(slot: SlideSlot): BlockKind {
  const tag = (slot.tag ?? '').toLowerCase();
  if (hasClass(slot, 'kicker')) return 'kicker';
  if (hasClass(slot, 'headline') || tag === 'h1' || tag === 'h2') return 'heading';
  if (tag === 'li') return 'bullet';
  if (hasClass(slot, 'stat')) return 'figure';
  if ((tag === 'b' || tag === 'strong') && slot.text.trim().length <= SHORT_FIGURE_CHARS) return 'figure';
  if (hasClass(slot, 'quote') || tag === 'blockquote') return 'quote';
  if (hasClass(slot, 'cite')) return 'cite';
  if (hasClass(slot, 'footnote')) return 'footnote';
  return 'paragraph';
}

export type ScriptItem =
  | { type: 'block'; kind: Exclude<BlockKind, 'bullet' | 'figure'>; slot: SlideSlot }
  | { type: 'list'; slots: SlideSlot[] }
  | { type: 'figure'; value: SlideSlot; caption: SlideSlot | null };

const isCaption = (slot: SlideSlot) =>
  classifySlot(slot) === 'paragraph' && (hasClass(slot, 'label') || (slot.tag ?? '').toLowerCase() === 'span');

/** Consecutive bullets form one list; a figure takes a following label as its caption. */
export function groupSlots(slots: readonly SlideSlot[]): ScriptItem[] {
  const items: ScriptItem[] = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const kind = classifySlot(slot);
    if (kind === 'bullet') {
      const last = items[items.length - 1];
      if (last?.type === 'list') last.slots.push(slot);
      else items.push({ type: 'list', slots: [slot] });
    } else if (kind === 'figure') {
      const next = slots[i + 1];
      if (next && isCaption(next)) {
        items.push({ type: 'figure', value: slot, caption: next });
        i++;
      } else {
        items.push({ type: 'figure', value: slot, caption: null });
      }
    } else {
      items.push({ type: 'block', kind, slot });
    }
  }
  return items;
}
