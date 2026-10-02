-- Slides Studio: a deck's chat lives in Slides, not in the Chats list.
-- assumptions: what the model assumed about audience/goal/length when the user
-- did not say; encrypted when non-empty ('' stays '').
ALTER TABLE decks ADD COLUMN assumptions TEXT NOT NULL DEFAULT '';

UPDATE conversations SET kind = 'deck'
  WHERE id IN (SELECT conversation_id FROM decks WHERE conversation_id IS NOT NULL);
