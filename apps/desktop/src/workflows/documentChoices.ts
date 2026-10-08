/// Which decks and drafts an "Update a deck / draft" step may point at, and
/// what the card says about the one it points at now.

import type { DeckSummary, DraftSummary } from '../ipc/contracts';

/// Only a deck past its storyline can be edited slide by slide.
export function deckChoices(decks: readonly DeckSummary[]): DeckSummary[] {
  return decks.filter((deck) => deck.stage === 'slides');
}

/// Only a draft past its outline has text to change.
export function draftChoices(drafts: readonly DraftSummary[]): DraftSummary[] {
  return drafts.filter((draft) => draft.stage === 'draft');
}

/// `unset`: nothing picked yet. `deleted`: the id is gone from the list.
/// `notReady`: it exists but is still an outline. `ok`: pickable.
export type TargetState = 'unset' | 'deleted' | 'notReady' | 'ok';

export function targetState(
  id: string,
  all: readonly { id: string }[],
  ready: readonly { id: string }[],
): TargetState {
  if (id.trim() === '') return 'unset';
  if (ready.some((item) => item.id === id)) return 'ok';
  return all.some((item) => item.id === id) ? 'notReady' : 'deleted';
}
