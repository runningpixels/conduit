-- Migration 0011: per-conversation generation controls + user instructions (t0-6).
-- JSON GenerationControls bundle and encrypted-at-rest user instructions text.
-- NULL on either column = inherit AppSettings defaults.

ALTER TABLE conversations ADD COLUMN generation_controls TEXT;
ALTER TABLE conversations ADD COLUMN user_instructions TEXT;
