/// What Home's "Make something new" tiles make, in the order they show.
/// Copy lives under `home.make.<kind>.*`: the tile's name and hint, the ask
/// box's placeholder once the tile is picked, and (for the kinds a chat makes)
/// the lead-in the request is sent with, so the model knows what to make in
/// whatever language the user writes.

export const MAKE_KINDS = ['page', 'app', 'deck', 'document', 'sheet', 'image'] as const;
export type MakeKind = (typeof MAKE_KINDS)[number];

/** Kinds made in a chat, sent with a lead-in; a deck and a document have their own studios. */
export function madeInChat(kind: MakeKind): boolean {
  return kind !== 'deck' && kind !== 'document';
}
