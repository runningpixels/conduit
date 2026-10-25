-- Connector tools the user has marked as only reading. A tool that doesn't
-- say whether it changes things asks first; a mark here lets it run without
-- asking. Keyed by connector (not version) so a mark survives updates. Marks
-- never override what a tool declares itself.
CREATE TABLE IF NOT EXISTS connector_tool_read_only (
  connector_id  TEXT NOT NULL,
  tool_name     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (connector_id, tool_name),
  FOREIGN KEY (connector_id) REFERENCES connector_definitions(id) ON DELETE CASCADE
);
