-- Starter apps: ready-made apps bundled with Conduit (src/starter_apps.rs).
-- Adding one copies its page into `apps` like any other app; `starter_id`
-- remembers which starter it came from, so the Ideas card and the Apps page
-- open the copy the user already has instead of adding a second one.

ALTER TABLE apps ADD COLUMN starter_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_starter ON apps(starter_id) WHERE starter_id IS NOT NULL;
