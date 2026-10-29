-- Projects: a folder's settings, used by every chat in it. A folder with no
-- rows here behaves exactly as a plain folder. Settings are read at send time
-- from the chat's folder, never copied into chats, so editing a project or
-- moving a chat in or out takes effect on the next message.
-- user_instructions is encrypted at rest like conversations.user_instructions.

CREATE TABLE IF NOT EXISTS project_settings (
  folder_id         TEXT PRIMARY KEY,
  user_instructions TEXT,
  workspace_root    TEXT,
  updated_at        TEXT NOT NULL,
  FOREIGN KEY (folder_id) REFERENCES conversation_folders(id) ON DELETE CASCADE
);

-- Same shape as conversation_skills / conversation_collections: a row means "on".
CREATE TABLE IF NOT EXISTS project_skills (
  folder_id TEXT NOT NULL,
  skill_id  TEXT NOT NULL,
  PRIMARY KEY (folder_id, skill_id),
  FOREIGN KEY (folder_id) REFERENCES conversation_folders(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS project_collections (
  folder_id     TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  PRIMARY KEY (folder_id, collection_id),
  FOREIGN KEY (folder_id) REFERENCES conversation_folders(id) ON DELETE CASCADE,
  FOREIGN KEY (collection_id) REFERENCES knowledge_collections(id) ON DELETE CASCADE
);
