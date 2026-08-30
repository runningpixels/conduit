-- Migration 0010: per-conversation workspace folder binding (01c UX).
-- Absolute path to the sandbox root for this chat; NULL = inherit settings default / unbound.

ALTER TABLE conversations ADD COLUMN workspace_root TEXT;
