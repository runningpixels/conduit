-- The first-run examples a profile was given (see `first_run_examples`): an
-- app, chats, a deck and a workflow, each listed here by kind and id so the
-- interface can mark them "Example" and "Remove all examples" can find them.
-- Deleting an example the usual way leaves its row behind; rows whose item is
-- gone are ignored and cleared by the next "Remove all examples".
CREATE TABLE IF NOT EXISTS example_items (
  kind       TEXT NOT NULL,             -- app | chat | deck | workflow
  item_id    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (kind, item_id)
);
