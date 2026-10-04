-- Writing: what a draft may draw on besides its chat's document collections.
-- JSON {"webSearch": bool, "researchRunIds": [string]}: local web search in the
-- draft's turns, and the Research runs whose verified facts it writes from.
-- Ids and a flag only, so not encrypted.
ALTER TABLE drafts ADD COLUMN sources_json TEXT NOT NULL DEFAULT '{}';
