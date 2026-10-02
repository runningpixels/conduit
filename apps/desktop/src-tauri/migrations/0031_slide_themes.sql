-- Slides: themes the user or the model made, kept so they can be picked again
-- (in any deck) after the deck moves to another theme. The built-in themes are
-- not stored here. css is encrypted like artifact content.
CREATE TABLE IF NOT EXISTS slide_themes (
  name       TEXT PRIMARY KEY COLLATE NOCASE,
  css        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
