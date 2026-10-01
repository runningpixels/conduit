-- Slides (phase 1). theme_css, storyline_json, deck_slides.html, deck_slides.notes and
-- deck_snapshots.payload are encrypted like artifact content.
CREATE TABLE IF NOT EXISTS decks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  theme_name      TEXT NOT NULL,
  theme_css       TEXT NOT NULL,
  stage           TEXT NOT NULL DEFAULT 'storyline',  -- 'storyline' | 'slides'
  storyline_json  TEXT NOT NULL,                       -- [{"id","text"}]
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_opened_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_decks_conversation ON decks(conversation_id);
CREATE TABLE IF NOT EXISTS deck_slides (
  id         TEXT PRIMARY KEY,
  deck_id    TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  layout     TEXT NOT NULL,
  html       TEXT NOT NULL,
  notes      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deck_slides_deck ON deck_slides(deck_id, position);
CREATE TABLE IF NOT EXISTS deck_snapshots (
  id           TEXT PRIMARY KEY,
  deck_id      TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  cause        TEXT NOT NULL,   -- 'created' | 'ai-turn' | 'manual' | 'restore'
  label        TEXT NOT NULL,
  payload      TEXT NOT NULL,   -- JSON DeckState
  payload_hash TEXT NOT NULL,   -- sha256 of plaintext payload
  slide_count  INTEGER NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deck_snapshots_deck ON deck_snapshots(deck_id, created_at);
