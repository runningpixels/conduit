/// The chat message a selection-toolbar action sends. The model reads which
/// blocks (by id) the selection covers, the selected text and what to do with
/// it; the thread shows a one-line note instead (see chat/appPrompt.ts).
///
/// A selection inside the user's own (pinned) text is the user asking to
/// change that text, so the message names those blocks for `release_pinned`.

import { appPrompt } from '../chat/appPrompt';
import type { Translate } from '../i18n';

export type SelectionAction = 'rewrite' | 'shorter' | 'longer' | 'clearer' | 'grammar' | 'ask';

export const SELECTION_ACTIONS: readonly SelectionAction[] = ['rewrite', 'shorter', 'longer', 'clearer', 'grammar', 'ask'];

/** Catalog ids per action: the toolbar button, the model instruction and the thread note. */
export const SELECTION_ACTION_IDS: Record<SelectionAction, { label: string; instruction: string; note: string }> = {
  rewrite: {
    label: 'writing.selection.action.rewrite',
    instruction: 'writing.selection.instruction.rewrite',
    note: 'writing.selection.note.rewrite',
  },
  shorter: {
    label: 'writing.selection.action.shorter',
    instruction: 'writing.selection.instruction.shorter',
    note: 'writing.selection.note.shorter',
  },
  longer: {
    label: 'writing.selection.action.longer',
    instruction: 'writing.selection.instruction.longer',
    note: 'writing.selection.note.longer',
  },
  clearer: {
    label: 'writing.selection.action.clearer',
    instruction: 'writing.selection.instruction.clearer',
    note: 'writing.selection.note.clearer',
  },
  grammar: {
    label: 'writing.selection.action.grammar',
    instruction: 'writing.selection.instruction.grammar',
    note: 'writing.selection.note.grammar',
  },
  // Ask…: the instruction and the note are what the user typed.
  ask: { label: 'writing.selection.action.ask', instruction: '', note: '' },
};

export interface SelectionRequest {
  action: SelectionAction;
  /** What the user typed for Ask… */
  instruction?: string;
  /** Every block the selection touches, in document order. */
  blockIds: string[];
  /** The subset of `blockIds` that is the user's pinned text. */
  pinnedIds: string[];
  text: string;
}

/** Longest selection quoted in the thread's one-line note. */
const NOTE_QUOTE_CHARS = 48;

function quoteForNote(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > NOTE_QUOTE_CHARS ? `${flat.slice(0, NOTE_QUOTE_CHARS - 1)}…` : flat;
}

/** The model-facing text of the request. */
export function selectionPromptText(t: Translate, request: SelectionRequest): string {
  const instruction =
    request.action === 'ask'
      ? (request.instruction ?? '').trim()
      : t(SELECTION_ACTION_IDS[request.action].instruction);
  const lines = [
    instruction,
    '',
    t('writing.selection.prompt.blocks', { ids: request.blockIds.join(', ') }),
    t('writing.selection.prompt.text'),
    '"""',
    request.text,
    '"""',
  ];
  if (request.pinnedIds.length > 0) {
    lines.push('', t('writing.selection.prompt.pinned', { ids: request.pinnedIds.join(', ') }));
    lines.push(`release_pinned: [${request.pinnedIds.map((id) => JSON.stringify(id)).join(', ')}]`);
  }
  lines.push('', t('writing.selection.prompt.scope'));
  return lines.join('\n');
}

/** The full message: a short note for the thread, then the request for the model. */
export function selectionMessage(t: Translate, request: SelectionRequest): string {
  const quote = quoteForNote(request.text);
  const label =
    request.action === 'ask'
      ? quoteForNote(request.instruction ?? '')
      : t(SELECTION_ACTION_IDS[request.action].note, { quote });
  return appPrompt(label, selectionPromptText(t, request));
}
